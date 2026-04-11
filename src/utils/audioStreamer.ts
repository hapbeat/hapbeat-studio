/**
 * Audio streamer — sends audio data to Hapbeat device via Manager WebSocket.
 *
 * Flow: Studio → WebSocket (JSON+base64) → Manager → UDP (binary) → Device
 *
 * Manager uses command codes 0x30/0x31/0x32 for STREAM_BEGIN/DATA/END.
 * Default: PCM16 format (format=0), 512-sample chunks, paced at real-time.
 */

import type { ManagerMessage } from '@/types/manager'

/** Chunk size in samples (matching Manager's 512-sample chunks) */
const CHUNK_SAMPLES = 512

export interface StreamOptions {
  /** Target sample rate (default: 16000) */
  sampleRate?: number
  /** Intensity multiplier applied to PCM data before sending (default: 1.0) */
  intensity?: number
  /** Abort signal */
  signal?: AbortSignal
}

/**
 * Stream audio to a Hapbeat device via Manager WebSocket.
 */
export async function streamClipToDevice(
  audioBlob: Blob,
  targetDevice: string,
  send: (msg: ManagerMessage) => void,
  options?: StreamOptions,
): Promise<void> {
  const signal = options?.signal
  const targetRate = options?.sampleRate ?? 16000
  const intensity = options?.intensity ?? 1.0

  // Decode audio blob
  const arrayBuffer = await audioBlob.arrayBuffer()
  const ctx = new OfflineAudioContext(1, 1, 44100)
  const decoded = await ctx.decodeAudioData(arrayBuffer)

  // Resample to target rate, mono
  const resampled = await resampleToMono(decoded, targetRate)
  const pcm16 = audioBufferToPcm16Mono(resampled)

  // Apply intensity to PCM data
  if (intensity !== 1.0) {
    for (let i = 0; i < pcm16.length; i++) {
      let val = Math.round(pcm16[i] * intensity)
      if (val > 32767) val = 32767
      if (val < -32768) val = -32768
      pcm16[i] = val
    }
  }

  const totalSamples = pcm16.length

  // Send STREAM_BEGIN
  send({
    type: 'stream_begin',
    payload: {
      target: targetDevice,
      sample_rate: targetRate,
      channels: 1,
      format: 'pcm16',
      total_samples: totalSamples,
    },
  })

  // Calculate real-time pacing delay per chunk
  const chunkDurationMs = (CHUNK_SAMPLES / targetRate) * 1000
  const startTime = performance.now()

  // Send data in chunks (PCM16 = 2 bytes per sample)
  for (let sampleOffset = 0; sampleOffset < totalSamples; sampleOffset += CHUNK_SAMPLES) {
    if (signal?.aborted) {
      send({ type: 'stream_end', payload: { target: targetDevice } })
      throw new DOMException('Streaming aborted', 'AbortError')
    }

    const end = Math.min(sampleOffset + CHUNK_SAMPLES, totalSamples)
    const chunk = pcm16.slice(sampleOffset, end)

    // Convert Int16Array to bytes
    const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    const base64 = uint8ArrayToBase64(bytes)

    const byteOffset = sampleOffset * 2 // 2 bytes per sample
    send({
      type: 'stream_data',
      payload: {
        target: targetDevice,
        offset: byteOffset,
        data: base64,
      },
    })

    // Pace to real-time: wait until the wall-clock time matches the audio position
    const chunkIndex = sampleOffset / CHUNK_SAMPLES
    const expectedTime = startTime + (chunkIndex + 1) * chunkDurationMs
    const now = performance.now()
    if (expectedTime > now) {
      await delay(expectedTime - now)
    }
  }

  // Send STREAM_END
  send({ type: 'stream_end', payload: { target: targetDevice } })
}

// ---- Helpers ----

function audioBufferToPcm16Mono(buffer: AudioBuffer): Int16Array {
  const data = buffer.getChannelData(0)
  const pcm = new Int16Array(data.length)
  for (let i = 0; i < data.length; i++) {
    let val = Math.round(data[i] * 32767)
    if (val > 32767) val = 32767
    if (val < -32768) val = -32768
    pcm[i] = val
  }
  return pcm
}

async function resampleToMono(buffer: AudioBuffer, targetRate: number): Promise<AudioBuffer> {
  const length = Math.ceil(buffer.length * targetRate / buffer.sampleRate)
  const offCtx = new OfflineAudioContext(1, length, targetRate)
  const src = offCtx.createBufferSource()
  src.buffer = buffer
  src.connect(offCtx.destination)
  src.start()
  return offCtx.startRendering()
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
