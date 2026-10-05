import { describe, expect, it } from 'vitest'
import { encodePcm16Wav } from './sceneCueTable'
import { sameSound } from './wavCompare'

const tone = (n: number, gain = 0.5, f = 0.01) => Float32Array.from({ length: n }, (_, i) => gain * Math.sin(i * f * 2 * Math.PI))

describe('sameSound (duplicate materials)', () => {
  it('the same material re-encoded (tiny rounding) is the same; another gain, take, rate or length is not', () => {
    const a = encodePcm16Wav(tone(16000), 16000, 1)
    const reencoded = encodePcm16Wav(tone(16000).map(v => v + 1e-5), 16000, 1)
    expect(sameSound(a, reencoded)).toBe(true)
    expect(sameSound(a, encodePcm16Wav(tone(16000, 0.5 * 10 ** (-1 / 20)), 16000, 1))).toBe(false) // -1 dB
    expect(sameSound(a, encodePcm16Wav(tone(16000, 0.5, 0.013), 16000, 1))).toBe(false)
    expect(sameSound(a, encodePcm16Wav(tone(16000), 48000, 1))).toBe(false)
    expect(sameSound(a, encodePcm16Wav(tone(14000), 16000, 1))).toBe(false)
    expect(sameSound(a, new ArrayBuffer(10))).toBe(false)
  })
})
