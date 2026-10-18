/**
 * What the PC plays, as 16 kHz stereo chunks.
 *
 * Desktop app (Windows): the app answers getDisplayMedia with the system audio
 * (WASAPI loopback) and Studio's own page as the video track, without a picker
 * (hapbeat-studio-desktop `systemAudio.js`); that video track is stopped at once.
 *
 * Browser: getDisplayMedia shows the browser's picker, where the user chooses the
 * entire screen and turns on sharing the system audio (Chrome / Edge on Windows).
 * The screen video is asked at 1 fps and small, and kept until `stop()` (whether
 * the browser goes on capturing the audio once the video track stops is not
 * checked).
 *
 * Web Audio resamples the capture (48 kHz in the app's checks) to 16 kHz, delays it
 * by the vibration delay (a DelayNode: no timers, so it holds while the window is
 * hidden) and a worklet hands over `LIVE_CHUNK_FRAMES` frames at a time. Nothing is
 * played: the graph ends in a zero gain so the context keeps running.
 */

import { LIVE_CHUNK_FRAMES, LIVE_SAMPLE_RATE } from '@/utils/liveStream'

/** Raw capture: no echo cancellation / noise suppression / gain control, both channels. */
const AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  channelCount: 2,
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
}

/** Longest vibration delay the graph can hold (seconds). */
export const MAX_CAPTURE_DELAY_S = 1

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

/** getDisplayMedia options: the app answers without a picker; a browser's picker is steered to the screen + system audio. */
function displayMediaOptions(picker: boolean): DisplayMediaStreamOptions {
  if (!picker) return { video: true, audio: AUDIO_CONSTRAINTS }
  // Chrome / Edge hints (not in the TypeScript DOM types yet): start on "entire screen",
  // offer the system audio, leave out this tab.
  return {
    video: { displaySurface: 'monitor', frameRate: { max: 1 }, width: { max: 320 }, height: { max: 240 } },
    audio: AUDIO_CONSTRAINTS,
    systemAudio: 'include',
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'exclude',
    monitorTypeSurfaces: 'include',
  } as DisplayMediaStreamOptions
}

export interface SystemAudioCapture {
  /** Changes the vibration delay while it runs (seconds, 0..MAX_CAPTURE_DELAY_S). */
  setDelay(seconds: number): void
  /** Stops the capture (the tracks end; `onEnded` is not called). */
  stop(): void
}

export interface SystemAudioOptions {
  /** True in a browser: the user picks the screen and the system audio in its picker. */
  picker: boolean
  /** Vibration delay at the start (seconds). */
  delaySeconds: number
  /** Interleaved stereo float samples, `LIVE_CHUNK_FRAMES` frames at 16 kHz. */
  onChunk(interleaved: Float32Array): void
  /** The capture ended without `stop()` (the browser's "stop sharing", or the audio device went away). */
  onEnded(): void
}

const clampDelay = (seconds: number) => Math.max(0, Math.min(MAX_CAPTURE_DELAY_S, Number.isFinite(seconds) ? seconds : 0))

/**
 * Starts capturing what the PC plays. Call it straight from a click: getDisplayMedia
 * needs the user gesture (and the app grants the system audio only with one).
 * Rejects when the capture is refused or cancelled (NotAllowedError / AbortError)
 * or comes without audio (NotFoundError: the system audio was not shared).
 */
export async function startSystemAudioCapture(options: SystemAudioOptions): Promise<SystemAudioCapture> {
  const media = await navigator.mediaDevices.getDisplayMedia(displayMediaOptions(options.picker))
  const videoTracks = media.getVideoTracks()
  if (!options.picker) for (const video of videoTracks) video.stop()
  const track = media.getAudioTracks()[0]
  if (!track) {
    for (const video of videoTracks) video.stop()
    throw new DOMException('The capture has no audio track', 'NotFoundError')
  }

  const context = new AudioContext({ sampleRate: LIVE_SAMPLE_RATE, latencyHint: 'interactive' })
  const delay = context.createDelay(MAX_CAPTURE_DELAY_S)
  delay.delayTime.value = clampDelay(options.delaySeconds)
  let source: MediaStreamAudioSourceNode | null = null
  let tap: AudioWorkletNode | null = null
  let stopped = false
  const onTrackEnded = () => {
    if (stopped) return
    stop()
    options.onEnded()
  }
  const stop = () => {
    stopped = true
    track.removeEventListener('ended', onTrackEnded)
    track.stop()
    for (const video of videoTracks) video.stop()
    if (tap) tap.port.onmessage = null
    source?.disconnect()
    delay.disconnect()
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
      if (!stopped) options.onChunk(event.data)
    }
    source.connect(delay).connect(tap).connect(silent).connect(context.destination)
    track.addEventListener('ended', onTrackEnded)
    if (context.state !== 'running') await context.resume()
    if (track.readyState === 'ended') throw new DOMException('The capture ended', 'AbortError')
  } catch (error) {
    stop()
    throw error
  }
  return {
    setDelay(seconds) {
      if (stopped) return
      // A short glide instead of a jump in the delayed signal.
      delay.delayTime.setTargetAtTime(clampDelay(seconds), context.currentTime, 0.02)
    },
    stop,
  }
}
