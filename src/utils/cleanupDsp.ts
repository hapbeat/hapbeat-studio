/**
 * Clean-up effects for found / generated material (pure channel-array DSP, like textureDsp).
 *
 * spectral-denoise — a spectral gate for steady noise (hiss, hum): STFT (periodic Hann, 75 % overlap); per frequency bin
 * the noise floor is the `percentile` of its magnitude over all frames; bins at or below floor × `thresholdK` go down to
 * `floorDb`, bins at 2 × that or more pass, linearly between; the mask is averaged over 3 bins × 3 frames so no lone
 * bins flicker ("musical noise"). Unlike a low-pass it keeps a hit's highs and lowers only what is always there.
 *
 * isolate-hit — one contact, one sound: keeps the loudest hit from just before its attack to where its 5 ms level falls
 * `endDb` below its peak or just before a later re-attack (≥ `riseDb` within 20 ms, ≥ 60 ms after the peak), whichever
 * comes first, with a `fadeMs` fade-out.
 *
 * Both follow the reference implementation the boxing demo materials were made with (scipy stft / istft with
 * boundary zeros, ndimage.uniform_filter; the 5 ms onset rule of textureDsp.detectOnsets).
 */
import { amplitudeEnvelope, detectOnsets, fft, ONSET_WINDOW_MS } from './textureDsp'

export interface SpectralDenoiseSettings { thresholdK: number; floorDb: number; percentile: number }
export interface IsolateHitSettings { endDb: number; fadeMs: number; riseDb: number }

/** STFT size for a sample rate: 1024 at 44.1 / 48 kHz (≈ 21 ms), scaled with the rate (at least 256). */
export function denoiseFftSize(sampleRate: number): number {
  return Math.max(256, 2 ** Math.round(Math.log2(1024 * sampleRate / 48000)))
}

const hann = (n: number) => Float64Array.from({ length: n }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n))

/** Frames of `data` as scipy.signal.stft lays them out: `size / 2` zeros on both sides, zero-padded to whole hops. */
function framing(length: number, size: number, hop: number) {
  const padded = length + size
  const extra = ((-(padded - size) % hop) + hop) % hop
  return { offset: size / 2, frames: Math.floor((padded + extra - size) / hop) + 1 }
}

/**
 * Power spectrogram |Z|² (scipy "spectrum" scaling: the FFT of the windowed frame / Σwindow), frame-major:
 * `power[t * bins + k]`, k = 0 … size / 2.
 */
export function spectrogram(data: Float32Array, size: number, hop: number): { bins: number; frames: number; power: Float32Array } {
  const window = hann(size), scale = 1 / window.reduce((a, b) => a + b, 0)
  const { offset, frames } = framing(data.length, size, hop)
  const bins = size / 2 + 1, power = new Float32Array(bins * frames)
  const re = new Float64Array(size), im = new Float64Array(size)
  for (let t = 0; t < frames; t++) {
    const start = t * hop - offset
    for (let n = 0; n < size; n++) { const i = start + n; re[n] = i >= 0 && i < data.length ? data[i] * window[n] : 0; im[n] = 0 }
    fft(re, im, false)
    for (let k = 0; k < bins; k++) power[t * bins + k] = (re[k] * re[k] + im[k] * im[k]) * scale * scale
  }
  return { bins, frames, power }
}

/** numpy.percentile (linear) of `values` (sorted in place). */
function percentileOf(values: Float64Array, p: number): number {
  values.sort()
  const pos = (values.length - 1) * p / 100, lo = Math.floor(pos), hi = Math.min(values.length - 1, lo + 1)
  return values[lo] + (values[hi] - values[lo]) * (pos - lo)
}

/** 3-point moving average along one axis of a frame-major matrix, edges repeated (ndimage.uniform_filter, reflect). */
function smooth3(m: Float32Array, bins: number, frames: number, alongBins: boolean) {
  const out = new Float32Array(m.length)
  for (let t = 0; t < frames; t++) for (let k = 0; k < bins; k++) {
    const at = (tt: number, kk: number) => m[Math.min(frames - 1, Math.max(0, tt)) * bins + Math.min(bins - 1, Math.max(0, kk))]
    out[t * bins + k] = alongBins ? (at(t, k - 1) + at(t, k) + at(t, k + 1)) / 3 : (at(t - 1, k) + at(t, k) + at(t + 1, k)) / 3
  }
  return out
}

