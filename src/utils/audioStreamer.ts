/**
 * Audio streamer — sends audio data to Hapbeat device(s) via Manager WebSocket.
 *
 * Flow: Studio → WebSocket (JSON+base64) → Manager → UDP (binary) → Device(s)
 *
 * Studio does NOT specify target. Manager resolves destinations from its own
 * "selected device" state. This means the user's device selection in Manager
 * drives playback routing; Studio just supplies audio + metadata.
 *
 * Manager uses command codes 0x30/0x31/0x32 for STREAM_BEGIN/DATA/END.
 * Default: PCM16 format (format=0), 512-sample chunks, paced at real-time.
 */

import type { ManagerMessage } from '@/types/manager'

/** UDP payload は firmware の RX バッファ (MTU 1500B) を超えないよう制限する。
 *  frame_size (channels × 2B) で割って 1 チャンクあたりの frames を決める:
 *    mono  (2B/frame) → 512 frames
 *    stereo (4B/frame) → 256 frames
 *  Manager 側 (main_window.py の file streamer) と同じポリシー。 */
const MAX_PAYLOAD_BYTES = 1024

/**
 * Live control surface for an in-flight stream. All hooks are pulled
 * once per chunk so React state can drive pause / seek / intensity /
 * progress without rebuilding the streamer.
 */
export interface StreamControl {
  /** Returns true while the user wants the stream paused. The streamer
   *  busy-waits in 50 ms increments until this flips back to false. */
  isPaused?: () => boolean
  /** Returns a 0..1 fractional position when the user just released the
   *  seek bar, then null on subsequent calls. The streamer consumes the
   *  request, jumps the read offset, and re-anchors pacing. */
  consumeSeek?: () => number | null
  /** Live intensity multiplier (typically 0..2). Read each chunk and
   *  applied before send, so a slider above the player can boost or
   *  cut the haptic level mid-stream. When absent, falls back to the
   *  static `intensity` option (frozen at start). */
  getIntensity?: () => number
  /** Called after every chunk send with the current read position. */
  onProgress?: (currentFrames: number, totalFrames: number, sampleRate: number) => void
}

export interface StreamOptions {
  /** Target sample rate (default: 16000) */
  sampleRate?: number
  /** Intensity multiplier applied to PCM data before sending (default: 1.0) */
  intensity?: number
  /** Abort signal */
  signal?: AbortSignal
  /** Pause / seek / progress hooks */
  control?: StreamControl
}

/**
 * Stream audio via Manager WebSocket. Manager decides the routing destination.
 */
