/**
 * Texture effects for haptics: pure, deterministic functions on channel arrays.
 * Every function takes `Float32Array[]` (one per channel) and returns new
 * arrays; inputs are never mutated. Randomness comes only from `mulberry32`
 * seeded by the caller, so identical params always give identical samples
 * (and the functions run in Node tests without Web Audio).
 */
import type {
  AmShape,
  CompressorParams,
  EnvelopePoint,
  NoiseColor,
  SaturateMode,
} from '@/types/waveform'

/** Seeded 32-bit PRNG returning floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const dbToGain = (db: number) => 10 ** (db / 20)

function rms(channels: Float32Array[]): number {
  let sum = 0
  let count = 0
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) sum += ch[i] * ch[i]
    count += ch.length
  }
  return count ? Math.sqrt(sum / count) : 0
}

// ---- Biquad (RBJ cookbook) ----

/** Second-order RBJ low/high-pass, direct form I. Cutoff is clamped below Nyquist. */
export function biquad(
  data: Float32Array,
  sampleRate: number,
  kind: 'lowpass' | 'highpass',
  frequency: number,
  Q = Math.SQRT1_2
): Float32Array {
  const f = Math.min(Math.max(frequency, 1), sampleRate * 0.49)
  const w0 = (2 * Math.PI * f) / sampleRate
  const cos = Math.cos(w0)
  const alpha = Math.sin(w0) / (2 * Q)
  const a0 = 1 + alpha
  const b1 = (kind === 'lowpass' ? 1 - cos : -(1 + cos)) / a0
  const b0 = (kind === 'lowpass' ? (1 - cos) / 2 : (1 + cos) / 2) / a0
  const b2 = b0
  const a1 = (-2 * cos) / a0
  const a2 = (1 - alpha) / a0
  const out = new Float32Array(data.length)
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0
  for (let i = 0; i < data.length; i++) {
    const x = data[i]
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
    out[i] = y
    x2 = x1; x1 = x; y2 = y1; y1 = y
  }
  return out
}

/** Two cascaded biquads (24 dB/oct). */
function biquad2(data: Float32Array, sampleRate: number, kind: 'lowpass' | 'highpass', frequency: number) {
  return biquad(biquad(data, sampleRate, kind, frequency), sampleRate, kind, frequency)
}

// ---- Noise ----

/** Raw noise in roughly [-1, 1]. Pink: Paul Kellet's refined filter; brown: leaky integrator. */
export function generateNoise(length: number, color: NoiseColor, seed: number): Float32Array {
  const random = mulberry32(seed)
  const out = new Float32Array(length)
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0
  let brown = 0
  for (let i = 0; i < length; i++) {
    const white = random() * 2 - 1
    if (color === 'white') {
      out[i] = white
    } else if (color === 'pink') {
      b0 = 0.99886 * b0 + white * 0.0555179
      b1 = 0.99332 * b1 + white * 0.0750759
      b2 = 0.969 * b2 + white * 0.153852
      b3 = 0.8665 * b3 + white * 0.3104856
      b4 = 0.55 * b4 + white * 0.5329522
      b5 = -0.7616 * b5 - white * 0.016898
      out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11
      b6 = white * 0.115926
    } else {
      brown = (brown + 0.02 * white) / 1.02
      out[i] = brown * 3.5
    }
  }
  return out
}

/** Noise band-limited by 2-stage HPF at `lowHz` and 2-stage LPF at `highHz` (either optional). */
export function bandNoise(
  length: number,
  sampleRate: number,
  color: NoiseColor,
  seed: number,
  lowHz?: number,
  highHz?: number
): Float32Array {
  let noise = generateNoise(length, color, seed)
  if (lowHz !== undefined) noise = biquad2(noise, sampleRate, 'highpass', lowHz)
  if (highHz !== undefined) noise = biquad2(noise, sampleRate, 'lowpass', highHz)
  return noise
}

// ---- Amplitude modulation ----

export interface AmSettings {
  rateHz: number
  depth: number
  shape: AmShape
  jitter: number
}

/**
 * Gain curve for AM: gain = 1 − depth·d·(1 − m), m ∈ [0, 1].
 * Each cycle starts and ends at m = 1 (gain 1), so per-cycle changes of
 * period and depth never create a step. With jitter > 0 the period of every
 * cycle varies by ±jitter·period (floored at 10 % of the nominal rate so the
 * cycle stays finite); `random` additionally scales each cycle's depth by
 * d = 1 − jitter·U(0,1) and uses a raised-cosine shape.
 */
