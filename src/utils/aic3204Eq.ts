/**
 * RBJ Audio EQ Cookbook → TI AIC3204 in-codec biquad coefficients.
 *
 * Normative spec: hapbeat-contracts/specs/audio-dsp-config.md §2 (the wire
 * format / conversion recipe are authoritative there — this module is the
 * Studio-side implementation of that recipe, ported from the existing Dart
 * RBJ cookbook at hapbeat-bt-workspace/hapbeat-bt-mobile-app/lib/core/dsp/
 * audio_eq_cookbook.dart).
 *
 * Two distinct steps:
 *
 * 1. `computeRbjCoeffs` — Robert Bristow-Johnson's Audio EQ Cookbook biquad
 *    design (http://www.musicdsp.org/files/Audio-EQ-Cookbook.txt), producing
 *    the standard float (b0,b1,b2,a0,a1,a2) transfer-function coefficients.
 *    This half is IDENTICAL to the Dart reference (same formulas, same
 *    variable names) — only the target convention differs downstream.
 *
 * 2. `rbjToAic3204` — converts those RBJ floats to the AIC3204's Q1.23
 *    fixed-point coefficient encoding. This is NOT the same convention the
 *    Dart file targets (SigmaStudio/ADAU1701, which does not halve the
 *    cross terms). The AIC3204 transfer function (TI SLAA557 §2.4.2.2) is:
 *
 *        N0 + 2·N1·z⁻¹ + N2·z⁻²
 *      ────────────────────────── ,   24-bit 2's-complement Q1.23, scale 2^23
 *        1 − 2·D1·z⁻¹ − D2·z⁻²
 *
 *    which — matched against the normalized RBJ transfer function
 *    (b0/a0 + (b1/a0)z⁻¹ + (b2/a0)z⁻²) / (1 + (a1/a0)z⁻¹ + (a2/a0)z⁻²) —
 *    gives the halved cross terms specified in audio-dsp-config.md §2:
 *
 *      N0 = b0/a0        N1 = b1/(2·a0)      N2 = b2/a0
 *      D1 = −a1/(2·a0)   D2 = −a2/a0
 */

/** RBJ cookbook filter families this module supports (matches
 *  audio-dsp-config.md §2's `ftype` enum minus `"off"`, which has no RBJ
 *  design — it's the AIC3204 passthrough constant below). */
export type FilterType = 'lpf' | 'hpf' | 'peaking' | 'lowshelf' | 'highshelf' | 'notch'

/** Wire `ftype` value (audio-dsp-config.md §2 `set_eq_band`). */
export type EqFtype = 'off' | FilterType

export interface RbjParams {
  ftype: FilterType
  /** Sample rate, Hz (16000 for the haptic codec, 48000 for HP — §3/§4). */
  fs: number
  /** Corner/center frequency, Hz. */
  fc: number
  /** RBJ cookbook Q (0.7071067811865476 ≈ Butterworth 2nd-order). */
  q: number
  /** Gain, dB. Only used by peaking/lowshelf/highshelf. */
  gainDb?: number
}

/** Standard RBJ biquad transfer-function coefficients, UN-normalized
 *  (denominator is `a0 + a1·z⁻¹ + a2·z⁻²`, not yet divided through). */
export interface RbjCoeffs {
  b0: number
  b1: number
  b2: number
  a0: number
  a1: number
  a2: number
}

/**
 * Robert Bristow-Johnson's Audio EQ Cookbook, 2nd-order sections only
 * (lpf/hpf/peaking/notch/lowshelf/highshelf — the AIC3204 PRB_P1 biquad
 * slots this feeds are all 2nd-order). 1:1 port of the Dart reference's
 * `CookbookFilter.compute()` switch (same formulas, same order of
 * operations) — see file header.
 */
