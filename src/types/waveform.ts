/** Wave editor export rates; Kit conversion owns device format constraints. */
export type SampleRate = 16000 | 24000 | 44100 | 48000

import type { Recipe } from '@/utils/recipe'
import type { MaterialProvenance } from '@/utils/materials'

/** A loaded audio clip in working memory */
export interface WaveformClip {
  id: string
  /** User-visible name (derived from filename or "Untitled") */
  name: string
  sourceFileName?: string
  /** Shared by an imported source and all its extracted/duplicated clips. */
  sourceGroupId?: string
  /** SHA-256 of the imported source file bytes (material ledger key). Inherited by derived clips. */
  sourceSha256?: string
  /** Last helper `material_lookup` summary for `sourceSha256`. */
  provenance?: MaterialProvenance
  description?: string
  /** Optional project label used to group clips in the editor (`.hapbeat-editor/project.json`). */
  project?: string
  /** The current working AudioBuffer (post-edits, pre-export) */
  buffer: AudioBuffer
  /** Original imported buffer (never mutated, for revert) */
  originalBuffer: AudioBuffer
  /** Target sample rate for export */
  exportSampleRate: SampleRate
  /** Last rendered chain, retained independently of pending parameter edits. */
  renderedEffects?: EffectEntry[]
  /** Generator recipe the original buffer was rendered from (recipe clips only). */
  recipe?: Recipe
}

// ---- Effect types ----

export type EffectType =
  | 'trim'
  | 'cut'
  | 'repitch'
  | 'noise-gate'
  | 'pitch-shift'
  | 'time-stretch'
  | 'lpf'
  | 'hpf'
  | 'bpf'
  | 'eq'
  | 'envelope'
  | 'normalize'
  | 'fade-in'
  | 'fade-out'
  | 'gain'
  | 'reverse'
  | 'mono-convert'
  | 'am'
  | 'noise-mix'
  | 'freq-shift'
  | 'band-split'
  | 'compressor'
  | 'saturate'

export interface PitchShiftParams {
  type: 'pitch-shift'
  semitones: number // -24 to +24
}

export interface TimeStretchParams {
  type: 'time-stretch'
  rate: number // 0.25 to 4.0 (1.0 = no change)
}

export interface FilterParams {
  type: 'lpf' | 'hpf' | 'bpf'
  frequency: number // Hz
  Q: number // resonance, 0.1 to 20
}

export interface EqBand {
  frequency: number // Hz
  gain: number // dB
  Q: number
}

export interface EqParams {
  type: 'eq'
  bands: EqBand[]
}

export interface EnvelopePoint {
  time: number // 0.0 to 1.0 (normalized position)
  value: number // 0.0 to 1.0 (amplitude multiplier)
}

export interface EnvelopeParams {
  type: 'envelope'
  points: EnvelopePoint[] // sorted by time, first=0.0, last=1.0
}

export interface GainParams {
  type: 'gain'
  gainDb: number // -60 to +20 dB
}

export interface NormalizeParams {
  type: 'normalize'
  targetPeak: number // 0.0 to 1.0
}

export interface FadeParams {
  type: 'fade-in' | 'fade-out'
  durationMs: number
}

export interface ReverseParams {
  type: 'reverse'
}

export type MonoConvertMethod = 'average' | 'left' | 'right'

export interface MonoConvertParams {
  type: 'mono-convert'
  method: MonoConvertMethod
}

export type AmShape = 'sine' | 'square' | 'triangle' | 'random'
export type NoiseColor = 'white' | 'pink' | 'brown'
export type SaturateMode = 'soft' | 'hard' | 'fold'

export interface AmParams {
  type: 'am'
  rateHz: number
  depth: number // 0 to 1
  shape: AmShape
  jitter: number // 0 to 1
  seed: number // integer
}

export interface NoiseMixParams {
  type: 'noise-mix'
  levelDb: number // relative to input RMS
  lowHz: number
  highHz: number
  color: NoiseColor
  follow: boolean
  seed: number // integer
}

export interface FreqShiftParams {
  type: 'freq-shift'
  shiftHz: number
}

/** Low band passes; the high band becomes its amplitude envelope × a carrier at a frequency the actuator plays. */
export interface BandSplitParams {
  type: 'band-split'
  crossoverHz: number
  carrierHz: number
  carrierShape: 'sine' | 'square' | 'triangle'
  highGainDb: number
  smoothMs: number
}

export interface CompressorParams {
  type: 'compressor'
  thresholdDb: number
  ratio: number
  attackMs: number
  releaseMs: number
  kneeDb: number
  makeupDb: number
}

export interface SaturateParams {
  type: 'saturate'
  driveDb: number
  mode: SaturateMode
  mix: number // 0 to 1
  outputDb: number
}

