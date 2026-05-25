import type { SampleRate } from '@/types/waveform'

// Shared AudioContext for decoding (created lazily)
let sharedAudioContext: AudioContext | null = null

function getAudioContext(): AudioContext {
  if (!sharedAudioContext) {
    sharedAudioContext = new AudioContext()
  }
  return sharedAudioContext
}

/**
 * Decode an audio file from ArrayBuffer using the browser's AudioContext.
 * Supports WAV (PCM), MP3, and other formats the browser can decode.
 */
export async function decodeAudioFile(arrayBuffer: ArrayBuffer): Promise<AudioBuffer> {
  const ctx = getAudioContext()
  return ctx.decodeAudioData(arrayBuffer.slice(0))
}

/** @deprecated Use decodeAudioFile instead */
export const decodeWavFile = decodeAudioFile

/**
 * Validate WAV constraints from hapbeat-contracts.
 */
export function validateWavForExport(
  buffer: AudioBuffer,
  sampleRate: SampleRate
): {
  valid: boolean
  warnings: string[]
  errors: string[]
  estimatedSizeBytes: number
} {
  const warnings: string[] = []
  const errors: string[] = []
  const estimatedSize = estimateWavSize(buffer.duration, sampleRate, buffer.numberOfChannels)

  if (estimatedSize > 1024 * 1024) {
    errors.push(`推定ファイルサイズ (${formatFileSize(estimatedSize)}) が 1MB を超えています`)
  }

  if (buffer.numberOfChannels > 2) {
    errors.push(`チャンネル数 ${buffer.numberOfChannels} は非対応です（モノラルまたはステレオのみ）`)
  }

  if (buffer.numberOfChannels === 2) {
    warnings.push('ステレオファイルです。デバイスでは左チャンネルのみ再生されます')
  }

  if (buffer.duration > 10) {
    warnings.push('クリップが 10 秒を超えています。短いクリップ（数百ms〜数秒）を推奨します')
  }

  const validRates: SampleRate[] = [16000, 24000, 44100]
  if (!validRates.includes(sampleRate)) {
    errors.push(`サンプルレート ${sampleRate} Hz は非対応です (16000 / 24000 / 44100 Hz)`)
  }

  return {
    valid: errors.length === 0,
    warnings,
    errors,
    estimatedSizeBytes: estimatedSize,
  }
}

/**
 * Encode AudioBuffer to PCM WAV Blob (16-bit).
 * Preserves channel count (mono or stereo).
 */
export async function encodeWavBlob(
  buffer: AudioBuffer,
  targetSampleRate: SampleRate
): Promise<Blob> {
  // Resample if needed
  let workBuffer = buffer
  if (buffer.sampleRate !== targetSampleRate) {
    workBuffer = await resampleBuffer(buffer, targetSampleRate)
  }

  const numChannels = workBuffer.numberOfChannels
  const int16Arrays: Int16Array[] = []

  for (let ch = 0; ch < numChannels; ch++) {
    int16Arrays.push(float32ToInt16(workBuffer.getChannelData(ch)))
  }

  const wavArrayBuffer = writeWavFile(int16Arrays, targetSampleRate, numChannels)
  return new Blob([wavArrayBuffer], { type: 'audio/wav' })
}

/**
 * Encode as **stereo** WAV at `targetSampleRate`, upmixing mono to
 * stereo by duplicating the single channel into both L and R (this
 * is the WHATWG / Web Audio default downmix in reverse: identical L/R
 * gives a centred image, no width inflation).
 *
 * Used by kitExporter for `stream-clips/` outputs — the SDK-side
 * streaming pipeline expects a fixed stereo 16 kHz format so the
 * receiver can dispatch each side to a separate haptic channel.
 * Channels beyond L/R (5.1 surround, etc.) are silently dropped to
 * the first two; this matches the firmware / SDK assumptions.
 */
