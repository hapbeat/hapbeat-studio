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