export interface RepitchParams { type: 'repitch'; semitones: number }
export interface NoiseGateParams { type: 'noise-gate'; thresholdDb: number; attackMs: number; releaseMs: number }

export type EffectParams =
  | { type: 'trim' | 'cut'; start: number; end: number }
  | RepitchParams
  | NoiseGateParams
  | PitchShiftParams
  | TimeStretchParams
  | FilterParams
  | EqParams
  | EnvelopeParams
  | GainParams
  | NormalizeParams
  | FadeParams
  | ReverseParams
  | MonoConvertParams
  | AmParams
  | NoiseMixParams
  | FreqShiftParams
  | BandSplitParams
  | CompressorParams
  | SaturateParams

/** A queued or applied effect */
export interface EffectEntry {
  id: string
  params: EffectParams
  enabled: boolean
  /** Matches the latest rendered chain. Settings remain editable. */
  applied?: boolean
}

/** Region selection on the waveform */
export interface WaveformRegion {
  start: number // seconds
  end: number // seconds
}

/** Effect display info for UI */
export const EFFECT_LABELS: Record<EffectType, string> = {
  'trim': 'Trim',
  'cut': 'Cut',
  'repitch': 'Pitch / speed',
  'noise-gate': 'Noise gate',
  'pitch-shift': 'Pitch (keep duration)',
  'time-stretch': 'Time Stretch',
  'lpf': 'Low Pass Filter',
  'hpf': 'High Pass Filter',
  'bpf': 'Band Pass Filter',
  'eq': 'Parametric EQ',
  'envelope': 'Envelope',
  'normalize': 'Normalize',
  'fade-in': 'Fade In',
  'fade-out': 'Fade Out',
  'gain': 'Gain',
  'reverse': 'Reverse',
  'mono-convert': 'Mono Convert',
  'am': 'Amplitude Mod (AM)',
  'noise-mix': 'Noise Mix',
  'freq-shift': 'Frequency Shift',
  'band-split': 'Band Split',
  'compressor': 'Compressor',
  'saturate': 'Saturate',
}

/** Effects whose haptic usefulness is not yet backed by research; shown with a badge. */
export const EXPERIMENTAL_EFFECTS: ReadonlySet<EffectType> = new Set<EffectType>(['saturate'])

/** Default parameters for each effect type */
export function getDefaultParams(type: EffectType): EffectParams {
  switch (type) {
    case 'trim': case 'cut': return {type, start: 0, end: 1}
    case 'repitch': return { type, semitones: 0 }
    case 'noise-gate': return { type, thresholdDb: -40, attackMs: 2, releaseMs: 60 }
    case 'pitch-shift':
      return { type: 'pitch-shift', semitones: 0 }
    case 'time-stretch':
      return { type: 'time-stretch', rate: 1.0 }
    case 'lpf':
      return { type: 'lpf', frequency: 2000, Q: 1.0 }
    case 'hpf':
      return { type: 'hpf', frequency: 200, Q: 1.0 }
    case 'bpf':
      return { type: 'bpf', frequency: 1000, Q: 1.0 }
    case 'eq':
      return { type: 'eq', bands: [{ frequency: 1000, gain: 0, Q: 1.0 }] }
    case 'envelope':
      return {
        type: 'envelope',
        points: [
          { time: 0, value: 1 },
          { time: 1, value: 1 },
        ],
      }
    case 'normalize':
      return { type: 'normalize', targetPeak: 0.95 }
    case 'fade-in':
      return { type: 'fade-in', durationMs: 50 }
    case 'fade-out':
      return { type: 'fade-out', durationMs: 50 }
    case 'gain':
      return { type: 'gain', gainDb: 0 }
    case 'reverse':
      return { type: 'reverse' }
    case 'mono-convert':
      return { type: 'mono-convert', method: 'average' }
    case 'am':
      return { type, rateHz: 20, depth: 0.5, shape: 'sine', jitter: 0, seed: 1 }
    case 'noise-mix':
      return { type, levelDb: -12, lowHz: 40, highHz: 400, color: 'white', follow: true, seed: 1 }
    case 'freq-shift':
      return { type, shiftHz: 0 }
    case 'band-split':
      return { type, crossoverHz: 150, carrierHz: 80, carrierShape: 'sine', highGainDb: 0, smoothMs: 10 }
    case 'compressor':
      return { type, thresholdDb: -24, ratio: 4, attackMs: 5, releaseMs: 100, kneeDb: 6, makeupDb: 0 }
    case 'saturate':
      return { type, driveDb: 6, mode: 'soft', mix: 1, outputDb: 0 }
  }
}