export async function encodeStereoWavBlob(
  buffer: AudioBuffer,
  targetSampleRate: SampleRate,
): Promise<Blob> {
  let workBuffer = buffer
  if (buffer.sampleRate !== targetSampleRate) {
    workBuffer = await resampleBuffer(buffer, targetSampleRate)
  }

  let leftData: Float32Array
  let rightData: Float32Array
  if (workBuffer.numberOfChannels === 1) {
    const mono = workBuffer.getChannelData(0)
    leftData = mono
    rightData = mono
  } else {
    leftData = workBuffer.getChannelData(0)
    rightData = workBuffer.getChannelData(1)
  }

  const int16Left = float32ToInt16(leftData)
  const int16Right = float32ToInt16(rightData)
  const wavArrayBuffer = writeWavFile([int16Left, int16Right], targetSampleRate, 2)
  return new Blob([wavArrayBuffer], { type: 'audio/wav' })
}

/**
 * Encode as mono WAV, converting stereo to mono if needed.
 */
export async function encodeMonoWavBlob(
  buffer: AudioBuffer,
  targetSampleRate: SampleRate,
  method: 'average' | 'left' | 'right' = 'average'
): Promise<Blob> {
  let workBuffer = buffer
  if (buffer.sampleRate !== targetSampleRate) {
    workBuffer = await resampleBuffer(buffer, targetSampleRate)
  }

  let monoData: Float32Array
  if (workBuffer.numberOfChannels === 1) {
    monoData = workBuffer.getChannelData(0)
  } else {
    const left = workBuffer.getChannelData(0)
    const right = workBuffer.getChannelData(1)
    monoData = new Float32Array(workBuffer.length)
    switch (method) {
      case 'left':
        monoData.set(left)
        break
      case 'right':
        monoData.set(right)
        break
      case 'average':
        for (let i = 0; i < workBuffer.length; i++) {
          monoData[i] = (left[i] + right[i]) * 0.5
        }
        break
    }
  }

  const int16Data = float32ToInt16(monoData)
  const wavArrayBuffer = writeWavFile([int16Data], targetSampleRate, 1)
  return new Blob([wavArrayBuffer], { type: 'audio/wav' })
}

/**
 * Estimate WAV file size in bytes.
 */
export function estimateWavSize(
  durationSec: number,
  sampleRate: SampleRate,
  numChannels: number = 1
): number {
  // 44 bytes header + samples * 2 bytes (16-bit) * channels
  return 44 + Math.ceil(durationSec * sampleRate) * 2 * numChannels
}

/**
 * Format file size for display.
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

/**
 * Format duration for display (mm:ss.mmm).
 */
