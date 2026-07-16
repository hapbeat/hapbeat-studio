import { describe, it, expect } from 'vitest'
import {
  computeRbjCoeffs,
  rbjToAic3204,
  computeAic3204Eq,
  aic3204CoeffsToArray,
  AIC3204_COEFF_SCALE,
  AIC3204_COEFF_MAX_INT,
  AIC3204_COEFF_MIN_INT,
  AIC3204_PASSTHROUGH,
  type FilterType,
} from './aic3204Eq'

// ---------------------------------------------------------------------
// Worked example: haptic band0 default (audio-dsp-config.md §2) — a 100Hz
// 2nd-order Butterworth LPF at fs=16000 (Q = 1/√2).
//
// The spec's prose gives *illustrative* ints (N0≈3188, N1≈3230, N2≈3188,
// D1≈8202381, D2≈−8023704) built by rounding the float coefficients to 4
// significant decimal digits BEFORE scaling by 2^23 — e.g. 8202381/2^23 =
// 0.97780001..., which is exactly 0.9778 × 2^23 rounded, and 0.9778 is a
// suspiciously round number for an exact RBJ result. Reproducing that
// intermediate 4-sig-fig rounding here would defeat the point of computing
// coefficients on real hardware. Per the repo rule "一次ソースを二次情報で
// 上書きしない" the AUTHORITATIVE source is the algebraic recipe the spec
// documents in the same section (N0=b0/a0, N1=b1/(2a0), …) — this test
// verifies against THAT recipe, with a generous tolerance against the
// illustrative ints (same ballpark, not bit-exact) plus tight
// self-consistency checks the recipe guarantees exactly.
// ---------------------------------------------------------------------
describe('100Hz Butterworth LPF @ 16kHz (haptic band0 default)', () => {
  const rbj = computeRbjCoeffs({ ftype: 'lpf', fs: 16000, fc: 100, q: 1 / Math.sqrt(2) })
  const { coeffs, overflowed, clamped } = rbjToAic3204(rbj)

  it('never overflows/clamps for a passband-only (≤0dB) filter', () => {
    expect(overflowed).toBe(false)
    expect(clamped).toBe(false)
  })

  it('N0 === N1 === N2 (algebraic identity for any RBJ lpf/hpf: b1 = 2·b0)', () => {
    // b1 = (1-cosW0) = 2·b0 for lpf (and the hpf mirror) is exact in the RBJ
    // cookbook itself, independent of fc/fs/Q — so N1 = b1/(2a0) = b0/a0 = N0.
    expect(coeffs.N1).toBe(coeffs.N0)
    expect(coeffs.N2).toBe(coeffs.N0)
  })

  it('D1 in (0,1) and D2 in (-1,0) — matches spec §2 note ("常に[−1,1)に収まる")', () => {
    expect(coeffs.D1).toBeGreaterThan(0)
    expect(coeffs.D1).toBeLessThan(AIC3204_COEFF_SCALE)
    expect(coeffs.D2).toBeLessThan(0)
    expect(coeffs.D2).toBeGreaterThan(-AIC3204_COEFF_SCALE)
  })

  it('within ~3% of the spec\'s illustrative worked ints (same ballpark, not bit-exact — see comment above)', () => {
    const expected = { N0: 3188, N1: 3230, N2: 3188, D1: 8202381, D2: -8023704 }
    for (const key of ['N0', 'N1', 'N2', 'D1', 'D2'] as const) {
      const got = coeffs[key]
      const want = expected[key]
      const relErr = Math.abs(got - want) / Math.abs(want)
      expect(relErr, `${key}: got ${got}, spec example ${want}`).toBeLessThan(0.03)
    }
  })

  it('computeAic3204Eq (the end-to-end entry point) agrees with the manual two-step path', () => {
    const direct = computeAic3204Eq({ ftype: 'lpf', fs: 16000, fc: 100, q: 1 / Math.sqrt(2) })
    expect(direct.coeffs).toEqual(coeffs)
  })

  it('aic3204CoeffsToArray produces the exact [N0,N1,N2,D1,D2] wire order', () => {
    expect(aic3204CoeffsToArray(coeffs)).toEqual([coeffs.N0, coeffs.N1, coeffs.N2, coeffs.D1, coeffs.D2])
  })
})

describe('"off" ftype — AIC3204 passthrough constant', () => {
  it('computeAic3204Eq returns the unity-gain passthrough with no RBJ design', () => {
    const r = computeAic3204Eq({ ftype: 'off', fs: 16000, fc: 100, q: 0.707 })
    expect(r.coeffs).toEqual(AIC3204_PASSTHROUGH)
    expect(r.overflowed).toBe(false)
    expect(r.clamped).toBe(false)
    expect(r.makeupDb).toBe(0)
  })

  it('N0 sits at the top of the representable range (never 2^23, which does not fit 24-bit signed)', () => {
    expect(AIC3204_PASSTHROUGH.N0).toBe(AIC3204_COEFF_MAX_INT)
    expect(AIC3204_PASSTHROUGH.N0).toBeLessThan(AIC3204_COEFF_SCALE)
  })
})

