/**
 * Perceptual-ish features of a mono haptic signal. Pure Float32Array functions
 * (no AudioBuffer) so they run in Node tests and are written verbatim into
 * catalog.json / candidates/*.json for agents. Definitions are mirrored in
 * GUIDE.md (agentGuide.ts); keep both in sync.
 */
export const FEATURE_BANDS = ['<40', '40-80', '80-160', '160-320', '320-640', '640-1000', '>1000'] as const
export type FeatureBand = typeof FEATURE_BANDS[number]
const BAND_EDGES = [40, 80, 160, 320, 640, 1000]

export interface HapticFeatures {
  durationSec: number
  peakDb: number
  rmsDb: number
  crestDb: number
  bandEnergy: Record<FeatureBand, number>
  centroidHz: number | null
  dominantHz: number | null
  flatness: number | null
  attackMs: number | null
  decayMs: number | null
  amRateHz: number | null
  amDepth: number | null
  irregularity: number | null
}
/** Scalar feature keys, used for knowledge aggregation (bandEnergy is flattened as `bandEnergy.<band>`). */
export const SCALAR_FEATURES = ['durationSec', 'peakDb', 'rmsDb', 'crestDb', 'centroidHz', 'dominantHz', 'flatness', 'attackMs', 'decayMs', 'amRateHz', 'amDepth', 'irregularity'] as const

/** dB values are floored here so silence stays JSON-serializable. */
export const DB_FLOOR = -120
const MAX_FFT = 1 << 16
const LOW_HZ = 20, HIGH_HZ = 1000

const round = (v: number, digits: number) => { const f = 10 ** digits; return Math.round(v * f) / f }
const toDb = (v: number) => Math.max(DB_FLOOR, 20 * Math.log10(v))
const nextPow2 = (n: number) => { let p = 1; while (p < n) p <<= 1; return p }

/** In-place iterative radix-2 FFT. `re.length` must be a power of two. */
export function fft(re: Float64Array, im: Float64Array) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]] }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti
        const next = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = next
      }
    }
  }
}

/** Hann-windowed power spectrum (bins 0..n/2). Signals longer than 2^16 are frame-averaged with 50 % overlap. */
export function powerSpectrum(data: ArrayLike<number>, minSize = 0): { power: Float64Array; size: number } {
  const size = Math.max(minSize, Math.min(MAX_FFT, nextPow2(Math.max(2, data.length))))
  const power = new Float64Array(size / 2 + 1)
  const frame = Math.min(size, data.length), hop = Math.max(1, frame >> 1)
  let frames = 0
  for (let start = 0; frames === 0 || start + frame <= data.length; start += hop) {
    const re = new Float64Array(size), im = new Float64Array(size)
    for (let i = 0; i < frame; i++) re[i] = (data[start + i] ?? 0) * (frame > 1 ? 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (frame - 1)) : 1)
    fft(re, im)
    for (let k = 0; k < power.length; k++) power[k] += re[k] * re[k] + im[k] * im[k]
    frames++
    if (frame >= data.length) break
  }
  for (let k = 0; k < power.length; k++) power[k] /= frames
  return { power, size }
}

/** 5 ms RMS envelope sampled every 1 ms (1 kHz envelope rate). */
export function rmsEnvelope(data: Float32Array, sampleRate: number): Float64Array {
  const win = Math.max(1, Math.round(sampleRate * 0.005)), hop = Math.max(1, Math.round(sampleRate * 0.001))
  const count = Math.max(1, Math.ceil(data.length / hop))
  const env = new Float64Array(count)
  const prefix = new Float64Array(data.length + 1)
  for (let i = 0; i < data.length; i++) prefix[i + 1] = prefix[i] + data[i] * data[i]
  for (let f = 0; f < count; f++) {
    const center = f * hop, a = Math.max(0, center - (win >> 1)), b = Math.min(data.length, a + win)
    env[f] = b > a ? Math.sqrt((prefix[b] - prefix[a]) / (b - a)) : 0
  }
  return env
}

function percentile(sorted: ArrayLike<number>, q: number): number {
  if (!sorted.length) return NaN
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

/** Channel average (returns the channel itself for mono). */
export function mixToMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0]
  const out = new Float32Array(channels[0].length)
  for (const ch of channels) for (let i = 0; i < out.length; i++) out[i] += ch[i] / channels.length
  return out
}

