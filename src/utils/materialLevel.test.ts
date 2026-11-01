import { describe, expect, it } from 'vitest'
import { clipGainForPeak, normalizeGain, peakOf, renormalize } from './materialLevel'
import { MATERIAL_PEAK } from './sceneCueTable'

describe('material levels (DEC-086)', () => {
  it('normalizes to −0.5 dBFS and keeps the original size as the clip_gain (≤ 1)', () => {
    expect(MATERIAL_PEAK).toBeCloseTo(0.944, 3)
    expect(peakOf([Float32Array.from([0.1, -0.3, 0.2])])).toBeCloseTo(0.3)
    expect(normalizeGain(0.472) * 0.472).toBeCloseTo(MATERIAL_PEAK)
    expect(clipGainForPeak(0.472)).toBeCloseTo(0.5)
    expect(clipGainForPeak(1)).toBe(1)
    // × the rated strength of an AI candidate, capped at 1.
    expect(clipGainForPeak(0.472, 0.5)).toBeCloseTo(0.25)
    expect(clipGainForPeak(1, 0.8)).toBeCloseTo(0.8 / 0.944, 2)
    expect(clipGainForPeak(1, 0.95)).toBe(1)
    expect(normalizeGain(0)).toBe(1)
  })

  it('a re-rendered adjusted material sounds as loud as before (render × gain × clip_gain unchanged)', () => {
    // The last write normalized a render peaking at 0.5 (gain 1.888), heard at clip_gain 0.4.
    const first = renormalize(0.5, 1, 0.4)
    // The chain changes and the render peaks at 0.25 now: normalized harder, the clip_gain halves.
    const next = renormalize(0.25, first.gain, first.clipGain)
    expect(0.25 * next.gain * next.clipGain).toBeCloseTo(0.25 * 1 * 0.4)
    expect(next.clipGain).toBeCloseTo(first.clipGain / 2)
    // It cannot go above 1.
    expect(renormalize(1.5, 1, 1).clipGain).toBe(1)
  })
})