// ---------------------------------------------------------------------
// "A stable filter never clamps" — sweep every filter type across a
// realistic fc/Q/gain grid for both codec sample rates (16k haptic / 48k
// HP). Only NEGATIVE (cut) gain is exercised for peaking/shelf here —
// spec §2 explicitly calls out that boosts (gain > 0dB) are the case that
// CAN overflow (verified separately below); cuts and the gain-less types
// (lpf/hpf/notch) are documented as always safe.
// ---------------------------------------------------------------------
describe('stable filters never overflow/clamp (sweep)', () => {
  const GAINLESS: FilterType[] = ['lpf', 'hpf', 'notch']
  const GAIN_TYPES: FilterType[] = ['peaking', 'lowshelf', 'highshelf']
  const Q_VALUES = [0.5, 0.7071067811865476, 1, 2, 4]
  const CUT_GAINS_DB = [-24, -12, -6, -0.5]

  for (const fs of [16000, 48000]) {
    // fc kept away from the extreme low/near-Nyquist corners, which is
    // both the realistic EQ-designer range and where float rounding makes
    // the peak coefficient magnitude creep uncomfortably close to (but
    // still under) 1.0 for cuts — see verify script notes in the PR.
    const fcCandidates = [40, 100, 250, 800, 2000, Math.round(fs * 0.4)]

    it(`fs=${fs}: lpf/hpf/notch across fc×Q never overflow`, () => {
      for (const fc of fcCandidates) {
        for (const q of Q_VALUES) {
          for (const ftype of GAINLESS) {
            const r = computeAic3204Eq({ ftype, fs, fc, q }, { autoPrescale: false })
            expect(r.overflowed, `${ftype} fs=${fs} fc=${fc} q=${q}`).toBe(false)
            expect(r.clamped, `${ftype} fs=${fs} fc=${fc} q=${q}`).toBe(false)
          }
        }
      }
    })

    it(`fs=${fs}: peaking/shelf cuts (gain<0dB) across fc×Q×gain never overflow`, () => {
      for (const fc of fcCandidates) {
        for (const q of Q_VALUES) {
          for (const ftype of GAIN_TYPES) {
            for (const gainDb of CUT_GAINS_DB) {
              const r = computeAic3204Eq({ ftype, fs, fc, q, gainDb }, { autoPrescale: false })
              expect(r.overflowed, `${ftype} fs=${fs} fc=${fc} q=${q} gain=${gainDb}`).toBe(false)
              expect(r.clamped, `${ftype} fs=${fs} fc=${fc} q=${q} gain=${gainDb}`).toBe(false)
            }
          }
        }
      }
    })
  }
})

// ---------------------------------------------------------------------
// Boost overflow + auto-prescale (spec §2's numerator-overflow case).
// ---------------------------------------------------------------------
describe('peaking boost (gain>0dB) numerator overflow + auto-prescale', () => {
  const params = { ftype: 'peaking' as const, fs: 48000, fc: 1000, q: 1, gainDb: 12 }

  it('flags overflow and clamps when autoPrescale is off', () => {
    const r = computeAic3204Eq(params, { autoPrescale: false })
    expect(r.overflowed).toBe(true)
    expect(r.clamped).toBe(true)
    expect(r.makeupDb).toBe(0) // no prescale requested → no makeup reported
    // N0 clamps to the rail rather than wrapping/overflowing silently.
    expect(r.coeffs.N0).toBe(AIC3204_COEFF_MAX_INT)
  })

  it('autoPrescale (default) avoids clamping and reports positive makeup dB', () => {
    const r = computeAic3204Eq(params)
    expect(r.overflowed).toBe(true) // raw RBJ numerator still overflowed pre-prescale
    expect(r.clamped).toBe(false) // but the EMITTED ints fit
    expect(r.makeupDb).toBeGreaterThan(0)
    expect(r.makeupDb).toBeLessThan(3) // ~0.78dB expected for this Q/gain — sanity bound
    for (const v of Object.values(r.coeffs)) {
      expect(v).toBeGreaterThanOrEqual(AIC3204_COEFF_MIN_INT)
      expect(v).toBeLessThanOrEqual(AIC3204_COEFF_MAX_INT)
    }
  })

  it('a bigger boost needs more makeup dB (monotonic sanity check)', () => {
    const small = computeAic3204Eq({ ...params, gainDb: 6 })
    const big = computeAic3204Eq({ ...params, gainDb: 18 })
    expect(big.makeupDb).toBeGreaterThan(small.makeupDb)
  })
})

describe('degenerate inputs are clamped, not NaN/Infinity', () => {
  it('Q<=0 falls back to a tiny positive Q instead of dividing by zero', () => {
    const r = computeRbjCoeffs({ ftype: 'lpf', fs: 16000, fc: 100, q: 0 })
    for (const v of Object.values(r)) expect(Number.isFinite(v)).toBe(true)
  })

  it('fc outside (0, fs/2) is clamped into range', () => {
    const tooHigh = computeRbjCoeffs({ ftype: 'lpf', fs: 16000, fc: 20000, q: 0.707 })
    const tooLow = computeRbjCoeffs({ ftype: 'lpf', fs: 16000, fc: -50, q: 0.707 })
    for (const v of Object.values(tooHigh)) expect(Number.isFinite(v)).toBe(true)
    for (const v of Object.values(tooLow)) expect(Number.isFinite(v)).toBe(true)
  })
})
