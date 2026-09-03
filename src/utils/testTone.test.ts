import { describe, expect, it } from 'vitest'
import { QUICK_TEST_TONE, createSineWav } from './testTone'

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.slice(offset, offset + length))
}

describe('createSineWav', () => {
  it('creates the built-in 100 Hz, one-second PCM16 WAV source', () => {
    const wav = createSineWav(
      QUICK_TEST_TONE.frequencyHz,
      QUICK_TEST_TONE.durationSeconds,
      QUICK_TEST_TONE.sampleRate,
      QUICK_TEST_TONE.amplitude,
    )
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)

    expect(ascii(wav, 0, 4)).toBe('RIFF')
    expect(ascii(wav, 8, 4)).toBe('WAVE')
    expect(ascii(wav, 36, 4)).toBe('data')
    expect(view.getUint16(20, true)).toBe(1)
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint32(24, true)).toBe(16_000)
    expect(view.getUint32(40, true)).toBe(32_000)
    expect(wav).toHaveLength(32_044)
    expect(view.getInt16(44, true)).toBe(0)
    expect(view.getInt16(44 + 40 * 2, true)).toBeGreaterThan(16_000)
  })
})
