import { describe, expect, it } from 'vitest'
import { QUICK_TEST_TONE, createSineWav } from './testTone'

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.slice(offset, offset + length))
}

function stereoTone(only: 'left' | 'right') {
  const wav = createSineWav(
    QUICK_TEST_TONE.frequencyHz,
    QUICK_TEST_TONE.durationSeconds,
    QUICK_TEST_TONE.sampleRate,
    QUICK_TEST_TONE.amplitude,
    only,
  )
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
  const frames = view.getUint32(40, true) / 4
  const left: number[] = []
  const right: number[] = []
  for (let i = 0; i < frames; i++) {
    left.push(view.getInt16(44 + i * 4, true))
    right.push(view.getInt16(44 + i * 4 + 2, true))
  }
  return { wav, view, left, right }
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

  it('creates a stereo WAV with the tone only in the left channel', () => {
    const { wav, view, left, right } = stereoTone('left')

    expect(view.getUint16(22, true)).toBe(2)
    expect(view.getUint32(24, true)).toBe(16_000)
    expect(view.getUint32(28, true)).toBe(64_000)
    expect(view.getUint16(32, true)).toBe(4)
    expect(view.getUint32(40, true)).toBe(64_000)
    expect(wav).toHaveLength(64_044)
    expect(left).toHaveLength(16_000)
    expect(right.every((v) => v === 0)).toBe(true)
    expect(left[40]).toBeGreaterThan(16_000)
  })

  it('creates a stereo WAV with the tone only in the right channel, same as the mono tone', () => {
    const mono = createSineWav(
      QUICK_TEST_TONE.frequencyHz,
      QUICK_TEST_TONE.durationSeconds,
      QUICK_TEST_TONE.sampleRate,
      QUICK_TEST_TONE.amplitude,
    )
    const monoView = new DataView(mono.buffer, mono.byteOffset, mono.byteLength)
    const { left, right } = stereoTone('right')

    expect(left.every((v) => v === 0)).toBe(true)
    expect(right.map((v, i) => v - monoView.getInt16(44 + i * 2, true)).every((d) => d === 0)).toBe(true)
  })
})