export function computeRbjCoeffs(p: RbjParams): RbjCoeffs {
  const fs = p.fs
  // Guard against degenerate inputs so a stray 0/negative Q or an
  // out-of-Nyquist fc from a half-typed form field doesn't produce NaN/Inf
  // coefficients mid-edit — clamp to the nearest valid value instead.
  const q = p.q > 0 ? p.q : 0.0001
  const fc = Math.min(Math.max(p.fc, 1), fs / 2 - 1)
  const w0 = (2 * Math.PI * fc) / fs
  const cosW0 = Math.cos(w0)
  const sinW0 = Math.sin(w0)
  const alpha = sinW0 / (2 * q)
  const gainDb = p.gainDb ?? 0
  const A = Math.pow(10, gainDb / 40)

  let b0 = 0
  let b1 = 0
  let b2 = 0
  let a0 = 1
  let a1 = 0
  let a2 = 0

  switch (p.ftype) {
    case 'peaking':
      b0 = 1 + alpha * A
      b1 = -2 * cosW0
      b2 = 1 - alpha * A
      a0 = 1 + alpha / A
      a1 = -2 * cosW0
      a2 = 1 - alpha / A
      break
    case 'lpf':
      b0 = (1 - cosW0) / 2
      b1 = 1 - cosW0
      b2 = (1 - cosW0) / 2
      a0 = 1 + alpha
      a1 = -2 * cosW0
      a2 = 1 - alpha
      break
    case 'hpf':
      b0 = (1 + cosW0) / 2
      b1 = -(1 + cosW0)
      b2 = (1 + cosW0) / 2
      a0 = 1 + alpha
      a1 = -2 * cosW0
      a2 = 1 - alpha
      break
    case 'notch':
      b0 = 1
      b1 = -2 * cosW0
      b2 = 1
      a0 = 1 + alpha
      a1 = -2 * cosW0
      a2 = 1 - alpha
      break
    case 'lowshelf': {
      const sq = 2 * Math.sqrt(A) * alpha
      b0 = A * (A + 1 - (A - 1) * cosW0 + sq)
      b1 = 2 * A * (A - 1 - (A + 1) * cosW0)
      b2 = A * (A + 1 - (A - 1) * cosW0 - sq)
      a0 = A + 1 + (A - 1) * cosW0 + sq
      a1 = -2 * (A - 1 + (A + 1) * cosW0)
      a2 = A + 1 + (A - 1) * cosW0 - sq
      break
    }
    case 'highshelf': {
      const sq = 2 * Math.sqrt(A) * alpha
      b0 = A * (A + 1 + (A - 1) * cosW0 + sq)
      b1 = -2 * A * (A - 1 + (A + 1) * cosW0)
      b2 = A * (A + 1 + (A - 1) * cosW0 - sq)
      a0 = A + 1 - (A - 1) * cosW0 + sq
      a1 = 2 * (A - 1 - (A + 1) * cosW0)
      a2 = A + 1 - (A - 1) * cosW0 - sq
      break
    }
  }

  return { b0, b1, b2, a0, a1, a2 }
}

// ---------------------------------------------------------------------
// AIC3204 Q1.23 fixed-point conversion (audio-dsp-config.md §2)
// ---------------------------------------------------------------------

/** Q1.23 scale factor, 2^23. */
export const AIC3204_COEFF_SCALE = 1 << 23 // 8388608
/** Largest representable positive Q1.23 int (2^23 − 1). */
export const AIC3204_COEFF_MAX_INT = (1 << 23) - 1 // 8388607
/** Smallest representable Q1.23 int (−2^23). */
export const AIC3204_COEFF_MIN_INT = -(1 << 23) // -8388608

export interface Aic3204Coeffs {
  N0: number
  N1: number
  N2: number
  D1: number
  D2: number
}

/** Unity-gain passthrough (ftype "off"): N0 = full-scale, everything else 0. */
export const AIC3204_PASSTHROUGH: Aic3204Coeffs = {
  N0: AIC3204_COEFF_MAX_INT,
  N1: 0,
  N2: 0,
  D1: 0,
  D2: 0,
}

export interface Aic3204ConvertOptions {
  /**
   * When the RBJ numerator (N0/N1/N2) would overflow the ±2^23 rail — which
   * per spec §2 only happens for peaking/shelf sections with gain > 0dB,
   * since N0/N2 are NOT halved like N1/D1 are — pre-scale the whole
   * numerator by the reciprocal of its peak magnitude so it fits, and
   * report the shaved-off gain via `makeupDb` (caller should compensate
   * elsewhere: DAC boost or another band). Default true; pass false to get
   * raw clamp-and-flag behavior instead (no gain compensation).
   */
  autoPrescale?: boolean
}

