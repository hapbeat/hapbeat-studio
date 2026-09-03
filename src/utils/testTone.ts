/** A small, deterministic source used by Studio's device playback check. */
export const QUICK_TEST_TONE = {
  frequencyHz: 100,
  durationSeconds: 1,
  sampleRate: 16_000,
  amplitude: 0.5,
  fileName: 'test-100Hz-1s.wav',
} as const

/**
 * Build a mono PCM16 WAV sine wave without using an AudioContext.
 *
 * Keeping the source at the device stream rate makes this useful even when
 * there is no Kit or local audio folder selected. The normal stream pipeline
 * still owns routing, intensity, cancellation, and format conversion.
 */
export function createSineWav(
  frequencyHz: number,
  durationSeconds: number,
  sampleRate: number,
  amplitude = 0.5,
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

  const samples = Math.round(durationSeconds * sampleRate)
  const dataBytes = samples * 2 // PCM16 mono
  const buffer = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(buffer)
  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeAscii(view, 8, 'WAVE')
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true) // PCM fmt chunk length
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits/sample
  writeAscii(view, 36, 'data')
  view.setUint32(40, dataBytes, true)

  for (let i = 0; i < samples; i++) {
    const value = Math.round(
      Math.sin((2 * Math.PI * frequencyHz * i) / sampleRate) * amplitude * 32767,
    )
    view.setInt16(44 + i * 2, value, true)
  }
  return new Uint8Array(buffer)
}

export function createQuickTestToneBlob(): Blob {
  const { frequencyHz, durationSeconds, sampleRate, amplitude } = QUICK_TEST_TONE
  return new Blob(
    [createSineWav(frequencyHz, durationSeconds, sampleRate, amplitude)],
    { type: 'audio/wav' },
  )
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
}
