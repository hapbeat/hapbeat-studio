/**
 * What the PC plays, as 16 kHz stereo chunks (desktop app on Windows).
 *
 * The app answers getDisplayMedia with the system audio (WASAPI loopback) and
 * Studio's own page as the video track, without a picker (hapbeat-studio-desktop
 * `systemAudio.js`); that video track is stopped at once. Web Audio resamples the
 * capture (48 kHz in the app's checks) to 16 kHz, and a worklet hands over
 * `LIVE_CHUNK_FRAMES` frames at a time. Nothing is played: the graph ends in a
 * zero gain so the context keeps running.
 */

import { LIVE_CHUNK_FRAMES, LIVE_SAMPLE_RATE } from '@/utils/liveStream'

/** Raw capture: no echo cancellation / noise suppression / gain control, both channels. */
const AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  channelCount: 2,
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
}

const TAP_NAME = 'hapbeat-system-audio-tap'

// Interleaves L / R into chunks of `chunkFrames` and transfers each one to the page.
// An input with no channels (nothing connected) counts as silence, so chunks keep
// their pace.
const TAP_SOURCE = `
class Tap extends AudioWorkletProcessor {
  constructor(options) {
    super()
    this.frames = options.processorOptions.chunkFrames
    this.buf = new Float32Array(this.frames * 2)
    this.fill = 0
  }
  process(inputs) {
    const input = inputs[0] || []
    const left = input[0]
    const right = input[1] || left
    const n = left ? left.length : 128
    for (let i = 0; i < n; i++) {
      const j = this.fill * 2
      this.buf[j] = left ? left[i] : 0
      this.buf[j + 1] = right ? right[i] : 0
      if (++this.fill === this.frames) {
        this.port.postMessage(this.buf, [this.buf.buffer])
        this.buf = new Float32Array(this.frames * 2)
        this.fill = 0
      }
    }
    return true
  }
}
registerProcessor('${TAP_NAME}', Tap)
`

let tapUrl: string | null = null

function tapModuleUrl(): string {
  tapUrl ??= URL.createObjectURL(new Blob([TAP_SOURCE], { type: 'text/javascript' }))
  return tapUrl
}

export interface SystemAudioCapture {
  /** Stops the capture (the track ends; `onEnded` is not called). */
  stop(): void
}

export interface SystemAudioCallbacks {
  /** Interleaved stereo float samples, `LIVE_CHUNK_FRAMES` frames at 16 kHz. */
  onChunk(interleaved: Float32Array): void
  /** The capture ended without `stop()` (e.g. the audio device went away). */
  onEnded(): void
}

/**
 * Starts capturing what the PC plays. Call it straight from a click: the app
 * grants the system audio only to a request made with a user gesture.
 * Rejects when the capture is refused or has no audio.
 */
export async function startSystemAudioCapture(callbacks: SystemAudioCallbacks): Promise<SystemAudioCapture> {
  const media = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: AUDIO_CONSTRAINTS })
  for (const track of media.getVideoTracks()) track.stop()
  const track = media.getAudioTracks()[0]
  if (!track) {
    throw new DOMException('The capture has no audio track', 'NotFoundError')
  }

  const context = new AudioContext({ sampleRate: LIVE_SAMPLE_RATE, latencyHint: 'interactive' })
  let source: MediaStreamAudioSourceNode | null = null
  let tap: AudioWorkletNode | null = null
  let stopped = false
  const onTrackEnded = () => {
    if (stopped) return
    stop()
    callbacks.onEnded()
  }
  const stop = () => {
    stopped = true
    track.removeEventListener('ended', onTrackEnded)
    track.stop()
    if (tap) tap.port.onmessage = null
    source?.disconnect()
    tap?.disconnect()
    void context.close().catch(() => { /* already closed */ })
  }

  try {
    await context.audioWorklet.addModule(tapModuleUrl())
    source = context.createMediaStreamSource(new MediaStream([track]))
    tap = new AudioWorkletNode(context, TAP_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 2,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      processorOptions: { chunkFrames: LIVE_CHUNK_FRAMES },
    })
    const silent = context.createGain()
    silent.gain.value = 0
    tap.port.onmessage = (event: MessageEvent<Float32Array>) => {
      if (!stopped) callbacks.onChunk(event.data)
    }
    source.connect(tap).connect(silent).connect(context.destination)
    track.addEventListener('ended', onTrackEnded)
    if (context.state !== 'running') await context.resume()
    if (track.readyState === 'ended') throw new DOMException('The capture ended', 'AbortError')
  } catch (error) {
    stop()
    throw error
  }
  return { stop }
}
