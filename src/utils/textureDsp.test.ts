import { describe, expect, it } from 'vitest'
import { amGain, applyAm, bandNoise, biquad, compress, frequencyShift, mulberry32, noiseMix, saturate } from './textureDsp'

const RATE = 48000
const sine = (freq: number, seconds: number, amplitude = 1, rate = RATE) =>
  Float32Array.from({ length: Math.round(seconds * rate) }, (_, i) => amplitude * Math.sin((2 * Math.PI * freq * i) / rate))
const rms = (data: Float32Array, from = 0, to = data.length) => {
  let sum = 0
  for (let i = from; i < to; i++) sum += data[i] * data[i]
  return Math.sqrt(sum / (to - from))
}
const peak = (data: Float32Array, from = 0, to = data.length) => {
  let max = 0
  for (let i = from; i < to; i++) max = Math.max(max, Math.abs(data[i]))
  return max
}
/** Estimated frequency from rising zero crossings within [from, to). */
const zeroCrossingHz = (data: Float32Array, from: number, to: number, rate = RATE) => {
  let count = 0
  for (let i = from + 1; i < to; i++) if (data[i - 1] < 0 && data[i] >= 0) count++
  return (count * rate) / (to - from)
}

describe('mulberry32', () => {
  it('is deterministic per seed and stays in [0, 1)', () => {
    const a = mulberry32(42), b = mulberry32(42), c = mulberry32(43)
    const seqA = Array.from({ length: 100 }, a), seqB = Array.from({ length: 100 }, b), seqC = Array.from({ length: 100 }, c)
    expect(seqA).toEqual(seqB)
    expect(seqA).not.toEqual(seqC)
    expect(seqA.every(v => v >= 0 && v < 1)).toBe(true)
  })
})

describe('amGain', () => {
  it('sine AM spans 1 − depth .. 1 at the requested rate', () => {
    const gain = amGain(RATE, RATE, { rateHz: 10, depth: 0.6, shape: 'sine', jitter: 0 }, 1)
    expect(Math.max(...gain)).toBeCloseTo(1, 5)
    expect(Math.min(...gain)).toBeCloseTo(0.4, 3)
    let minima = 0
    for (let i = 1; i < gain.length - 1; i++) if (gain[i] < gain[i - 1] && gain[i] <= gain[i + 1]) minima++
    expect(minima).toBe(10)
  })

  it('square AM ramps over ~1 ms instead of stepping', () => {
    const gain = amGain(RATE, RATE, { rateHz: 20, depth: 1, shape: 'square', jitter: 0 }, 1)
    let maxStep = 0
    for (let i = 1; i < gain.length; i++) maxStep = Math.max(maxStep, Math.abs(gain[i] - gain[i - 1]))
    expect(maxStep).toBeLessThanOrEqual(1 / 48 + 1e-6)
    expect(Math.min(...gain)).toBe(0)
  })

  it('random AM is seed-deterministic, bounded and continuous', () => {
    const settings = { rateHz: 18, depth: 0.8, shape: 'random' as const, jitter: 0.5 }
    const a = amGain(RATE, RATE, settings, 7), b = amGain(RATE, RATE, settings, 7), c = amGain(RATE, RATE, settings, 8)
    expect(a).toEqual(b)
    expect(a).not.toEqual(c)
    expect(Math.min(...a)).toBeGreaterThanOrEqual(0.2 - 1e-6)
    expect(Math.max(...a)).toBeLessThanOrEqual(1)
    let maxStep = 0
    for (let i = 1; i < a.length; i++) maxStep = Math.max(maxStep, Math.abs(a[i] - a[i - 1]))
    expect(maxStep).toBeLessThan(0.01)
  })

  it('jitter varies the period of periodic shapes', () => {
    const steady = amGain(RATE, RATE, { rateHz: 10, depth: 1, shape: 'triangle', jitter: 0 }, 3)
    const jittered = amGain(RATE, RATE, { rateHz: 10, depth: 1, shape: 'triangle', jitter: 0.5 }, 3)
    expect(jittered).not.toEqual(steady)
  })

  it('applyAm multiplies every channel by the same curve without mutating input', () => {
    const input = [new Float32Array(1000).fill(1), new Float32Array(1000).fill(-1)]
    const out = applyAm(input, RATE, { rateHz: 50, depth: 0.5, shape: 'sine', jitter: 0 }, 1)
    expect(input[0][500]).toBe(1)
    for (let i = 0; i < 1000; i++) expect(out[1][i]).toBeCloseTo(-out[0][i], 6)
  })
})