export function amGain(length: number, sampleRate: number, settings: AmSettings, seed: number): Float32Array {
  const random = mulberry32(seed)
  const { rateHz, depth, shape, jitter } = settings
  const gain = new Float32Array(length)
  const ramp = Math.max(1, Math.round(sampleRate * 0.001))
  let start = 0
  while (start < length) {
    const rate = Math.max(rateHz * (1 + jitter * (random() * 2 - 1)), rateHz * 0.1)
    const period = Math.max(2, Math.round(sampleRate / rate))
    const cycleDepth = shape === 'random' ? depth * (1 - jitter * random()) : depth
    const half = period / 2
    const r = Math.min(ramp, Math.floor(period / 4))
    const end = Math.min(length, start + period)
    for (let i = start; i < end; i++) {
      const t = i - start
      const phase = t / period
      let m: number
      switch (shape) {
        case 'square':
          if (t < half) m = 1
          else if (t < half + r) m = 1 - (t - half) / r
          else if (t < period - r) m = 0
          else m = (t - (period - r)) / r
          break
        case 'triangle':
          m = Math.abs(1 - 2 * phase)
          break
        default:
          m = 0.5 * (1 + Math.cos(2 * Math.PI * phase))
      }
      gain[i] = 1 - cycleDepth * (1 - m)
    }
    start = end
  }
  return gain
}

export function applyAm(channels: Float32Array[], sampleRate: number, settings: AmSettings, seed: number): Float32Array[] {
  const length = channels[0]?.length ?? 0
  const gain = amGain(length, sampleRate, settings, seed)
  return channels.map(ch => ch.map((v, i) => v * gain[i]))
}

// ---- Noise mix ----

export interface NoiseMixSettings {
  levelDb: number
  lowHz: number
  highHz: number
  color: NoiseColor
  follow: boolean
  seed: number
}

/**
 * Adds band-limited noise (identical on every channel) whose RMS equals the
 * input RMS × 10^(levelDb/20). With `follow`, the noise is first shaped by
 * the input's 10 ms RMS envelope (peak-normalised to 1).
 */
export function noiseMix(channels: Float32Array[], sampleRate: number, settings: NoiseMixSettings): Float32Array[] {
  const length = channels[0]?.length ?? 0
  const inputRms = rms(channels)
  if (!length || inputRms === 0) return channels.map(ch => ch.slice())
  const noise = bandNoise(length, sampleRate, settings.color, settings.seed, settings.lowHz, settings.highHz)
  if (settings.follow) {
    const envelope = rmsEnvelope(channels, Math.max(1, Math.round(sampleRate * 0.01)))
    let peak = 0
    for (let i = 0; i < length; i++) peak = Math.max(peak, envelope[i])
    if (peak > 0) for (let i = 0; i < length; i++) noise[i] *= envelope[i] / peak
  }
  const noiseRms = rms([noise])
  if (noiseRms === 0) return channels.map(ch => ch.slice())
  const scale = (inputRms * dbToGain(settings.levelDb)) / noiseRms
  return channels.map(ch => ch.map((v, i) => v + noise[i] * scale))
}

/** Centred moving RMS over `window` samples, averaged across channels. */
function rmsEnvelope(channels: Float32Array[], window: number): Float32Array {
  const length = channels[0].length
  const power = new Float64Array(length + 1)
  for (let i = 0; i < length; i++) {
    let p = 0
    for (const ch of channels) p += ch[i] * ch[i]
    power[i + 1] = power[i] + p / channels.length
  }
  const out = new Float32Array(length)
  const half = Math.floor(window / 2)
  for (let i = 0; i < length; i++) {
    const a = Math.max(0, i - half)
    const b = Math.min(length, i + half + 1)
    out[i] = Math.sqrt(Math.max(0, power[b] - power[a]) / (b - a))
  }
  return out
}

// ---- Frequency shift ----

/** In-place iterative radix-2 complex FFT. `inverse` includes the 1/N scale. */
function fft(re: Float64Array, im: Float64Array, inverse: boolean) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t
      t = im[i]; im[i] = im[j]; im[j] = t
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const angle = ((inverse ? 2 : -2) * Math.PI) / size
    const wr = Math.cos(angle), wi = Math.sin(angle)
    const half = size >> 1
    for (let start = 0; start < n; start += size) {
      let cr = 1, ci = 0
      for (let k = 0; k < half; k++) {
        const a = start + k, b = a + half
        const tr = re[b] * cr - im[b] * ci
        const ti = re[b] * ci + im[b] * cr
        re[b] = re[a] - tr; im[b] = im[a] - ti
        re[a] += tr; im[a] += ti
        const next = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = next
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n }
}

