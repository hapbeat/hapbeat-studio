/** A small, deterministic source used by Studio's device playback check. */
export const QUICK_TEST_TONE = {
  frequencyHz: 100,
  durationSeconds: 1,
  sampleRate: 16_000,
  amplitude: 0.5,
  fileName: 'test-100Hz-1s.wav',
} as const

/**
 * Which motor the quick test drives: both (a mono source, L = R after the
 * stream's up-mix), or only the left / right channel of a stereo source.
 */
export type QuickTestSide = 'both' | 'left' | 'right'

export const QUICK_TEST_FILE_NAMES: Record<QuickTestSide, string> = {
  both: QUICK_TEST_TONE.fileName,
  left: 'test-100Hz-1s-L.wav',
  right: 'test-100Hz-1s-R.wav',
}

/**
 * Build a PCM16 WAV sine wave without using an AudioContext.
 *
 * Without `only` the WAV is mono. With `only` it is stereo, the sine in that
 * channel and silence in the other, so a stereo device drives one motor.
 *
 * Keeping the source at the device stream rate makes this useful even when
 * there is no Kit or local audio folder selected. The normal stream pipeline
 * still owns routing, clip_gain, cancellation, and format conversion.
 */
export function createSineWav(
  frequencyHz: number,
  durationSeconds: number,
  sampleRate: number,
  amplitude = 0.5,
  only?: 'left' | 'right',
): Uint8Array<ArrayBuffer> {
  if (!Number.isFinite(frequencyHz) || frequencyHz <= 0) {
    throw new RangeError('frequencyHz must be positive')
  }
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new RangeError('durationSeconds must be positive')
  }
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new RangeError('sampleRate must be a positive integer')
  }
  if (!Number.isFinite(amplitude) || amplitude < 0 || amplitude > 1) {
    throw new RangeError('amplitude must be between 0 and 1')
  }

  const channels = only ? 2 : 1
  const toneChannel = only === 'right' ? 1 : 0
  const samples = Math.round(durationSeconds * sampleRate)
  const blockAlign = channels * 2 // PCM16
  const dataBytes = samples * blockAlign
  const buffer = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(buffer)
  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeAscii(view, 8, 'WAVE')
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true) // PCM fmt chunk length
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * blockAlign, true) // byte rate
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, 16, true) // bits/sample
  writeAscii(view, 36, 'data')
  view.setUint32(40, dataBytes, true)

  // The silent channel stays 0 (a new ArrayBuffer is zero-filled).
  for (let i = 0; i < samples; i++) {
    const value = Math.round(
      Math.sin((2 * Math.PI * frequencyHz * i) / sampleRate) * amplitude * 32767,
    )
    view.setInt16(44 + i * blockAlign + toneChannel * 2, value, true)
  }
  return new Uint8Array(buffer)
}

export function createQuickTestToneBlob(side: QuickTestSide = 'both'): Blob {
  const { frequencyHz, durationSeconds, sampleRate, amplitude } = QUICK_TEST_TONE
  return new Blob(
    [createSineWav(frequencyHz, durationSeconds, sampleRate, amplitude, side === 'both' ? undefined : side)],
    { type: 'audio/wav' },
  )
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
}