export function computeFeatures(data: Float32Array, sampleRate: number): HapticFeatures {
  let peak = 0, sum = 0
  for (let i = 0; i < data.length; i++) { const v = Math.abs(data[i]); if (v > peak) peak = v; sum += data[i] * data[i] }
  const rms = data.length ? Math.sqrt(sum / data.length) : 0
  const peakDb = toDb(peak), rmsDb = toDb(rms)

  const { power, size } = powerSpectrum(data)
  const binHz = sampleRate / size
  const bands = new Float64Array(FEATURE_BANDS.length)
  let total = 0, inSum = 0, inWeighted = 0, logSum = 0, inCount = 0, domPower = 0, domHz: number | null = null
  for (let k = 1; k < power.length; k++) {
    const hz = k * binHz, p = power[k]
    let band = BAND_EDGES.findIndex(edge => hz < edge)
    if (band < 0) band = BAND_EDGES.length
    bands[band] += p; total += p
    if (hz >= LOW_HZ && hz <= HIGH_HZ) {
      inSum += p; inWeighted += hz * p; logSum += Math.log(p + 1e-30); inCount++
      if (p > domPower) { domPower = p; domHz = hz }
    }
  }
  const bandEnergy = Object.fromEntries(FEATURE_BANDS.map((b, i) => [b, total > 0 ? round(bands[i] / total, 4) : 0])) as Record<FeatureBand, number>
  const inMean = inCount ? inSum / inCount : 0
  const flatness = inMean > 0 ? Math.min(1, Math.exp(logSum / inCount) / inMean) : null

  const env = rmsEnvelope(data, sampleRate)
  let maxIdx = 0
  for (let i = 1; i < env.length; i++) if (env[i] > env[maxIdx]) maxIdx = i
  const max = env[maxIdx]
  let attackMs: number | null = null, decayMs: number | null = null
  let amRateHz: number | null = null, amDepth: number | null = null, irregularity: number | null = null
  if (max > 0) {
    const t10 = env.findIndex(v => v >= max * 0.1), t90 = env.findIndex(v => v >= max * 0.9)
    attackMs = Math.max(0, t90 - t10)
    const fall = env.findIndex((v, i) => i > maxIdx && v <= max * 0.1)
    decayMs = fall < 0 ? null : fall - maxIdx
    // Active span: from first to last envelope frame within -30 dB of the maximum.
    const floor = max * 10 ** (-30 / 20)
    const first = env.findIndex(v => v >= floor)
    let last = env.length - 1
    while (last > first && env[last] < floor) last--
    const span = env.slice(first, last + 1)
    const mean = span.reduce((a, v) => a + v, 0) / span.length
    const variance = span.reduce((a, v) => a + (v - mean) ** 2, 0) / span.length
    irregularity = round(Math.sqrt(variance) / mean, 4)
    const sorted = Float64Array.from(span).sort()
    const p5 = percentile(sorted, 0.05), p95 = percentile(sorted, 0.95)
    amDepth = p95 + p5 > 0 ? round((p95 - p5) / (p95 + p5), 4) : 0
    // AM rate: envelope spectrum (mean removed) peak within 2–80 Hz. Needs ≥ 2 cycles of the lowest rate.
    if (span.length >= 50) {
      const centered = Float64Array.from(span, v => v - mean)
      const am = powerSpectrum(centered, 1024)
      const envHz = 1000 / am.size
      let best = 0
      for (let k = 1; k < am.power.length; k++) {
        const hz = k * envHz
        if (hz >= 2 && hz <= 80 && am.power[k] > best) { best = am.power[k]; amRateHz = round(hz, 2) }
      }
      if (best <= 0) amRateHz = null
    }
  }
  return {
    durationSec: round(data.length / sampleRate, 4),
    peakDb: round(peakDb, 2), rmsDb: round(rmsDb, 2), crestDb: round(peakDb - rmsDb, 2),
    bandEnergy,
    centroidHz: inSum > 0 ? round(inWeighted / inSum, 1) : null,
    dominantHz: domHz === null ? null : round(domHz, 1),
    flatness: flatness === null ? null : round(flatness, 4),
    attackMs, decayMs, amRateHz, amDepth, irregularity,
  }
}