/**
 * Single-sideband frequency shift: Re(analytic(x) · e^{j2πft}). The analytic
 * signal uses an FFT Hilbert transform over the zero-padded power-of-two
 * length. Components shifted below 0 Hz fold back, so a 2-stage 15 Hz HPF
 * follows.
 */
export function frequencyShift(channels: Float32Array[], sampleRate: number, shiftHz: number): Float32Array[] {
  if (shiftHz === 0) return channels.map(ch => ch.slice())
  return channels.map(ch => {
    const length = ch.length
    let n = 1
    while (n < length) n <<= 1
    const re = new Float64Array(n), im = new Float64Array(n)
    for (let i = 0; i < length; i++) re[i] = ch[i]
    fft(re, im, false)
    for (let k = 1; k < n / 2; k++) { re[k] *= 2; im[k] *= 2 }
    for (let k = n / 2 + 1; k < n; k++) { re[k] = 0; im[k] = 0 }
    fft(re, im, true)
    const out = new Float32Array(length)
    const w = (2 * Math.PI * shiftHz) / sampleRate
    for (let i = 0; i < length; i++) out[i] = re[i] * Math.cos(w * i) - im[i] * Math.sin(w * i)
    return biquad2(out, sampleRate, 'highpass', 15)
  })
}

// ---- Compressor ----

/**
 * Feed-forward peak compressor with stereo-linked detection and a soft knee
 * (Giannoulis et al. 2012 gain computer, branching attack/release smoothing).
 */
export function compress(channels: Float32Array[], sampleRate: number, params: Omit<CompressorParams, 'type'>): Float32Array[] {
  const { thresholdDb: T, ratio: R, kneeDb: W, makeupDb } = params
  const length = channels[0]?.length ?? 0
  const attack = Math.exp(-1 / Math.max(1e-6, (params.attackMs * sampleRate) / 1000))
  const release = Math.exp(-1 / Math.max(1e-6, (params.releaseMs * sampleRate) / 1000))
  const out = channels.map(() => new Float32Array(length))
  let smoothed = 0
  for (let i = 0; i < length; i++) {
    let peak = 0
    for (const ch of channels) peak = Math.max(peak, Math.abs(ch[i]))
    const level = 20 * Math.log10(peak + 1e-12)
    const over = level - T
    let target: number
    if (2 * over < -W) target = level
    else if (2 * Math.abs(over) <= W) target = level + ((1 / R - 1) * (over + W / 2) ** 2) / (2 * W)
    else target = T + over / R
    const reduction = target - level
    const coefficient = reduction < smoothed ? attack : release
    smoothed = coefficient * smoothed + (1 - coefficient) * reduction
    const gain = dbToGain(smoothed + makeupDb)
    for (let c = 0; c < channels.length; c++) out[c][i] = channels[c][i] * gain
  }
  return out
}

// ---- Saturation ----

/** Triangle wavefolder mapping any real input into [-1, 1]. */
function fold(x: number): number {
  const t = (((x + 1) % 4) + 4) % 4
  return t < 2 ? t - 1 : 3 - t
}

export function saturate(channels: Float32Array[], driveDb: number, mode: SaturateMode, mix: number, outputDb: number): Float32Array[] {
  const drive = dbToGain(driveDb)
  const output = dbToGain(outputDb)
  const shape = mode === 'soft' ? Math.tanh : mode === 'hard' ? (x: number) => Math.max(-1, Math.min(1, x)) : fold
  return channels.map(ch => ch.map(v => (mix * shape(v * drive) + (1 - mix) * v) * output))
}

// ---- Envelope ----

/** Piecewise-linear gain over normalised time, multiplied into `data` in place. */
export function applyEnvelopeInPlace(data: Float32Array, points: EnvelopePoint[]): void {
  if (points.length < 2) return
  const length = data.length
  let ptIdx = 0
  for (let i = 0; i < length; i++) {
    const t = i / Math.max(1, length - 1) // normalized time 0-1
    // Advance to the correct segment
    while (ptIdx < points.length - 2 && t >= points[ptIdx + 1].time) ptIdx++
    // Linear interpolation between points
    const p0 = points[ptIdx]
    const p1 = points[ptIdx + 1]
    const segLen = p1.time - p0.time
    const frac = segLen > 0 ? (t - p0.time) / segLen : 0
    data[i] *= p0.value + (p1.value - p0.value) * frac
  }
}