export interface Aic3204ConvertResult {
  coeffs: Aic3204Coeffs
  /**
   * True if any of the 5 RAW (pre-round, pre-prescale) floats reached or
   * exceeded 1.0 in magnitude — i.e. would not fit the Q1.23 rail as-is.
   * For lpf/hpf/notch/peaking&shelf with gain ≤ 0dB and a sane Q this
   * should never be true; peaking/shelf with gain > 0dB CAN trip it (spec
   * §2's "passband gain > 0dB で 1.0 超過しうる" numerator-overflow case).
   */
  overflowed: boolean
  /** True if the FINAL emitted ints needed clamping to [MIN,MAX]. With
   *  `autoPrescale` (default) this should only ever differ from
   *  `overflowed` in pathological cases (e.g. an unstable D1/D2 from a
   *  degenerate Q) — prescale only touches the numerator. */
  clamped: boolean
  /** dB of gain removed from the section by auto-prescale (0 when no
   *  prescale was needed/requested). */
  makeupDb: number
}

/**
 * Convert normalized-by-caller RBJ coefficients to AIC3204 Q1.23 ints per
 * audio-dsp-config.md §2's exact recipe:
 *   N0=b0/a0  N1=b1/(2a0)  N2=b2/a0  D1=−a1/(2a0)  D2=−a2/a0
 * then ×2^23, round, clamp to [−8388608, 8388607].
 */
export function rbjToAic3204(c: RbjCoeffs, opts: Aic3204ConvertOptions = {}): Aic3204ConvertResult {
  const { autoPrescale = true } = opts
  const a0 = c.a0 !== 0 ? c.a0 : 1e-9

  let n0 = c.b0 / a0
  let n1 = c.b1 / (2 * a0)
  let n2 = c.b2 / a0
  const d1 = -c.a1 / (2 * a0)
  const d2 = -c.a2 / a0

  const numeratorPeak = Math.max(Math.abs(n0), Math.abs(n1), Math.abs(n2))
  const overflowed = numeratorPeak >= 1 || Math.abs(d1) >= 1 || Math.abs(d2) >= 1

  let makeupDb = 0
  if (autoPrescale && numeratorPeak >= 1) {
    // Scale the numerator down to just inside the representable range
    // (a hair under 1.0, so the rounded int lands at/under
    // AIC3204_COEFF_MAX_INT rather than overflowing to 2^23 exactly).
    const margin = AIC3204_COEFF_MAX_INT / AIC3204_COEFF_SCALE
    const scale = margin / numeratorPeak
    n0 *= scale
    n1 *= scale
    n2 *= scale
    makeupDb = 20 * Math.log10(1 / scale)
  }

  const raw = { N0: n0, N1: n1, N2: n2, D1: d1, D2: d2 }
  const toInt = (v: number) => {
    const scaled = Math.round(v * AIC3204_COEFF_SCALE)
    return Math.max(AIC3204_COEFF_MIN_INT, Math.min(AIC3204_COEFF_MAX_INT, scaled))
  }
  const clamped = Object.values(raw).some((v) => {
    const scaled = Math.round(v * AIC3204_COEFF_SCALE)
    return scaled < AIC3204_COEFF_MIN_INT || scaled > AIC3204_COEFF_MAX_INT
  })

  return {
    coeffs: {
      N0: toInt(raw.N0),
      N1: toInt(raw.N1),
      N2: toInt(raw.N2),
      D1: toInt(raw.D1),
      D2: toInt(raw.D2),
    },
    overflowed,
    clamped,
    makeupDb,
  }
}

/**
 * End-to-end: RBJ design params (or "off") → AIC3204 Q1.23 ints. This is
 * the function EQ-designer UI code should call — it handles `ftype:"off"`
 * as the passthrough constant (no RBJ design possible/needed for it).
 */
