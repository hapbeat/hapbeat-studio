/**
 * `hapbeat-recipe@1`: a JSON description of a generated haptic waveform.
 * Rendering is fully deterministic (same JSON → same samples); every random
 * choice derives from `recipe.seed` and the layer index.
 */
import type { AmShape, EnvelopePoint, NoiseColor, SampleRate } from '@/types/waveform'
import { inRange, isEnvelope, isRecord, RECIPE_RANGES, type ParamRange } from './effectRanges'
import { amGain, applyEnvelopeInPlace, bandNoise, mulberry32 } from './textureDsp'

export type RecipeSource =
  | { type: 'sine' | 'square' | 'triangle'; freqHz: number; freqEndHz?: number }
  | { type: 'noise'; color: NoiseColor; lowHz?: number; highHz?: number }
  | { type: 'decaying-sine'; freqHz: number; decayMs: number }
  | { type: 'impulse-train'; rateHz: number; jitter?: number; amplitudeJitter?: number; pulse: { freqHz: number; decayMs: number } }

export interface RecipeAm { rateHz: number; depth: number; shape: AmShape; jitter?: number }

export interface RecipeLayer {
  source: RecipeSource
  gainDb?: number
  startSec?: number
  durationSec?: number
  am?: RecipeAm
  envelope?: EnvelopePoint[]
  fadeMs?: number
}

export interface Recipe {
  format: 'hapbeat-recipe@1'
  sampleRate: SampleRate
  durationSec: number
  seed: number
  layers: RecipeLayer[]
}

export interface RenderedRecipe {
  data: Float32Array
  sampleRate: number
  /** Present when the mix peaked above 1.0 and was scaled to 0.98. */
  normalizedDb?: number
}

export const RECIPE_FORMAT = 'hapbeat-recipe@1'
const DEFAULT_FADE_MS = 2
/** Noise sources are scaled to the RMS of a full-scale sine so 0 dB layers are comparable. */
const NOISE_RMS = Math.SQRT1_2
/** Pulses are truncated once their decay reaches −80 dB (e^−9.21). */
const PULSE_TAIL_TAUS = 9.21

/** Checks `obj` against `ranges`; `required` keys must exist, others are optional; unknown keys are rejected. */
function checkFields(obj: Record<string, unknown>, where: string, ranges: Record<string, ParamRange>, required: string[], extra: string[] = []): string | null {
  for (const key of Object.keys(obj)) {
    if (!(key in ranges) && !extra.includes(key)) return `${where}: unknown field "${key}"`
  }
  for (const [key, range] of Object.entries(ranges)) {
    if (key.includes('.')) continue
    if (obj[key] === undefined) {
      if (required.includes(key)) return `${where}.${key} is required`
      continue
    }
    if (!inRange(obj[key], range)) return `${where}.${key} is out of range (${describe(range)})`
  }
  return null
}

function describe(range: ParamRange): string {
  if (range.enum) return `one of ${range.enum.join(', ')}`
  if (range.values) return `one of ${range.values.join(', ')}`
  if (range.kind === 'boolean') return 'true or false'
  const parts = [range.min !== undefined ? `>= ${range.min}` : '', range.max !== undefined ? `<= ${range.max}` : ''].filter(Boolean)
  return `${range.kind === 'integer' ? 'integer ' : ''}${parts.join(' and ')}${range.unit ? ` ${range.unit}` : ''}`
}

function validateSource(source: unknown, where: string): string | null {
  if (!isRecord(source)) return `${where} must be an object`
  const type = source.type
  if (typeof type !== 'string' || !Object.prototype.hasOwnProperty.call(RECIPE_RANGES.sources, type)) {
    return `${where}.type must be one of ${Object.keys(RECIPE_RANGES.sources).join(', ')}`
  }
  const ranges: Record<string, ParamRange> = RECIPE_RANGES.sources[type as keyof typeof RECIPE_RANGES.sources]
  switch (type) {
    case 'sine': case 'square': case 'triangle':
      return checkFields(source, where, ranges, ['freqHz'], ['type'])
    case 'noise': {
      const error = checkFields(source, where, ranges, ['color'], ['type'])
      if (error) return error
      if (source.lowHz !== undefined && source.highHz !== undefined && (source.highHz as number) <= (source.lowHz as number)) return `${where}.highHz must be greater than lowHz`
      return null
    }
    case 'decaying-sine':
      return checkFields(source, where, ranges, ['freqHz', 'decayMs'], ['type'])
    default: {
      const error = checkFields(source, where, ranges, ['rateHz'], ['type', 'pulse'])
      if (error) return error
      if (!isRecord(source.pulse)) return `${where}.pulse must be an object { freqHz, decayMs }`
      return checkFields(source.pulse, `${where}.pulse`, { freqHz: ranges['pulse.freqHz'], decayMs: ranges['pulse.decayMs'] }, ['freqHz', 'decayMs'])
    }
  }
}

