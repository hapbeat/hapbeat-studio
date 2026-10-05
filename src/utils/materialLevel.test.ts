import { describe, expect, it } from 'vitest'
import { intensityForPeak, normalizeGain, peakOf, renormalize } from './materialLevel'
import { MATERIAL_PEAK } from './sceneCueTable'

describe('material levels (DEC-086)', () => {
  it('normalizes to −0.5 dBFS and keeps the original size as the intensity (≤ 1)', () => {
    expect(MATERIAL_PEAK).toBeCloseTo(0.944, 3)
    expect(peakOf([Float32Array.from([0.1, -0.3, 0.2])])).toBeCloseTo(0.3)
    expect(normalizeGain(0.472) * 0.472).toBeCloseTo(MATERIAL_PEAK)
    expect(intensityForPeak(0.472)).toBeCloseTo(0.5)
    expect(intensityForPeak(1)).toBe(1)
    expect(normalizeGain(0)).toBe(1)
  })

  it('a re-rendered adjusted material sounds as loud as before (render × gain × intensity unchanged)', () => {
    // The last write normalized a render peaking at 0.5 (gain 1.888), heard at intensity 0.4.
    const first = renormalize(0.5, 1, 0.4)
    // The chain changes and the render peaks at 0.25 now: normalized harder, the intensity halves.
    const next = renormalize(0.25, first.gain, first.intensity)
    expect(0.25 * next.gain * next.intensity).toBeCloseTo(0.25 * 1 * 0.4)
    expect(next.intensity).toBeCloseTo(first.intensity / 2)
    // It cannot go above 1.
    expect(renormalize(1.5, 1, 1).intensity).toBe(1)
  })
})