export function computeAic3204Eq(
  params: { ftype: EqFtype; fs: number; fc: number; q: number; gainDb?: number },
  opts: Aic3204ConvertOptions = {},
): Aic3204ConvertResult {
  if (params.ftype === 'off') {
    return { coeffs: { ...AIC3204_PASSTHROUGH }, overflowed: false, clamped: false, makeupDb: 0 }
  }
  const rbj = computeRbjCoeffs({
    ftype: params.ftype,
    fs: params.fs,
    fc: params.fc,
    q: params.q,
    gainDb: params.gainDb,
  })
  return rbjToAic3204(rbj, opts)
}

/** `[N0,N1,N2,D1,D2]` — the exact array shape `set_eq_band`'s `coeffs`
 *  field expects (audio-dsp-config.md §2). */
export function aic3204CoeffsToArray(c: Aic3204Coeffs): [number, number, number, number, number] {
  return [c.N0, c.N1, c.N2, c.D1, c.D2]
}

// ---------------------------------------------------------------------
// Frequency-response magnitude (for the Studio EQ graph)
// ---------------------------------------------------------------------

/**
 * Magnitude (dB) of ONE biquad section at frequency `f` (Hz), sample rate
 * `fs` (Hz), from its un-normalized RBJ coeffs. Evaluates the transfer
 * function H(z)=(b0+b1 z⁻¹+b2 z⁻²)/(a0+a1 z⁻¹+a2 z⁻²) at z=e^{jω},
 * ω=2πf/fs. This is the IDEAL design response (pre-Q1.23-quantization /
 * pre-auto-prescale) — the shape the user is designing; the per-band
 * readout separately flags any prescale makeup that shifts overall level.
 */
export function biquadMagnitudeDb(c: RbjCoeffs, fs: number, f: number): number {
  const w = (2 * Math.PI * f) / fs
  const cw = Math.cos(w)
  const sw = Math.sin(w)
  const c2w = Math.cos(2 * w)
  const s2w = Math.sin(2 * w)
  // e^{-jω} = cw − j·sw, e^{-2jω} = c2w − j·s2w.
  const numRe = c.b0 + c.b1 * cw + c.b2 * c2w
  const numIm = -(c.b1 * sw + c.b2 * s2w)
  const denRe = c.a0 + c.a1 * cw + c.a2 * c2w
  const denIm = -(c.a1 * sw + c.a2 * s2w)
  const numMag = Math.hypot(numRe, numIm)
  const denMag = Math.hypot(denRe, denIm) || 1e-12
  return 20 * Math.log10((numMag || 1e-12) / denMag)
}

export interface EqCurvePoint {
  f: number
  db: number
}

/**
 * Combined magnitude response (dB) of a cascade of EQ bands, sampled at
 * `points` log-spaced frequencies from fMin..fMax (default 20 Hz..fs/2).
 * Cascade = sum of the per-band dB. `ftype:"off"` bands contribute 0 dB.
 * Used by the Studio EQ graph to plot the resulting curve live as the user
 * edits fc/Q/gain.
 */
export function eqResponseCurve(
  bands: Array<{ ftype: EqFtype; fc: number; q: number; gainDb?: number }>,
  fs: number,
  opts: { fMin?: number; fMax?: number; points?: number } = {},
): EqCurvePoint[] {
  const fMin = opts.fMin ?? 20
  const fMax = opts.fMax ?? fs / 2
  const points = opts.points ?? 96
  const coeffs = bands
    .filter((b) => b.ftype !== 'off')
    .map((b) => computeRbjCoeffs({ ftype: b.ftype as FilterType, fs, fc: b.fc, q: b.q, gainDb: b.gainDb }))
  const logMin = Math.log10(fMin)
  const logMax = Math.log10(fMax)
  const out: EqCurvePoint[] = []
  for (let i = 0; i < points; i++) {
    const f = Math.pow(10, logMin + ((logMax - logMin) * i) / (points - 1))
    let db = 0
    for (const c of coeffs) db += biquadMagnitudeDb(c, fs, f)
    out.push({ f, db })
  }
  return out
}
