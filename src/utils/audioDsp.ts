/**
 * DSP utility functions for the waveform editor.
 * All functions take an AudioBuffer and return a new AudioBuffer (immutable).
 *
 * NOTE: Tone.js は AudioContext を eager 初期化し、user gesture 前にロードすると
 * "AudioContext was not allowed to start" 警告を出す。Tone を使う関数 (pitchShift,
 * timeStretch) は dynamic import で遅延ロードする。
 */
import type {
  EffectParams,
  EnvelopePoint,
  EqBand,
  MonoConvertMethod,
} from '@/types/waveform'

// ---- Helper: create a new AudioBuffer from channel data ----

function createBuffer(
  channelData: Float32Array[],
  sampleRate: number
): AudioBuffer {
  const ctx = new AudioContext()
  const buffer = ctx.createBuffer(channelData.length, channelData[0].length, sampleRate)
  for (let ch = 0; ch < channelData.length; ch++) {
    buffer.copyToChannel(channelData[ch] as Float32Array<ArrayBuffer>, ch)
  }
  return buffer
}

function cloneChannelData(buffer: AudioBuffer): Float32Array[] {
  const data: Float32Array[] = []
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    data.push(buffer.getChannelData(ch).slice())
  }
  return data
}

// ---- Render through Web Audio API graph (OfflineAudioContext) ----

async function renderThroughGraph(
  input: AudioBuffer,
  buildGraph: (ctx: OfflineAudioContext, source: AudioBufferSourceNode) => AudioNode,
  outputLength?: number
): Promise<AudioBuffer> {
  const length = outputLength ?? input.length
  const offlineCtx = new OfflineAudioContext(
    input.numberOfChannels,
    length,
    input.sampleRate
  )

  const source = offlineCtx.createBufferSource()
  source.buffer = input

  const lastNode = buildGraph(offlineCtx, source)
  lastNode.connect(offlineCtx.destination)
  source.start(0)

  return offlineCtx.startRendering()
}

// ---- Effect implementations ----

/**
 * Pitch shift without changing duration.
 * Uses Tone.js PitchShift via Tone.OfflineContext.
 */
export async function pitchShift(
  buffer: AudioBuffer,
  semitones: number
): Promise<AudioBuffer> {
  if (semitones === 0) return buffer

  const Tone = await import('tone')
  const duration = buffer.duration
  const rendered = await Tone.Offline(
    ({ transport }) => {
      const player = new Tone.Player(buffer).toDestination()
      const shift = new Tone.PitchShift({ pitch: semitones, windowSize: 0.1 })
      player.connect(shift)
      shift.toDestination()
      player.disconnect(Tone.getDestination())
      player.start(0)
      transport.start(0)
    },
    duration,
    buffer.numberOfChannels,
    buffer.sampleRate
  )

  return rendered.get()!
}

/**
 * Time stretch: change duration without changing pitch.
 * Uses Tone.js GrainPlayer for granular time stretch.
 */
export async function timeStretch(
  buffer: AudioBuffer,
  rate: number
): Promise<AudioBuffer> {
  if (rate === 1.0) return buffer

  const Tone = await import('tone')
  const outputDuration = buffer.duration / rate

  const rendered = await Tone.Offline(
    ({ transport }) => {
      const player = new Tone.GrainPlayer({
        url: buffer,
        playbackRate: rate,
        grainSize: 0.1,
        overlap: 0.05,
      }).toDestination()
      player.start(0)
      transport.start(0)
    },
    outputDuration,
    buffer.numberOfChannels,
    buffer.sampleRate
  )

  return rendered.get()!
}

/**
 * Apply biquad filter (lowpass, highpass, bandpass).
 */
export async function applyFilter(
  buffer: AudioBuffer,
  type: 'lowpass' | 'highpass' | 'bandpass',
  frequency: number,
  Q: number
): Promise<AudioBuffer> {
  return renderThroughGraph(buffer, (ctx, source) => {
    const filter = ctx.createBiquadFilter()
    filter.type = type
    filter.frequency.value = frequency
    filter.Q.value = Q
    source.connect(filter)
    return filter
  })
}