export function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${mins}:${secs.toFixed(3).padStart(6, '0')}`
}

/**
 * Lightweight WAV header parser.
 *
 * Reads enough of the file to identify format / sample rate / channel
 * count / bit depth / data chunk size — no decode, no AudioContext.
 * Used by kitExporter to detect when a source blob is **already** in
 * the device target format (16 kHz PCM16) and can be passed through
 * to disk verbatim, instead of going through decode → re-encode and
 * accumulating float ⇄ int16 round-trip error.
 *
 * Returns `null` for non-WAV blobs, non-PCM WAVs we don't recognise,
 * or malformed headers — caller falls back to the standard decode +
 * encode path.
 */
export interface WavInfo {
  /** WAV format tag from the fmt chunk. 1 = PCM, 3 = IEEE float. We
   *  only treat 1 as pass-through-eligible. */
  formatTag: number
  channels: number
  sampleRate: number
  bitsPerSample: number
  /** Raw byte count of the data chunk (= samples * channels * bytesPerSample). */
  dataBytes: number
  /** Audio duration in seconds, derived from dataBytes + format. */
  duration: number
}

export async function parseWavInfo(blob: Blob): Promise<WavInfo | null> {
  try {
    // Read up to 2 KB — enough to walk past the RIFF / fmt / fact /
    // LIST chunks of any real-world WAV before we reach `data`.
    const headerBytes = await blob.slice(0, Math.min(blob.size, 2048)).arrayBuffer()
    const view = new DataView(headerBytes)
    const u32be = (off: number) => view.getUint32(off, false)

    // RIFF / WAVE check (big-endian 4-CC stored as MSB-first uint32).
    //   'R'=0x52, 'I'=0x49, 'F'=0x46, 'F'=0x46 → 0x52494646
    //   'W'=0x57, 'A'=0x41, 'V'=0x56, 'E'=0x45 → 0x57415645
    if (view.byteLength < 12) return null
    if (u32be(0) !== 0x52494646) return null
    if (u32be(8) !== 0x57415645) return null

    let formatTag = 0, channels = 0, sampleRate = 0, bitsPerSample = 0
    let dataBytes = 0
    let cursor = 12
    let fmtSeen = false
    let dataSeen = false

    // Walk chunks until we've seen both fmt and data, or run out of buffer.
    while (cursor + 8 <= view.byteLength && (!fmtSeen || !dataSeen)) {
      const id = u32be(cursor)
      const size = view.getUint32(cursor + 4, true) // chunk sizes are LE
      const body = cursor + 8
      if (id === 0x666d7420) {        // 'fmt '
        if (body + 16 > view.byteLength) return null
        formatTag      = view.getUint16(body + 0, true)
        channels       = view.getUint16(body + 2, true)
        sampleRate     = view.getUint32(body + 4, true)
        bitsPerSample  = view.getUint16(body + 14, true)
        fmtSeen = true
      } else if (id === 0x64617461) { // 'data'
        dataBytes = size
        dataSeen = true
        break // we don't need to read the audio bytes here
      }
      // Chunks are padded to even sizes. The padding byte is not counted
      // in `size`, so step by size + 1 if odd.
      cursor = body + size + (size & 1)
    }

    if (!fmtSeen || !dataSeen) return null
    if (channels === 0 || sampleRate === 0 || bitsPerSample === 0) return null

    const bytesPerSample = bitsPerSample / 8
    const numFrames = dataBytes / (channels * bytesPerSample)
    const duration = numFrames / sampleRate
    return { formatTag, channels, sampleRate, bitsPerSample, dataBytes, duration }
  } catch {
    return null
  }
}

// ---- Internal helpers ----

/**
 * Resample an AudioBuffer to a target sample rate using OfflineAudioContext.
 */
async function resampleBuffer(buffer: AudioBuffer, targetRate: number): Promise<AudioBuffer> {
  const duration = buffer.duration
  const targetLength = Math.ceil(duration * targetRate)
  const offlineCtx = new OfflineAudioContext(
    buffer.numberOfChannels,
    targetLength,
    targetRate
  )

  const source = offlineCtx.createBufferSource()
  source.buffer = buffer
  source.connect(offlineCtx.destination)
  source.start(0)

  return offlineCtx.startRendering()
}

/**
 * Convert Float32Array [-1.0, 1.0] to Int16Array [-32768, 32767].
 */
function float32ToInt16(float32: Float32Array): Int16Array {
  const int16 = new Int16Array(float32.length)
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]))
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return int16
}

/**
 * Write WAV file header + interleaved PCM data.
 */
function writeWavFile(
  channels: Int16Array[],
  sampleRate: number,
  numChannels: number
): ArrayBuffer {
  const length = channels[0].length
  const dataSize = length * numChannels * 2 // 16-bit = 2 bytes
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)

  // RIFF header
  writeString(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeString(view, 8, 'WAVE')

  // fmt chunk
  writeString(view, 12, 'fmt ')
  view.setUint32(16, 16, true) // chunk size
  view.setUint16(20, 1, true) // PCM format
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * numChannels * 2, true) // byte rate
  view.setUint16(32, numChannels * 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample

  // data chunk
  writeString(view, 36, 'data')
  view.setUint32(40, dataSize, true)

  // Interleave channel data
  let offset = 44
  for (let i = 0; i < length; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      view.setInt16(offset, channels[ch][i], true)
      offset += 2
    }
  }

  return buffer
}

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i))
  }
}
