import { describe, expect, it } from 'vitest'
import { hitRange, isolateHit, spectralDenoise, spectrogram } from './cleanupDsp'
import { detectOnsets } from './textureDsp'

const SR = 48000
/**
 * The test signal of the reference run (boxing demo's boxing_denoise.py, via cleanup_reference.py): 1 s of hiss
 * (0.02 × LCG noise) with two hits (110 Hz body, 50 ms decay + a 4 ms noise click) at 0.10 s (0.6) and 0.45 s (0.35).
 */
function signal(): Float32Array {
  let s = 12345
  const rnd = () => { s = (1664525 * s + 1013904223) % 4294967296; return s / 4294967296 * 2 - 1 }
  const x = new Float64Array(SR)
  for (let i = 0; i < SR; i++) x[i] = 0.02 * rnd()
  for (const [t0, a] of [[0.10, 0.6], [0.45, 0.35]]) {
    const i0 = Math.round(t0 * SR)
    for (let i = i0; i < Math.min(SR, i0 + Math.round(0.3 * SR)); i++) {
      const tau = (i - i0) / SR
      x[i] += a * Math.sin(2 * Math.PI * 110 * tau) * Math.exp(-tau / 0.05) + a * 0.6 * rnd() * Math.exp(-tau / 0.004)
    }
  }
  return Float32Array.from(x)
}
/** What the reference printed for this signal (scipy / numpy). */
const REFERENCE = {
  hissBefore: -67.249, hissAfter: -76.776, hitHighBefore: -55.877, hitHighAfter: -56.930,
  hitsBefore: 2, kept: [0.082646, 0.4295], dur: 0.346854, hitsAfter: 1,
}

const stftDb = (x: Float32Array) => spectrogram(x, 1024, 512)
/** Hiss: mean 4–16 kHz power of the frames 30 dB below the loudest one (lowpass_hiss_report). */
function hissDb(x: Float32Array): number {
  const { bins, frames, power } = stftDb(x)
  const total = Array.from({ length: frames }, (_, t) => 10 * Math.log10(power.subarray(t * bins, (t + 1) * bins).reduce((a, b) => a + b, 0) + 1e-12))
  const loudest = Math.max(...total)
  let sum = 0, count = 0
  for (let t = 0; t < frames; t++) if (total[t] < loudest - 30) for (let k = 0; k < bins; k++) { const f = k * SR / 1024; if (f >= 4000 && f <= 16000) { sum += power[t * bins + k]; count++ } }
  return 10 * Math.log10(sum / count + 1e-12)
}
/** Mean 4–16 kHz power between t0 and t1 (frame times t·512 / SR). */
function bandDb(x: Float32Array, t0: number, t1: number): number {
  const { bins, frames, power } = stftDb(x)
  let sum = 0, count = 0
  for (let t = 0; t < frames; t++) { const time = t * 512 / SR; if (time < t0 || time > t1) continue
    for (let k = 0; k < bins; k++) { const f = k * SR / 1024; if (f >= 4000 && f <= 16000) { sum += power[t * bins + k]; count++ } } }
  return 10 * Math.log10(sum / count + 1e-12)
}
const hits = (x: Float32Array) => detectOnsets(x, SR, { thresholdDb: -30, minGapMs: 40, riseDb: 6 }, 1000).length

describe('clean-up effects match the reference implementation', () => {
  const x = signal()
  const denoised = spectralDenoise([x], SR, { thresholdK: 2, floorDb: -24, percentile: 20 })[0]

  it('spectral-denoise lowers the steady hiss like the reference and keeps the hit’s highs (unlike a low-pass)', () => {
    expect(denoised.length).toBe(x.length)
    expect(hissDb(x)).toBeCloseTo(REFERENCE.hissBefore, 0)
    expect(Math.abs(hissDb(denoised) - REFERENCE.hissAfter)).toBeLessThan(1)
    expect(Math.abs(bandDb(x, 0.10, 0.12) - REFERENCE.hitHighBefore)).toBeLessThan(0.5)
    expect(Math.abs(bandDb(denoised, 0.10, 0.12) - REFERENCE.hitHighAfter)).toBeLessThan(1)
  })

  it('isolate-hit keeps the loudest hit, cut before the second one, like the reference', () => {
    expect(hits(x)).toBe(REFERENCE.hitsBefore)
    const range = hitRange([denoised], SR, { endDb: -50, riseDb: 9 })!
    expect(Math.abs(range.start / SR - REFERENCE.kept[0])).toBeLessThan(0.003)
    expect(Math.abs(range.stop / SR - REFERENCE.kept[1])).toBeLessThan(0.003)
    const isolated = isolateHit([denoised], SR, { endDb: -50, fadeMs: 25, riseDb: 9 })[0]
    expect(Math.abs(isolated.length / SR - REFERENCE.dur)).toBeLessThan(0.003)
    expect(hits(isolated)).toBe(REFERENCE.hitsAfter)
    expect(isolated[isolated.length - 1] === 0).toBe(true) // faded out (±0)
  })

  it('leaves silence and a single hit alone; stereo is cut at one place', () => {
    expect(isolateHit([new Float32Array(1000)], SR, { endDb: -50, fadeMs: 25, riseDb: 9 })[0]).toHaveLength(1000)
    const single = x.slice(0, Math.round(0.4 * SR))
    const one = isolateHit([single, single.map(v => v * 0.5)], SR, { endDb: -50, fadeMs: 25, riseDb: 9 })
    expect(one[0].length).toBe(one[1].length)
    expect(hits(one[0])).toBe(1)
    expect(spectralDenoise([new Float32Array(0)], SR, { thresholdK: 2, floorDb: -24, percentile: 20 })[0]).toHaveLength(0)
  })
})
