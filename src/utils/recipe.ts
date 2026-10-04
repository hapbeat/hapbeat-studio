/**
 * `hapbeat-recipe@1`: a JSON description of a generated haptic waveform.
 * Rendering is fully deterministic (same JSON → same samples); every random
 * choice derives from `recipe.seed` and the layer index.
 */
import type { AmShape, EnvelopePoint, NoiseColor, SampleRate } from '@/types/waveform'
import { inRange, isEnvelope, isRecord, RECIPE_RANGES, type ParamRange } from './effectRanges'
import { amGain, amplitudeEnvelope, applyEnvelopeInPlace, bandNoise, detectOnsets, mulberry32 } from './textureDsp'
import { mixToMono } from './hapticFeatures'

/** Audio material of a `sample` layer: a file below `hapbeat-agent/` or an editor clip. */
export type RecipeSampleRef =
  | { kind: 'file'; path: string }
  | { kind: 'clip'; clipId: string; use?: 'original' | 'working' }

/** Synthesized sources that can also serve as a `follow` carrier or an `onsets` hit. */
export type RecipeSynthSource =
  | { type: 'sine' | 'square' | 'triangle'; freqHz: number; freqEndHz?: number }
  | { type: 'noise'; color: NoiseColor; lowHz?: number; highHz?: number }
  | { type: 'decaying-sine'; freqHz: number; decayMs: number }
export const SYNTH_SOURCE_TYPES = ['sine', 'square', 'triangle', 'noise', 'decaying-sine'] as const

/** Sound → haptic: the material's amplitude envelope (moving RMS over `smoothMs`, default 10 ms) × a synthesized carrier. */
export interface RecipeFollow { mode: 'envelope'; smoothMs?: number; carrier: RecipeSynthSource }
/**
 * Sound → haptic: onsets detected in the material (the 5 ms level above `thresholdDb` re its peak,
 * risen by `riseDb` (default 6) within 20 ms, at most one per `minGapMs`), each replaced by `hit`
 * (a sample ref or a synth source, `hitSec` long; default the whole ref / 0.15 s) scaled by the level there.
 */
export interface RecipeOnsets { auto: { thresholdDb: number; minGapMs: number; riseDb?: number }; hit: RecipeSampleRef | RecipeSynthSource; hitSec?: number }

export type RecipeSource =
  | RecipeSynthSource
  | { type: 'impulse-train'; rateHz: number; jitter?: number; amplitudeJitter?: number; pulse: { freqHz: number; decayMs: number } }
  | { type: 'sample'; ref: RecipeSampleRef; rate?: number; onsetsSec?: number[]; gainsDb?: number[]; maxSec?: number; follow?: RecipeFollow; onsets?: RecipeOnsets }

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

/** Decoded mono material of the sample layers, keyed by `sampleRefKey(ref)`. */
export type RecipeSamples = ReadonlyMap<string, { data: Float32Array; sampleRate: number }>

export const RECIPE_FORMAT = 'hapbeat-recipe@1'
/** Maximum number of copies (onsets) in one sample layer. */
const MAX_SAMPLE_ONSETS = 64
const DEFAULT_FADE_MS = 2
/** Noise sources are scaled to the RMS of a full-scale sine so 0 dB layers are comparable. */
const NOISE_RMS = Math.SQRT1_2
/** Pulses are truncated once their decay reaches −80 dB (e^−9.21). */
const PULSE_TAIL_TAUS = 9.21
const DEFAULT_FOLLOW_SMOOTH_MS = 10
const DEFAULT_ONSET_RISE_DB = 6
const DEFAULT_SYNTH_HIT_SEC = 0.15

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

/** Relative path under `hapbeat-agent/`: forward slashes, no `..`, no absolute / drive paths. */
export function isSafeAgentPath(path: unknown): path is string {
  if (typeof path !== 'string' || !path || path.length > 260 || path.startsWith('/') || /[\\:\x00-\x1f]/.test(path)) return false
  return path.split('/').every(part => part !== '' && part !== '.' && part !== '..')
}