export async function streamClip(
  audioBlob: Blob,
  send: (msg: ManagerMessage) => void,
  options?: StreamOptions,
): Promise<void> {
  const signal = options?.signal
  const targetRate = options?.sampleRate ?? 16000
  const intensity = options?.intensity ?? 1.0
  const control = options?.control

  // Decode audio blob
  const arrayBuffer = await audioBlob.arrayBuffer()
  const ctx = new OfflineAudioContext(1, 1, 44100)
  const decoded = await ctx.decodeAudioData(arrayBuffer)

  // Resample to target rate, preserving original channel count
  const resampled = await resample(decoded, targetRate)
  const channels = resampled.numberOfChannels
  const pcm16 = audioBufferToPcm16Interleaved(resampled)

  // Intensity is applied per-chunk inside the loop so a live slider
  // can boost / cut the haptic level mid-stream. The static
  // `intensity` option is the fallback when the caller hasn't wired
  // a live `control.getIntensity` callback.

  const totalFrames = Math.floor(pcm16.length / channels)
  const frameSize = channels * 2 // PCM16
  const chunkFrames = Math.max(1, Math.floor(MAX_PAYLOAD_BYTES / frameSize))

  // Send STREAM_BEGIN (no target — Manager routes to its selected devices)
  send({
    type: 'stream_begin',
    payload: {
      sample_rate: targetRate,
      channels: channels,
      format: 'pcm16',
      total_samples: totalFrames,
    },
  })

  // Pacing anchors. We use a movable anchor so a pause-resume or
  // seek can re-zero the wall-clock vs. audio-position relationship
  // without drifting. After a seek to frame F, anchorFrame=F and
  // anchorTime=now, so subsequent expected times are
  //   anchorTime + (frameOffset - anchorFrame) / sampleRate * 1000.
  let anchorFrame = 0
  let anchorTime = performance.now()

  // Send data in chunks (PCM16 = 2 bytes per sample, interleaved when stereo)
  let frameOffset = 0
  while (frameOffset < totalFrames) {
    if (signal?.aborted) {
      send({ type: 'stream_end', payload: {} })
      throw new DOMException('Streaming aborted', 'AbortError')
    }

    // Pause: spin in 50 ms increments. On resume, re-anchor pacing so
    // the next chunk isn't dispatched as fast as possible to "catch up".
    if (control?.isPaused?.()) {
      while (control.isPaused?.() && !signal?.aborted) {
        await delay(50)
      }
      if (signal?.aborted) continue
      anchorFrame = frameOffset
      anchorTime = performance.now()
    }

    // Seek: consume the latest request, jump the read offset, re-anchor.
    const seek = control?.consumeSeek?.() ?? null
    if (seek != null) {
      const target = Math.max(0, Math.min(totalFrames - 1, Math.floor(totalFrames * seek)))
      frameOffset = target - (target % chunkFrames) // align to chunk grid
      anchorFrame = frameOffset
      anchorTime = performance.now()
      if (frameOffset >= totalFrames) break
    }

    const endFrame = Math.min(frameOffset + chunkFrames, totalFrames)
    const chunk = pcm16.slice(frameOffset * channels, endFrame * channels)

    // Apply current intensity per-chunk. `slice` already returned a
    // new buffer so this mutation doesn't affect the source pcm16.
    const liveIntensity = control?.getIntensity?.() ?? intensity
    if (liveIntensity !== 1.0) {
      for (let i = 0; i < chunk.length; i++) {
        let val = Math.round(chunk[i] * liveIntensity)
        if (val > 32767) val = 32767
        if (val < -32768) val = -32768
        chunk[i] = val
      }
    }

    // Convert Int16Array to bytes
    const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    const base64 = uint8ArrayToBase64(bytes)

    const byteOffset = frameOffset * channels * 2 // 2 bytes/sample × channels
    send({
      type: 'stream_data',
      payload: {
        offset: byteOffset,
        data: base64,
      },
    })

    frameOffset = endFrame
    control?.onProgress?.(frameOffset, totalFrames, targetRate)

    // Pace to real-time relative to the current anchor.
    const expectedTime = anchorTime + ((frameOffset - anchorFrame) / targetRate) * 1000
    const now = performance.now()
    if (expectedTime > now) {
      await delay(expectedTime - now)
    }
  }

  // Send STREAM_END
  send({ type: 'stream_end', payload: {} })
}

// ---- Helpers ----

function audioBufferToPcm16Interleaved(buffer: AudioBuffer): Int16Array {
  const channels = buffer.numberOfChannels
  const frames = buffer.length
  const pcm = new Int16Array(frames * channels)

  // getChannelData(ch) returns Float32Array for channel ch (planar).
  // Interleave: frame0_L, frame0_R, frame1_L, frame1_R, ...
  const channelData: Float32Array[] = []
  for (let c = 0; c < channels; c++) channelData.push(buffer.getChannelData(c))

  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channels; c++) {
      let val = Math.round(channelData[c][f] * 32767)
      if (val > 32767) val = 32767
      if (val < -32768) val = -32768
      pcm[f * channels + c] = val
    }
  }
  return pcm
}

async function resample(buffer: AudioBuffer, targetRate: number): Promise<AudioBuffer> {
  const length = Math.ceil(buffer.length * targetRate / buffer.sampleRate)
  const offCtx = new OfflineAudioContext(buffer.numberOfChannels, length, targetRate)
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