/** Returns an English error message, or null when `value` is a valid `hapbeat-recipe@1`. */
export function validateRecipe(value: unknown): string | null {
  if (!isRecord(value)) return 'recipe must be a JSON object'
  if (value.format !== RECIPE_FORMAT) return `recipe.format must be "${RECIPE_FORMAT}"`
  const { layers, ...top } = RECIPE_RANGES.recipe
  const error = checkFields(value, 'recipe', top, ['sampleRate', 'durationSec', 'seed'], ['format', 'layers'])
  if (error) return error
  if (!Array.isArray(value.layers) || !inRange(value.layers.length, layers)) return `recipe.layers must be an array of ${layers.min}–${layers.max} layers`
  const duration = value.durationSec as number
  for (let i = 0; i < value.layers.length; i++) {
    const layer: unknown = value.layers[i]
    const where = `recipe.layers[${i}]`
    if (!isRecord(layer)) return `${where} must be an object`
    const layerError = checkFields(layer, where, RECIPE_RANGES.layer, [], ['source', 'am', 'envelope'])
      ?? validateSource(layer.source, `${where}.source`)
      ?? (layer.am === undefined ? null : isRecord(layer.am) ? checkFields(layer.am, `${where}.am`, RECIPE_RANGES.am, ['rateHz', 'depth', 'shape']) : `${where}.am must be an object`)
    if (layerError) return layerError
    if (layer.envelope !== undefined && !isEnvelope(layer.envelope)) return `${where}.envelope must be points [{time, value}] with time strictly increasing from 0 to 1 and value 0–1`
    if (((layer.startSec as number | undefined) ?? 0) >= duration) return `${where}.startSec must be less than recipe.durationSec`
  }
  return null
}

// ---- Rendering ----

/** Tone with an optional exponential sweep from freqHz to freqEndHz over the layer. */
function renderTone(length: number, sampleRate: number, type: 'sine' | 'square' | 'triangle', freqHz: number, freqEndHz = freqHz): Float32Array {
  const out = new Float32Array(length)
  const ratio = freqEndHz / freqHz
  let phase = 0
  for (let i = 0; i < length; i++) {
    const frac = phase - Math.floor(phase)
    out[i] = type === 'sine' ? Math.sin(2 * Math.PI * frac)
      : type === 'square' ? (frac < 0.5 ? 1 : -1)
      : frac < 0.25 ? 4 * frac : frac < 0.75 ? 2 - 4 * frac : 4 * frac - 4
    phase += (freqHz * ratio ** (i / Math.max(1, length - 1))) / sampleRate
  }
  return out
}

/** Adds one decaying sine starting at `start` into `out`. */
function addDecayingSine(out: Float32Array, start: number, sampleRate: number, freqHz: number, decayMs: number, amplitude: number) {
  const tau = (decayMs / 1000) * sampleRate
  const end = Math.min(out.length, start + Math.ceil(tau * PULSE_TAIL_TAUS))
  for (let i = start; i < end; i++) {
    const n = i - start
    out[i] += amplitude * Math.sin((2 * Math.PI * freqHz * n) / sampleRate) * Math.exp(-n / tau)
  }
}

/** Integer seed for a layer's source, decorrelated from the layer's AM seed (recipe seed + index). */
const sourceSeed = (seed: number, index: number) => (Math.imul(seed + index, 2654435761) + 1013904223) >>> 0

/** Onset sample indices of an impulse train (exported for tests). */
export function impulseOnsets(length: number, sampleRate: number, rateHz: number, jitter: number, random: () => number): number[] {
  const onsets: number[] = []
  let t = 0
  while (t < length) {
    onsets.push(Math.round(t))
    const interval = Math.max((1 + jitter * (random() * 2 - 1)) / rateHz, 0.1 / rateHz)
    t += interval * sampleRate
  }
  return onsets
}