function validateSampleRef(ref: unknown, where: string): string | null {
  if (!isRecord(ref)) return `${where} must be an object { kind: "file", path } or { kind: "clip", clipId, use? }`
  if (ref.kind !== 'file' && ref.kind !== 'clip') return `${where}.kind must be "file" or "clip"`
  for (const key of Object.keys(ref)) {
    if (!(ref.kind === 'file' ? ['kind', 'path'] : ['kind', 'clipId', 'use']).includes(key)) return `${where}: unknown field "${key}"`
  }
  if (ref.kind === 'file') return isSafeAgentPath(ref.path) ? null : `${where}.path must be a relative path inside hapbeat-agent/ (for example "sources/tap.wav"); ".." and absolute paths are not allowed`
  if (typeof ref.clipId !== 'string' || !ref.clipId) return `${where}.clipId must be a non-empty string`
  return ref.use === undefined || ref.use === 'original' || ref.use === 'working' ? null : `${where}.use must be "original" or "working"`
}

/** A synthesized source (follow carrier / onset hit). */
function validateSynth(source: unknown, where: string): string | null {
  if (!isRecord(source) || !(SYNTH_SOURCE_TYPES as readonly unknown[]).includes(source.type)) return `${where}.type must be one of ${SYNTH_SOURCE_TYPES.join(', ')}`
  return validateSource(source, where)
}

function validateFollow(follow: unknown, where: string): string | null {
  if (!isRecord(follow)) return `${where} must be an object { mode: "envelope", smoothMs?, carrier }`
  return checkFields(follow, where, RECIPE_RANGES.sampleFollow, ['mode'], ['carrier'])
    ?? (follow.carrier === undefined ? `${where}.carrier is required` : validateSynth(follow.carrier, `${where}.carrier`))
}

function validateOnsets(onsets: unknown, where: string): string | null {
  if (!isRecord(onsets)) return `${where} must be an object { auto: { thresholdDb, minGapMs, riseDb? }, hit, hitSec? }`
  const r = RECIPE_RANGES.sampleOnsets
  const error = checkFields(onsets, where, { hitSec: r.hitSec }, [], ['auto', 'hit'])
  if (error) return error
  if (!isRecord(onsets.auto)) return `${where}.auto must be an object { thresholdDb, minGapMs, riseDb? }`
  const autoError = checkFields(onsets.auto, `${where}.auto`, { thresholdDb: r['auto.thresholdDb'], minGapMs: r['auto.minGapMs'], riseDb: r['auto.riseDb'] }, ['thresholdDb', 'minGapMs'])
  if (autoError) return autoError
  if (onsets.hit === undefined) return `${where}.hit is required (a sample ref { kind: "file" | "clip", … } or a synth source { type: … })`
  return isRecord(onsets.hit) && 'kind' in onsets.hit ? validateSampleRef(onsets.hit, `${where}.hit`) : validateSynth(onsets.hit, `${where}.hit`)
}