/**
 * Apply parametric EQ (multiple BiquadFilterNodes in series).
 */
export async function applyEq(
  buffer: AudioBuffer,
  bands: EqBand[]
): Promise<AudioBuffer> {
  if (bands.length === 0) return buffer

  return renderThroughGraph(buffer, (ctx, source) => {
    let lastNode: AudioNode = source
    for (const band of bands) {
      const filter = ctx.createBiquadFilter()
      filter.type = 'peaking'
      filter.frequency.value = band.frequency
      filter.gain.value = band.gain
      filter.Q.value = band.Q
      lastNode.connect(filter)
      lastNode = filter
    }
    return lastNode
  })
}

/**
 * Apply amplitude envelope via direct sample manipulation.
 */
export function applyEnvelope(
  buffer: AudioBuffer,
  points: EnvelopePoint[]
): AudioBuffer {
  if (points.length < 2) return buffer

  const data = cloneChannelData(buffer)
  const length = buffer.length

  for (let ch = 0; ch < data.length; ch++) {
    const channelData = data[ch]
    let ptIdx = 0

    for (let i = 0; i < length; i++) {
      const t = i / length // normalized time 0-1

      // Advance to the correct segment
      while (ptIdx < points.length - 2 && t >= points[ptIdx + 1].time) {
        ptIdx++
      }

      // Linear interpolation between points
      const p0 = points[ptIdx]
      const p1 = points[ptIdx + 1]
      const segLen = p1.time - p0.time
      const frac = segLen > 0 ? (t - p0.time) / segLen : 0
      const gain = p0.value + (p1.value - p0.value) * frac

      channelData[i] *= gain
    }
  }

  return createBuffer(data, buffer.sampleRate)
}

/**
 * Normalize peak amplitude.
 */
export function normalize(
  buffer: AudioBuffer,
  targetPeak: number
): AudioBuffer {
  const data = cloneChannelData(buffer)

  // Find global peak across all channels
  let peak = 0
  for (const ch of data) {
    for (let i = 0; i < ch.length; i++) {
      peak = Math.max(peak, Math.abs(ch[i]))
    }
  }

  if (peak === 0) return buffer

  const scale = targetPeak / peak
  for (const ch of data) {
    for (let i = 0; i < ch.length; i++) {
      ch[i] *= scale
    }
  }

  return createBuffer(data, buffer.sampleRate)
}

/**
 * Apply gain in dB.
 */
export function applyGain(buffer: AudioBuffer, gainDb: number): AudioBuffer {
  if (gainDb === 0) return buffer

  const scale = Math.pow(10, gainDb / 20)
  const data = cloneChannelData(buffer)

  for (const ch of data) {
    for (let i = 0; i < ch.length; i++) {
      ch[i] = Math.max(-1, Math.min(1, ch[i] * scale))
    }
  }

  return createBuffer(data, buffer.sampleRate)
}

/**
 * Fade in: linear ramp from 0 to 1 over duration.
 */
export function fadeIn(buffer: AudioBuffer, durationMs: number): AudioBuffer {
  const data = cloneChannelData(buffer)
  const fadeSamples = Math.min(
    Math.floor((durationMs / 1000) * buffer.sampleRate),
    buffer.length
  )

  for (const ch of data) {
    for (let i = 0; i < fadeSamples; i++) {
      ch[i] *= i / fadeSamples
    }
  }

  return createBuffer(data, buffer.sampleRate)
}

/**
 * Fade out: linear ramp from 1 to 0 over duration.
 */
export function fadeOut(buffer: AudioBuffer, durationMs: number): AudioBuffer {
  const data = cloneChannelData(buffer)
  const fadeSamples = Math.min(
    Math.floor((durationMs / 1000) * buffer.sampleRate),
    buffer.length
  )

  for (const ch of data) {
    const start = ch.length - fadeSamples
    for (let i = 0; i < fadeSamples; i++) {
      ch[start + i] *= 1 - i / fadeSamples
    }
  }

  return createBuffer(data, buffer.sampleRate)
}