function renderSource(source: RecipeSource, length: number, sampleRate: number, seed: number): Float32Array {
  switch (source.type) {
    case 'sine': case 'square': case 'triangle':
      return renderTone(length, sampleRate, source.type, source.freqHz, source.freqEndHz)
    case 'noise': {
      const noise = bandNoise(length, sampleRate, source.color, seed, source.lowHz, source.highHz)
      let sum = 0
      for (let i = 0; i < length; i++) sum += noise[i] * noise[i]
      const level = Math.sqrt(sum / Math.max(1, length))
      if (level > 0) for (let i = 0; i < length; i++) noise[i] *= NOISE_RMS / level
      return noise
    }
    case 'decaying-sine': {
      const out = new Float32Array(length)
      addDecayingSine(out, 0, sampleRate, source.freqHz, source.decayMs, 1)
      return out
    }
    case 'impulse-train': {
      const out = new Float32Array(length)
      const random = mulberry32(seed)
      const amplitudeJitter = source.amplitudeJitter ?? 0
      for (const onset of impulseOnsets(length, sampleRate, source.rateHz, source.jitter ?? 0, random)) {
        addDecayingSine(out, onset, sampleRate, source.pulse.freqHz, source.pulse.decayMs, 1 - amplitudeJitter * random())
      }
      return out
    }
  }
}

/** Deterministic mono render: the same recipe always yields the same samples. */
export function renderRecipe(recipe: Recipe): RenderedRecipe {
  const { sampleRate } = recipe
  const total = Math.max(1, Math.round(recipe.durationSec * sampleRate))
  const mix = new Float32Array(total)
  recipe.layers.forEach((layer, index) => {
    const start = Math.round((layer.startSec ?? 0) * sampleRate)
    const available = total - start
    const length = Math.min(available, layer.durationSec === undefined ? available : Math.round(layer.durationSec * sampleRate))
    if (length <= 0) return
    const data = renderSource(layer.source, length, sampleRate, sourceSeed(recipe.seed, index))
    if (layer.am) {
      const gain = amGain(length, sampleRate, { ...layer.am, jitter: layer.am.jitter ?? 0 }, recipe.seed + index)
      for (let i = 0; i < length; i++) data[i] *= gain[i]
    }
    if (layer.envelope) applyEnvelopeInPlace(data, layer.envelope)
    const fade = Math.min(Math.floor(length / 2), Math.round(((layer.fadeMs ?? DEFAULT_FADE_MS) / 1000) * sampleRate))
    for (let i = 0; i < fade; i++) {
      const g = i / fade
      data[i] *= g
      data[length - 1 - i] *= g
    }
    const gain = 10 ** ((layer.gainDb ?? 0) / 20)
    for (let i = 0; i < length; i++) mix[start + i] += data[i] * gain
  })
  let peak = 0
  for (let i = 0; i < total; i++) peak = Math.max(peak, Math.abs(mix[i]))
  if (peak <= 1) return { data: mix, sampleRate }
  const scale = 0.98 / peak
  for (let i = 0; i < total; i++) mix[i] *= scale
  return { data: mix, sampleRate, normalizedDb: 20 * Math.log10(scale) }
}

// ---- Presets (initial hypotheses; tune on real hardware) ----

export interface RecipePreset { id: string; recipe: Recipe }

const preset = (durationSec: number, ...layers: RecipeLayer[]): Recipe => ({ format: RECIPE_FORMAT, sampleRate: 48000, durationSec, seed: 1, layers })

export const RECIPE_PRESETS: RecipePreset[] = [
  { id: 'zaza', recipe: preset(2, { source: { type: 'noise', color: 'white', lowHz: 80, highHz: 400 }, am: { rateHz: 1.5, depth: 0.3, shape: 'sine' } }) },
  { id: 'buruburu', recipe: preset(1, { source: { type: 'sine', freqHz: 60 }, am: { rateHz: 8, depth: 0.9, shape: 'sine' } }) },
  { id: 'gotsun', recipe: preset(0.4, { source: { type: 'decaying-sine', freqHz: 55, decayMs: 90 } }) },
  { id: 'gowagowa', recipe: preset(1.5, { source: { type: 'noise', color: 'brown', lowHz: 50, highHz: 180 }, am: { rateHz: 18, depth: 0.8, shape: 'random', jitter: 0.5 } }) },
  { id: 'sarasara', recipe: preset(1.5, { source: { type: 'noise', color: 'white', lowHz: 200, highHz: 450 }, gainDb: -10, am: { rateHz: 40, depth: 0.2, shape: 'sine' } }) },
]