describe('bandNoise / biquad', () => {
  it('keeps energy inside the pass band', () => {
    const noise = bandNoise(RATE * 2, RATE, 'white', 5, 100, 300)
    const above = biquad(biquad(noise, RATE, 'highpass', 2000), RATE, 'highpass', 2000)
    const below = biquad(biquad(noise, RATE, 'lowpass', 20), RATE, 'lowpass', 20)
    expect(rms(above) / rms(noise)).toBeLessThan(0.02)
    expect(rms(below) / rms(noise)).toBeLessThan(0.05)
  })

  it('is deterministic for the same seed and colour', () => {
    expect(bandNoise(4800, RATE, 'pink', 9, 50, 500)).toEqual(bandNoise(4800, RATE, 'pink', 9, 50, 500))
    expect(bandNoise(4800, RATE, 'brown', 9)).not.toEqual(bandNoise(4800, RATE, 'brown', 10))
  })
})

describe('noiseMix', () => {
  const settings = { levelDb: -6, lowHz: 50, highHz: 500, color: 'white' as const, follow: false, seed: 3 }

  it('adds noise at input RMS × 10^(levelDb/20)', () => {
    const input = [sine(100, 1, 0.5)]
    const out = noiseMix(input, RATE, settings)
    const added = out[0].map((v, i) => v - input[0][i])
    expect(rms(added) / rms(input[0])).toBeCloseTo(10 ** (-6 / 20), 3)
    expect(noiseMix(input, RATE, settings)).toEqual(out)
  })

  it('follow keeps silent passages silent', () => {
    const input = [Float32Array.from(sine(100, 1, 0.5), (v, i) => (i < RATE / 2 ? v : 0))]
    const out = noiseMix(input, RATE, { ...settings, follow: true })
    expect(peak(out[0], Math.round(RATE * 0.6))).toBeLessThan(1e-3)
    expect(rms(out[0], 0, RATE / 2)).toBeGreaterThan(rms(input[0], 0, RATE / 2))
  })

  it('returns a copy for silent input', () => {
    const input = [new Float32Array(1000)]
    const out = noiseMix(input, RATE, settings)
    expect(out[0]).toEqual(input[0])
    expect(out[0]).not.toBe(input[0])
  })
})

describe('frequencyShift', () => {
  it('moves a 1 kHz tone down to 100 Hz', () => {
    const [out] = frequencyShift([sine(1000, 1)], RATE, -900)
    expect(zeroCrossingHz(out, RATE * 0.2, RATE * 0.8)).toBeCloseTo(100, -1)
    expect(rms(out, RATE * 0.2, RATE * 0.8)).toBeGreaterThan(0.6)
  })

  it('moves a 100 Hz tone up to 250 Hz and zero shift is identity', () => {
    const input = sine(100, 1)
    const [up] = frequencyShift([input], RATE, 150)
    expect(zeroCrossingHz(up, RATE * 0.2, RATE * 0.8)).toBeCloseTo(250, -1)
    expect(frequencyShift([input], RATE, 0)[0]).toEqual(input)
  })
})

describe('compress', () => {
  it('reduces a steady tone to threshold + over/ratio (hard knee)', () => {
    const [out] = compress([sine(100, 1)], RATE, { thresholdDb: -20, ratio: 4, attackMs: 1, releaseMs: 50, kneeDb: 0, makeupDb: 0 })
    const tail = peak(out, RATE * 0.8, RATE)
    expect(20 * Math.log10(tail)).toBeGreaterThan(-16.5)
    expect(20 * Math.log10(tail)).toBeLessThan(-13.5)
  })

  it('leaves signals under the threshold untouched and links channels', () => {
    const quiet = sine(100, 0.2, 0.01)
    const loud = sine(100, 0.2, 1)
    const params = { thresholdDb: -20, ratio: 8, attackMs: 1, releaseMs: 50, kneeDb: 6, makeupDb: 0 }
    expect(peak(compress([quiet], RATE, params)[0])).toBeCloseTo(0.01, 4)
    const [a, b] = compress([loud, quiet], RATE, params)
    const i = Math.round(RATE * 0.15)
    expect(b[i] / quiet[i]).toBeCloseTo(a[i] / loud[i], 5)
  })
})

describe('saturate', () => {
  const input = sine(100, 0.1, 0.9)
  it('hard and fold stay within ±1; soft equals tanh', () => {
    expect(peak(saturate([input], 18, 'hard', 1, 0)[0])).toBeLessThanOrEqual(1)
    expect(peak(saturate([input], 18, 'fold', 1, 0)[0])).toBeLessThanOrEqual(1 + 1e-6)
    const [soft] = saturate([input], 6, 'soft', 1, 0)
    expect(soft[100]).toBeCloseTo(Math.tanh(input[100] * 10 ** (6 / 20)), 5)
  })
  it('mix 0 with 0 dB output is identity', () => {
    const [out] = saturate([input], 24, 'fold', 0, 0)
    for (let i = 0; i < input.length; i++) expect(out[i]).toBeCloseTo(input[i], 6)
  })
})