/**
 * Reverse the buffer.
 */
export function reverse(buffer: AudioBuffer): AudioBuffer {
  const data = cloneChannelData(buffer)

  for (const ch of data) {
    ch.reverse()
  }

  return createBuffer(data, buffer.sampleRate)
}

/**
 * Convert stereo to mono.
 */
export function monoConvert(
  buffer: AudioBuffer,
  method: MonoConvertMethod
): AudioBuffer {
  if (buffer.numberOfChannels === 1) return buffer

  const left = buffer.getChannelData(0)
  const right = buffer.getChannelData(1)
  const mono = new Float32Array(buffer.length)

  switch (method) {
    case 'left':
      mono.set(left)
      break
    case 'right':
      mono.set(right)
      break
    case 'average':
      for (let i = 0; i < buffer.length; i++) {
        mono[i] = (left[i] + right[i]) * 0.5
      }
      break
  }

  return createBuffer([mono], buffer.sampleRate)
}

/**
 * Crop buffer to time range.
 */
export function cropBuffer(
  buffer: AudioBuffer,
  startSec: number,
  endSec: number
): AudioBuffer {
  const startSample = Math.floor(startSec * buffer.sampleRate)
  const endSample = Math.floor(endSec * buffer.sampleRate)
  const length = endSample - startSample

  if (length <= 0) return buffer

  const data: Float32Array[] = []
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const source = buffer.getChannelData(ch)
    data.push(source.slice(startSample, endSample))
  }

  return createBuffer(data, buffer.sampleRate)
}

/**
 * Delete a region from buffer.
 */
export function deleteRegion(
  buffer: AudioBuffer,
  startSec: number,
  endSec: number
): AudioBuffer {
  const startSample = Math.floor(startSec * buffer.sampleRate)
  const endSample = Math.floor(endSec * buffer.sampleRate)
  const newLength = buffer.length - (endSample - startSample)

  if (newLength <= 0) return buffer

  const data: Float32Array[] = []
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const source = buffer.getChannelData(ch)
    const newData = new Float32Array(newLength)
    newData.set(source.subarray(0, startSample), 0)
    newData.set(source.subarray(endSample), startSample)
    data.push(newData)
  }

  return createBuffer(data, buffer.sampleRate)
}

/**
 * Resample buffer to target sample rate.
 */
export async function resample(
  buffer: AudioBuffer,
  targetRate: number
): Promise<AudioBuffer> {
  if (buffer.sampleRate === targetRate) return buffer

  const targetLength = Math.ceil(buffer.duration * targetRate)
  const offlineCtx = new OfflineAudioContext(
    buffer.numberOfChannels,
    targetLength,
    targetRate
  )

  const source = offlineCtx.createBufferSource()
  source.buffer = buffer
  source.connect(offlineCtx.destination)
  source.start(0)

  return offlineCtx.startRendering()
}

/**
 * Dispatch: apply any EffectParams to a buffer.
 */
export async function applyEffect(
  buffer: AudioBuffer,
  params: EffectParams
): Promise<AudioBuffer> {
  switch (params.type) {
    case 'pitch-shift':
      return pitchShift(buffer, params.semitones)
    case 'time-stretch':
      return timeStretch(buffer, params.rate)
    case 'lpf':
      return applyFilter(buffer, 'lowpass', params.frequency, params.Q)
    case 'hpf':
      return applyFilter(buffer, 'highpass', params.frequency, params.Q)
    case 'bpf':
      return applyFilter(buffer, 'bandpass', params.frequency, params.Q)
    case 'eq':
      return applyEq(buffer, params.bands)
    case 'envelope':
      return applyEnvelope(buffer, params.points)
    case 'normalize':
      return normalize(buffer, params.targetPeak)
    case 'fade-in':
      return fadeIn(buffer, params.durationMs)
    case 'fade-out':
      return fadeOut(buffer, params.durationMs)
    case 'gain':
      return applyGain(buffer, params.gainDb)
    case 'reverse':
      return reverse(buffer)
    case 'mono-convert':
      return monoConvert(buffer, params.method)
  }
}