function validateSample(source: Record<string, unknown>, where: string, ranges: Record<string, ParamRange>): string | null {
  const error = checkFields(source, where, ranges, [], ['type', 'ref', 'onsetsSec', 'gainsDb', 'follow', 'onsets']) ?? validateSampleRef(source.ref, `${where}.ref`)
  if (error) return error
  if (source.follow !== undefined && source.onsets !== undefined) return `${where}: use either follow or onsets, not both`
  if (source.onsets !== undefined && (source.onsetsSec !== undefined || source.gainsDb !== undefined)) return `${where}: onsets (detected) cannot be combined with onsetsSec / gainsDb`
  const extraError = (source.follow === undefined ? null : validateFollow(source.follow, `${where}.follow`)) ?? (source.onsets === undefined ? null : validateOnsets(source.onsets, `${where}.onsets`))
  if (extraError) return extraError
  const { onsetsSec, gainsDb } = source
  if (onsetsSec !== undefined) {
    if (!Array.isArray(onsetsSec) || onsetsSec.length < 1 || onsetsSec.length > MAX_SAMPLE_ONSETS) return `${where}.onsetsSec must be an array of 1–${MAX_SAMPLE_ONSETS} start times (s)`
    for (let i = 0; i < onsetsSec.length; i++) {
      const t: unknown = onsetsSec[i]
      if (typeof t !== 'number' || !Number.isFinite(t) || t < 0) return `${where}.onsetsSec[${i}] must be a number >= 0`
      if (i > 0 && t < onsetsSec[i - 1]) return `${where}.onsetsSec must be non-decreasing`
    }
  }
  if (gainsDb !== undefined) {
    const count = Array.isArray(onsetsSec) ? onsetsSec.length : 1
    if (!Array.isArray(gainsDb) || gainsDb.length !== count) return `${where}.gainsDb must be an array with one value per onsetsSec entry (${count})`
    const range = RECIPE_RANGES.layer.gainDb
    for (let i = 0; i < gainsDb.length; i++) {
      if (!inRange(gainsDb[i], range)) return `${where}.gainsDb[${i}] is out of range (${describe(range)})`
    }
  }
  return null
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
    case 'sample':
      return validateSample(source, where, ranges)
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

/** Stable key of a sample ref in `RecipeSamples`. */
export function sampleRefKey(ref: RecipeSampleRef): string {
  return ref.kind === 'file' ? `file:${ref.path}` : `clip:${ref.clipId}:${ref.use ?? 'original'}`
}

/** Linear-interpolation resample; `step` is the source-sample advance per output sample. */
function resampleLinear(data: Float32Array, step: number): Float32Array {
  if (data.length === 0) return data
  const out = new Float32Array(Math.floor((data.length - 1) / step) + 1)
  for (let i = 0; i < out.length; i++) {
    const pos = i * step, j = Math.floor(pos), frac = pos - j
    out[i] = j + 1 < data.length ? data[j] + (data[j + 1] - data[j]) * frac : data[j]
  }
  return out
}

/** A sample ref's material at the output rate (× `rate`), or an Error naming what is missing. */
function material(ref: RecipeSampleRef, rate: number, sampleRate: number, samples: RecipeSamples): Float32Array {
  const key = sampleRefKey(ref)
  const sample = samples.get(key)
  if (!sample) throw new Error(`Sample layer audio "${key}" is not loaded (${ref.kind === 'file' ? `hapbeat-agent/${ref.path}` : `editor clip "${ref.clipId}"`})`)
  return resampleLinear(sample.data, (sample.sampleRate * rate) / sampleRate)
}

function fadeOutInPlace(data: Float32Array, sampleRate: number, fadeMs: number) {
  const fade = Math.min(Math.floor(data.length / 2), Math.round((fadeMs / 1000) * sampleRate))
  for (let i = 0; i < fade; i++) data[data.length - 1 - i] *= i / fade
}
/** The first `seconds` of `data` (all when undefined), with a `fadeMs` fade-out when cut. */
function cutWithFade(data: Float32Array, seconds: number | undefined, sampleRate: number, fadeMs: number): Float32Array {
  const cut = seconds === undefined ? data.length : Math.min(data.length, Math.round(seconds * sampleRate))
  const copy = data.slice(0, cut)
  if (cut < data.length) fadeOutInPlace(copy, sampleRate, fadeMs)
  return copy
}

/** Adds `copy` × gain at each (start, gain); copies past the end are clipped. */
function place(out: Float32Array, copy: Float32Array, starts: { start: number; gain: number }[]) {
  for (const { start, gain } of starts) {
    const end = Math.min(out.length, start + copy.length)
    for (let i = start; i < end; i++) out[i] += copy[i - start] * gain
  }
}

/**
 * Places one (optionally truncated) copy of the material at each onset (copies
 * past the layer end are clipped). With `follow`, the result's amplitude
 * envelope modulates a synthesized carrier instead; with `onsets`, the onsets
 * detected in the material are each replaced by `hit`.
 */
function renderSample(source: Extract<RecipeSource, { type: 'sample' }>, length: number, sampleRate: number, seed: number, samples: RecipeSamples, fadeMs: number): Float32Array {
  const data = material(source.ref, source.rate ?? 1, sampleRate, samples)
  const out = new Float32Array(length)
  if (source.onsets) {
    const { auto, hit, hitSec } = source.onsets
    const found = detectOnsets(data.subarray(0, length), sampleRate, { thresholdDb: auto.thresholdDb, minGapMs: auto.minGapMs, riseDb: auto.riseDb ?? DEFAULT_ONSET_RISE_DB }, MAX_SAMPLE_ONSETS)
    let copy: Float32Array
    if ('kind' in hit) copy = cutWithFade(material(hit, 1, sampleRate, samples), hitSec, sampleRate, fadeMs)
    else { copy = renderSource(hit, Math.max(1, Math.round((hitSec ?? DEFAULT_SYNTH_HIT_SEC) * sampleRate)), sampleRate, seed, samples, fadeMs); fadeOutInPlace(copy, sampleRate, fadeMs) }
    place(out, copy, found.map(o => ({ start: o.index, gain: o.level })))
    return out
  }
  const copy = cutWithFade(data, source.maxSec, sampleRate, fadeMs)
  place(out, copy, (source.onsetsSec ?? [0]).map((onsetSec, k) => ({ start: Math.round(onsetSec * sampleRate), gain: 10 ** ((source.gainsDb?.[k] ?? 0) / 20) })))
  if (!source.follow) return out
  const envelope = amplitudeEnvelope(out, sampleRate, source.follow.smoothMs ?? DEFAULT_FOLLOW_SMOOTH_MS)
  const carrier = renderSource(source.follow.carrier, length, sampleRate, seed, samples, fadeMs)
  for (let i = 0; i < length; i++) out[i] = envelope[i] * carrier[i]
  return out
}

function renderSource(source: RecipeSource, length: number, sampleRate: number, seed: number, samples: RecipeSamples, fadeMs: number): Float32Array {
  switch (source.type) {
    case 'sample':
      return renderSample(source, length, sampleRate, seed, samples, fadeMs)
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

/**
 * Deterministic mono render: the same recipe (and sample material) always yields the same samples.
 * `samples` must hold every sample layer's ref (see loadRecipeSamples); a missing ref throws.
 */
export function renderRecipe(recipe: Recipe, samples: RecipeSamples = new Map()): RenderedRecipe {
  const { sampleRate } = recipe
  const total = Math.max(1, Math.round(recipe.durationSec * sampleRate))
  const mix = new Float32Array(total)
  recipe.layers.forEach((layer, index) => {
    const start = Math.round((layer.startSec ?? 0) * sampleRate)
    const available = total - start
    const length = Math.min(available, layer.durationSec === undefined ? available : Math.round(layer.durationSec * sampleRate))
    if (length <= 0) return
    const fadeMs = layer.fadeMs ?? DEFAULT_FADE_MS
    const data = renderSource(layer.source, length, sampleRate, sourceSeed(recipe.seed, index), samples, fadeMs)
    if (layer.am) {
      const gain = amGain(length, sampleRate, { ...layer.am, jitter: layer.am.jitter ?? 0 }, recipe.seed + index)
      for (let i = 0; i < length; i++) data[i] *= gain[i]
    }
    if (layer.envelope) applyEnvelopeInPlace(data, layer.envelope)
    const fade = Math.min(Math.floor(length / 2), Math.round((fadeMs / 1000) * sampleRate))
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

export interface RecipeSampleLoader {
  /** Bytes of a file below `hapbeat-agent/`; throws a descriptive Error when it cannot be read. */
  readAgentFile: (path: string) => Promise<ArrayBuffer>
  getClip: (clipId: string, use: 'original' | 'working') => AudioBuffer | null
  decodeAudio: (bytes: ArrayBuffer) => Promise<AudioBuffer>
}

/** Loads (and mixes to mono) the material of every sample layer, keyed for renderRecipe. */
export async function loadRecipeSamples(recipe: Recipe, loader: RecipeSampleLoader): Promise<RecipeSamples> {
  const samples = new Map<string, { data: Float32Array; sampleRate: number }>()
  const refs = recipe.layers.flatMap(({ source }) => source.type !== 'sample' ? []
    : [source.ref, ...(source.onsets && 'kind' in source.onsets.hit ? [source.onsets.hit] : [])])
  for (const ref of refs) {
    const key = sampleRefKey(ref)
    if (samples.has(key)) continue
    let buffer: AudioBuffer
    if (ref.kind === 'file') buffer = await loader.decodeAudio(await loader.readAgentFile(ref.path))
    else {
      const clip = loader.getClip(ref.clipId, ref.use ?? 'original')
      if (!clip) throw new Error(`Sample layer clip "${ref.clipId}" is not in the editor`)
      buffer = clip
    }
    samples.set(key, { data: mixToMono(Array.from({ length: buffer.numberOfChannels }, (_, ch) => buffer.getChannelData(ch))), sampleRate: buffer.sampleRate })
  }
  return samples
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
