/** Supported output sample rates per hapbeat-contracts */
export type SampleRate = 16000 | 24000 | 44100

/** A loaded audio clip in working memory */
export interface WaveformClip {
  id: string
  /** User-visible name (derived from filename or "Untitled") */
  name: string
  /** The current working AudioBuffer (post-edits, pre-export) */
  buffer: AudioBuffer
  /** Original imported buffer (never mutated, for revert) */
  originalBuffer: AudioBuffer
  /** Blob for WaveSurfer display (updated when buffer changes) */
  displayBlob: Blob
  /** Target sample rate for export */
  exportSampleRate: SampleRate
  /** Target Event ID this clip is assigned to (optional) */
  eventId?: string
}

// ---- Effect types ----

export type EffectType =
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

export type EffectParams =
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

/** A queued or applied effect */
export interface EffectEntry {
  id: string
  params: EffectParams
  enabled: boolean
}

/** Region selection on the waveform */
export interface WaveformRegion {
  start: number // seconds
  end: number // seconds
}

/** Undo history snapshot */
export interface UndoSnapshot {
  /** Channel data arrays (supports mono and stereo) */
  channelData: Float32Array[]
  sampleRate: number
  numberOfChannels: number
  label: string
}

/** Effect display info for UI */
export const EFFECT_LABELS: Record<EffectType, string> = {
  'pitch-shift': 'Pitch Shift',
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
}

/** Default parameters for each effect type */
export function getDefaultParams(type: EffectType): EffectParams {
  switch (type) {
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
  }
}