/** The spectral gate of one channel: mask from the magnitudes, then STFT × mask → overlap-add (scipy istft). */
function denoiseChannel(data: Float32Array, sampleRate: number, settings: SpectralDenoiseSettings): Float32Array {
  const size = denoiseFftSize(sampleRate), hop = size / 4
  const { bins, frames, power } = spectrogram(data, size, hop)
  // Noise floor per bin, then the mask (in place over the magnitudes).
  const mask = power
  for (let i = 0; i < mask.length; i++) mask[i] = Math.sqrt(mask[i])
  const column = new Float64Array(frames)
  for (let k = 0; k < bins; k++) {
    for (let t = 0; t < frames; t++) column[t] = mask[t * bins + k]
    const gate = (percentileOf(column, settings.percentile) + 1e-12) * settings.thresholdK
    for (let t = 0; t < frames; t++) mask[t * bins + k] = Math.min(1, Math.max(0, mask[t * bins + k] / gate - 1))
  }
  const smoothed = smooth3(smooth3(mask, bins, frames, true), bins, frames, false)
  const floor = 10 ** (settings.floorDb / 20)
  // Resynthesis: the windowed frames × gain, inverse FFT, overlap-add with the window, ÷ Σwindow².
  const window = hann(size), { offset } = framing(data.length, size, hop)
  const total = (frames - 1) * hop + size
  const out = new Float64Array(total), norm = new Float64Array(total)
  const re = new Float64Array(size), im = new Float64Array(size)
  for (let t = 0; t < frames; t++) {
    const start = t * hop - offset
    for (let n = 0; n < size; n++) { const i = start + n; re[n] = i >= 0 && i < data.length ? data[i] * window[n] : 0; im[n] = 0 }
    fft(re, im, false)
    for (let k = 0; k < bins; k++) {
      const g = floor + (1 - floor) * smoothed[t * bins + k]
      re[k] *= g; im[k] *= g
      if (k > 0 && k < size / 2) { re[size - k] *= g; im[size - k] *= g }
    }
    fft(re, im, true)
    for (let n = 0; n < size; n++) { out[t * hop + n] += re[n] * window[n]; norm[t * hop + n] += window[n] * window[n] }
  }
  const result = new Float32Array(data.length)
  for (let i = 0; i < data.length; i++) { const j = i + offset; result[i] = norm[j] > 1e-10 ? out[j] / norm[j] : 0 }
  return result
}

export function spectralDenoise(channels: Float32Array[], sampleRate: number, settings: SpectralDenoiseSettings): Float32Array[] {
  return channels.map(ch => ch.length ? denoiseChannel(ch, sampleRate, settings) : ch.slice())
}

/** The kept range [start, stop) of isolateHit (samples), or null when there is nothing to cut. */
export function hitRange(channels: Float32Array[], sampleRate: number, settings: Omit<IsolateHitSettings, 'fadeMs'>): { start: number; stop: number; onsets: number } | null {
  const length = channels[0]?.length ?? 0
  if (!length) return null
  const mono = new Float32Array(length)
  for (const ch of channels) for (let i = 0; i < length; i++) mono[i] += ch[i] / channels.length
  const env = amplitudeEnvelope(mono, sampleRate, ONSET_WINDOW_MS)
  let top = 0
  for (let i = 1; i < length; i++) if (env[i] > env[top]) top = i
  if (!(env[top] > 0)) return null
  const ms = (v: number) => Math.round(sampleRate * v / 1000)
  // Attacks within 30 dB of the peak, at most one per 40 ms.
  const onsets = detectOnsets(mono, sampleRate, { thresholdDb: -30, minGapMs: 40, riseDb: settings.riseDb }, 1000)
  const first = onsets.find(o => o.peak <= top + ms(10))
  const start = first ? Math.max(0, first.peak - ms(20) - ms(2)) : 0
  let stop = length
  const floor = env[top] * 10 ** (settings.endDb / 20)
  for (let i = top; i < length; i++) if (env[i] < floor) { stop = Math.min(stop, i + ms(10)); break }
  const later = onsets.find(o => o.peak > top + ms(60))
  if (later) stop = Math.min(stop, later.peak - ms(25))
  return stop > start ? { start, stop, onsets: onsets.length } : null
}

export function isolateHit(channels: Float32Array[], sampleRate: number, settings: IsolateHitSettings): Float32Array[] {
  const range = hitRange(channels, sampleRate, settings)
  if (!range) return channels.map(ch => ch.slice())
  const n = Math.min(Math.floor((range.stop - range.start) / 3), Math.round(sampleRate * settings.fadeMs / 1000))
  return channels.map(ch => {
    const out = ch.slice(range.start, range.stop)
    // Fade-out (1 → 0 over n samples, squared), as numpy.linspace(1, 0, n) ** 2.
    for (let i = 0; i < n; i++) { const g = n > 1 ? 1 - i / (n - 1) : 0; out[out.length - n + i] *= g * g }
    return out
  })
}
