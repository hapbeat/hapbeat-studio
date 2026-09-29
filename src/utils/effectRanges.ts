import type { EffectType, EnvelopePoint } from '@/types/waveform'

/**
 * Single source of numeric ranges / enums for effect and recipe parameters.
 * Project validation (`validateEffectParams`), the effect sliders and the
 * agent catalog all read these constants so the three never disagree.
 */
export interface ParamRange {
  min?: number
  max?: number
  step?: number
  unit?: string
  enum?: readonly string[]
  /** Allowed numeric values (e.g. sample rates). */
  values?: readonly number[]
  /** `integer`: must be a whole number. `boolean`: true / false, no numeric range. */
  kind?: 'integer' | 'boolean'
}

export const AM_SHAPES = ['sine', 'square', 'triangle', 'random'] as const
export const NOISE_COLORS = ['white', 'pink', 'brown'] as const
export const SATURATE_MODES = ['soft', 'hard', 'fold'] as const
export const MONO_METHODS = ['average', 'left', 'right'] as const
export const SEED_RANGE: ParamRange = { min: 0, max: 2147483647, step: 1, kind: 'integer' }

const FILTER: Record<string, ParamRange> = {
  frequency: { min: 20, max: 20000, unit: 'Hz' },
  Q: { min: 0.1, max: 20, step: 0.1 },
}
const FADE: Record<string, ParamRange> = { durationMs: { min: 0, max: 600000, step: 1, unit: 'ms' } }
const SEMITONES: Record<string, ParamRange> = { semitones: { min: -24, max: 24, step: 1, unit: 'st' } }

/** Envelope / EQ entries describe per-point / per-band fields of their arrays. */
export const EFFECT_RANGES: Record<EffectType, Record<string, ParamRange>> = {
  'trim': { start: { min: 0, unit: 's' }, end: { min: 0, unit: 's' } },
  'cut': { start: { min: 0, unit: 's' }, end: { min: 0, unit: 's' } },
  'repitch': SEMITONES,
  'pitch-shift': SEMITONES,
  'time-stretch': { rate: { min: 0.25, max: 4, step: 0.05, unit: 'x' } },
  'noise-gate': {
    thresholdDb: { min: -80, max: 0, step: 1, unit: 'dB' },
    attackMs: { min: 0.1, max: 100, step: 0.1, unit: 'ms' },
    releaseMs: { min: 1, max: 1000, step: 1, unit: 'ms' },
  },
  'lpf': FILTER,
  'hpf': FILTER,
  'bpf': FILTER,
  'eq': {
    frequency: { min: 20, max: 20000, unit: 'Hz' },
    gain: { min: -24, max: 24, step: 0.5, unit: 'dB' },
    Q: { min: 0.1, max: 20, step: 0.1 },
  },
  'envelope': { time: { min: 0, max: 1 }, value: { min: 0, max: 1 } },
  'normalize': { targetPeak: { min: 0, max: 1, step: 0.01 } },
  'fade-in': FADE,
  'fade-out': FADE,
  'gain': { gainDb: { min: -60, max: 20, step: 0.5, unit: 'dB' } },
  'reverse': {},
  'mono-convert': { method: { enum: MONO_METHODS } },
  'am': {
    rateHz: { min: 0.5, max: 100, step: 0.1, unit: 'Hz' },
    depth: { min: 0, max: 1, step: 0.01 },
    shape: { enum: AM_SHAPES },
    jitter: { min: 0, max: 1, step: 0.01 },
    seed: SEED_RANGE,
  },
  'noise-mix': {
    levelDb: { min: -60, max: 12, step: 0.5, unit: 'dB' },
    lowHz: { min: 10, max: 2000, unit: 'Hz' },
    highHz: { min: 20, max: 4000, unit: 'Hz' },
    color: { enum: NOISE_COLORS },
    follow: { kind: 'boolean' },
    seed: SEED_RANGE,
  },
  'freq-shift': { shiftHz: { min: -1000, max: 1000, step: 1, unit: 'Hz' } },
  'compressor': {
    thresholdDb: { min: -60, max: 0, step: 0.5, unit: 'dB' },
    ratio: { min: 1, max: 20, step: 0.1 },
    attackMs: { min: 0.1, max: 200, step: 0.1, unit: 'ms' },
    releaseMs: { min: 1, max: 2000, step: 1, unit: 'ms' },
    kneeDb: { min: 0, max: 24, step: 0.5, unit: 'dB' },
    makeupDb: { min: 0, max: 24, step: 0.5, unit: 'dB' },
  },
  'saturate': {
    driveDb: { min: 0, max: 36, step: 0.5, unit: 'dB' },
    mode: { enum: SATURATE_MODES },
    mix: { min: 0, max: 1, step: 0.01 },
    outputDb: { min: -24, max: 6, step: 0.5, unit: 'dB' },
  },
}