// ---- Sound → haptic: amplitude follower, onsets, band split ----

export type CarrierShape = 'sine' | 'square' | 'triangle'

/** A constant-frequency periodic wave (−1…1). */
export function carrierTone(length: number, sampleRate: number, freqHz: number, shape: CarrierShape = 'sine'): Float32Array {
  const out = new Float32Array(length)
  for (let i = 0; i < length; i++) {
    const frac = (freqHz * i / sampleRate) % 1
    out[i] = shape === 'sine' ? Math.sin(2 * Math.PI * frac) : shape === 'square' ? (frac < 0.5 ? 1 : -1)
      : frac < 0.25 ? 4 * frac : frac < 0.75 ? 2 - 4 * frac : 4 * frac - 4
  }
  return out
}

/**
 * Amplitude envelope ("the shape of loud and quiet"): centred moving RMS over
 * `smoothMs`, × √2 so a steady full-scale sine reads 1.
 */
export function amplitudeEnvelope(data: Float32Array, sampleRate: number, smoothMs: number): Float32Array {
  if (!data.length) return new Float32Array(0)
  const env = rmsEnvelope([data], Math.max(1, Math.round(sampleRate * smoothMs / 1000)))
  for (let i = 0; i < env.length; i++) env[i] *= Math.SQRT2
  return env
}

export interface OnsetSettings {
  /** Level (dB re the material's peak level) the 5 ms level must exceed. */
  thresholdDb: number
  /** At most one onset per this interval. */
  minGapMs: number
  /** Rise the level must make within the last 20 ms (dB). */
  riseDb: number
}
export const ONSET_WINDOW_MS = 5
export const ONSET_RISE_MS = 20
/** Onset positions (samples) with the material's 5 ms level there (0–1 of its peak), at most `max`. */
export function detectOnsets(data: Float32Array, sampleRate: number, settings: OnsetSettings, max = 64): { index: number; level: number }[] {
  const env = amplitudeEnvelope(data, sampleRate, ONSET_WINDOW_MS)
  let peak = 0
  for (const v of env) peak = Math.max(peak, v)
  if (peak <= 0) return []
  const db = (v: number) => 20 * Math.log10(Math.max(v / peak, 1e-6))
  const back = Math.max(1, Math.round(sampleRate * ONSET_RISE_MS / 1000)), gap = Math.round(sampleRate * settings.minGapMs / 1000)
  const out: { index: number; level: number }[] = []
  let last = -Infinity
  for (let i = 1; i < env.length && out.length < max; i++) {
    if (i - last < gap) continue
    const now = db(env[i])
    if (now < settings.thresholdDb || now - db(env[Math.max(0, i - back)]) < settings.riseDb) continue
    // The onset sits where the rise starts to level off: take the local maximum within the rise window.
    let top = i
    for (let j = i; j < Math.min(env.length, i + back); j++) if (env[j] > env[top]) top = j
    out.push({ index: i, level: env[top] / peak })
    last = i
  }
  return out
}

export interface BandSplitSettings { crossoverHz: number; carrierHz: number; carrierShape: CarrierShape; highGainDb: number; smoothMs: number }
/**
 * Band split: the band below `crossoverHz` passes as is (24 dB/oct); the band
 * above it is replaced by its amplitude envelope × a `carrierHz` carrier, so the
 * high band's timing reaches the actuator at a frequency it can play.
 */
export function bandSplit(channels: Float32Array[], sampleRate: number, settings: BandSplitSettings): Float32Array[] {
  const gain = dbToGain(settings.highGainDb)
  return channels.map(ch => {
    const low = biquad2(ch, sampleRate, 'lowpass', settings.crossoverHz)
    const env = amplitudeEnvelope(biquad2(ch, sampleRate, 'highpass', settings.crossoverHz), sampleRate, settings.smoothMs)
    const carrier = carrierTone(ch.length, sampleRate, settings.carrierHz, settings.carrierShape)
    return low.map((v, i) => v + env[i] * carrier[i] * gain)
  })
}