const TONE_SOURCE: Record<string, ParamRange> = {
  freqHz: { min: 5, max: 2000, unit: 'Hz' },
  freqEndHz: { min: 5, max: 2000, unit: 'Hz' },
}

/** Ranges of `hapbeat-recipe@1`. `layer.am` uses the `am` effect ranges without `seed`. */
export const RECIPE_RANGES = {
  recipe: {
    sampleRate: { values: [16000, 24000, 44100, 48000] },
    durationSec: { min: 0.02, max: 30, unit: 's' },
    seed: SEED_RANGE,
    layers: { min: 1, max: 8, kind: 'integer' },
  },
  layer: {
    gainDb: { min: -60, max: 12, unit: 'dB' },
    startSec: { min: 0, unit: 's' },
    durationSec: { min: 0.001, max: 30, unit: 's' },
    fadeMs: { min: 0, max: 1000, unit: 'ms' },
  },
  sources: {
    'sine': TONE_SOURCE,
    'square': TONE_SOURCE,
    'triangle': TONE_SOURCE,
    'noise': {
      color: { enum: NOISE_COLORS },
      lowHz: { min: 10, max: 2000, unit: 'Hz' },
      highHz: { min: 20, max: 4000, unit: 'Hz' },
    },
    'decaying-sine': {
      freqHz: { min: 5, max: 2000, unit: 'Hz' },
      decayMs: { min: 1, max: 5000, unit: 'ms' },
    },
    'impulse-train': {
      rateHz: { min: 0.5, max: 200, unit: 'Hz' },
      jitter: { min: 0, max: 1 },
      amplitudeJitter: { min: 0, max: 1 },
      'pulse.freqHz': { min: 5, max: 2000, unit: 'Hz' },
      'pulse.decayMs': { min: 1, max: 5000, unit: 'ms' },
    },
  },
  am: {
    rateHz: EFFECT_RANGES.am.rateHz,
    depth: EFFECT_RANGES.am.depth,
    shape: EFFECT_RANGES.am.shape,
    jitter: EFFECT_RANGES.am.jitter,
  },
} as const satisfies {
  recipe: Record<string, ParamRange>
  layer: Record<string, ParamRange>
  sources: Record<string, Record<string, ParamRange>>
  am: Record<string, ParamRange>
}

/** True when `value` satisfies `range` (numbers are finite; enums / booleans by membership). */
export function inRange(value: unknown, range: ParamRange): boolean {
  if (range.kind === 'boolean') return typeof value === 'boolean'
  if (range.enum) return typeof value === 'string' && range.enum.includes(value)
  if (typeof value !== 'number' || !Number.isFinite(value)) return false
  if (range.values) return range.values.includes(value)
  if (range.kind === 'integer' && !Number.isInteger(value)) return false
  return (range.min === undefined || value >= range.min) && (range.max === undefined || value <= range.max)
}

export const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/** Envelope point list shared by the `envelope` effect and recipe layers. */
export function isEnvelope(value: unknown): value is EnvelopePoint[] {
  const { time, value: level } = EFFECT_RANGES.envelope
  return Array.isArray(value) && value.length >= 2 && value.every((v: unknown, i: number) => isRecord(v) && inRange(v.time, time) && inRange(v.value, level) && (i === 0 || (v.time as number) > value[i - 1].time)) && value[0].time === 0 && value[value.length - 1].time === 1
}
