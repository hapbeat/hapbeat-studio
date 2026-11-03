/**
 * PC sound → Hapbeat: what the PC plays is captured (`systemAudioCapture`) and
 * streamed live to the chosen devices (`LiveStream`) until the user stops it, the
 * devices are taken by another stream, the helper disconnects or the capture ends.
 * The source is the loopback of the default playback device (in the desktop app on
 * Windows without a picker; in a browser through its picker) or a chosen recording
 * device (CABLE Output, Voicemeeter Out, Stereo Mix…), for PCs whose loopback is silent.
 *
 * The level (gain), the vibration delay and the source are kept in this browser (per
 * PC, as they depend on its audio devices). The delay only makes the vibration later
 * (DEC-093's environment term for this source): PC sound reaches the device about
 * 80–100 ms after the PC mixes it (dev-notes/studio-desktop/
 * system-audio-loopback-20261015.md), so it serves outputs slower than that, such as
 * Bluetooth headphones.
 */

import { create } from 'zustand'
import { desktopApi } from '@/config/desktopShell'
import { getActiveHelperChannel, type HelperChannel } from '@/utils/helperRequest'
import { LiveStream, LIVE_CHUNK_FRAMES, LIVE_SAMPLE_RATE, floatToPcm16, type LiveStreamLoss } from '@/utils/liveStream'
import {
  MAX_CAPTURE_DELAY_S,
  startSystemAudioCapture,
  type CaptureInfo,
  type SystemAudioCapture,
} from '@/utils/systemAudioCapture'

export type SystemAudioState = 'idle' | 'starting' | 'live'

/** Why the last run did not start or stopped by itself (null after a stop by the user). */
export type SystemAudioNotice =
  | 'denied' | 'noAudio' | 'sourceMissing' | 'noHelper' | 'noDevice' | 'helperLost' | 'ended' | LiveStreamLoss

/** A chosen recording device; null = the loopback of the default playback device. */
export interface SourceChoice {
  deviceId: string
  /** Its name when chosen, shown if the device is gone. */
  label: string
}

export const SYSTEM_AUDIO_STORAGE_KEY = 'hapbeat-studio-pc-sound'
export const GAIN_PCT_MAX = 200
export const DELAY_MS_MAX = Math.round(MAX_CAPTURE_DELAY_S * 1000)
/** Exact silence this long while live shows the hint to choose another source. */
export const SILENT_HINT_MS = 3000

export const clampGainPct = (pct: number) => Number.isFinite(pct) ? Math.max(0, Math.min(GAIN_PCT_MAX, Math.round(pct))) : 100
export const clampDelayMs = (ms: number) => Number.isFinite(ms) ? Math.max(0, Math.min(DELAY_MS_MAX, Math.round(ms))) : 0

interface Settings {
  gainPct: number
  delayMs: number
  source: SourceChoice | null
}

function readSettings(): Settings {
  try {
    const data = JSON.parse(localStorage.getItem(SYSTEM_AUDIO_STORAGE_KEY) ?? 'null') as
      { gainPct?: unknown; delayMs?: unknown; source?: { deviceId?: unknown; label?: unknown } | null } | null
    const source = data?.source
    return {
      gainPct: typeof data?.gainPct === 'number' ? clampGainPct(data.gainPct) : 100,
      delayMs: typeof data?.delayMs === 'number' ? clampDelayMs(data.delayMs) : 0,
      source: source && typeof source.deviceId === 'string' && source.deviceId
        ? { deviceId: source.deviceId, label: typeof source.label === 'string' ? source.label : '' }
        : null,
    }
  } catch {
    return { gainPct: 100, delayMs: 0, source: null }
  }
}

function saveSettings(settings: Settings) {
  try {
    localStorage.setItem(SYSTEM_AUDIO_STORAGE_KEY, JSON.stringify(settings))
  } catch { /* a preference must not stop the stream */ }
}

/**
 * What this Studio can capture. loopback: 'app' = the desktop app hands it over
 * without a picker, 'picker' = a browser's share picker, null = none (an app without
 * it). inputs: recording devices by getUserMedia (an app from apiVersion 4, a browser).
 */
export function systemAudioSupport(): { loopback: 'app' | 'picker' | null; inputs: boolean } {
  const media = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined
  const api = desktopApi()
  if (api) return { loopback: api.systemAudio === true ? 'app' : null, inputs: api.audioInput === true }
  return {
    loopback: typeof media?.getDisplayMedia === 'function' ? 'picker' : null,
    inputs: typeof media?.getUserMedia === 'function',
  }
}

interface SystemAudioStore extends Settings {
  state: SystemAudioState
  notice: SystemAudioNotice | null
  /** Peak level (0..1) of what goes to the devices (after the gain), about 10 times a second while live. */
  level: number
  /** Devices the stream goes to. */
  deviceCount: number
  /** What is being captured, while live. */
  capturing: CaptureInfo | null
  /** Live, and nothing but exact silence from the source for SILENT_HINT_MS (a level above 0). */
  silent: boolean
  /** Call straight from the click (the capture needs the user gesture). */
  start(targets: string[]): Promise<void>
  /** Follows a new device choice while live (no devices = stop). */
  setTargets(targets: string[]): void
  setGainPct(pct: number): void
  setDelayMs(ms: number): void
  /** The source for the next start (null = loopback of the default playback device). */
  setSource(source: SourceChoice | null): void
  stop(): void
}

const LEVEL_INTERVAL_MS = 100
const CHUNK_MS = (LIVE_CHUNK_FRAMES / LIVE_SAMPLE_RATE) * 1000

let capture: SystemAudioCapture | null = null
let stream: LiveStream | null = null
let channel: HelperChannel | null = null
/** Bumped by every start and stop, so callbacks of an earlier run do nothing. */
let runId = 0
let levelPeak = 0
let levelAt = 0
let silentMs = 0

export const useSystemAudio = create<SystemAudioStore>((set, get) => {
  const settings = (): Settings => ({ gainPct: get().gainPct, delayMs: get().delayMs, source: get().source })

  const finish = (run: number, notice: SystemAudioNotice | null) => {
    if (run !== runId) return
    runId++
    capture?.stop()
    capture = null
    stream?.dispose() // END, unless the helper already dropped it
    stream = null
    channel = null
    set({ state: 'idle', notice, level: 0, deviceCount: 0, capturing: null, silent: false })
  }

  const onChunk = (run: number, interleaved: Float32Array) => {
    if (run !== runId || !stream) return
    // The provider publishes a new channel on every (re)connect and none while disconnected.
    if (getActiveHelperChannel() !== channel) {
      finish(run, 'helperLost')
      return
    }
    const gain = get().gainPct / 100
    const { pcm, peak } = floatToPcm16(interleaved, gain)
    stream.push(pcm)
    // Exact zeros from the source (not a quiet passage): the loopback of a device that
    // never carries the sound, or a muted / unused recording device.
    if (gain > 0) {
      silentMs = peak === 0 ? silentMs + CHUNK_MS : 0
      const silent = silentMs >= SILENT_HINT_MS
      if (silent !== get().silent) set({ silent })
    }
    levelPeak = Math.max(levelPeak, peak)
    const now = performance.now()
    if (now - levelAt >= LEVEL_INTERVAL_MS) {
      set({ level: Math.min(1, levelPeak) })
      levelPeak = 0
      levelAt = now
    }
  }

  return {
    state: 'idle',
    notice: null,
    level: 0,
    deviceCount: 0,
    capturing: null,
    silent: false,
    ...readSettings(),

    async start(targets) {
      if (get().state !== 'idle') return
      const support = systemAudioSupport()
      const choice = get().source
      if (choice ? !support.inputs : !support.loopback) return
      const helper = getActiveHelperChannel()
      if (!helper) {
        set({ notice: 'noHelper' })
        return
      }
      if (targets.length === 0) {
        set({ notice: 'noDevice' })
        return
      }
      const run = ++runId
      set({ state: 'starting', notice: null, level: 0, silent: false })
      let started: SystemAudioCapture
      try {
        started = await startSystemAudioCapture({
          source: choice ? { kind: 'input', deviceId: choice.deviceId } : { kind: 'loopback' },
          picker: support.loopback === 'picker',
          delaySeconds: get().delayMs / 1000,
          onChunk: (chunk) => onChunk(run, chunk),
          onEnded: () => finish(run, 'ended'),
        })
      } catch (error) {
        console.warn('[SystemAudio] capture refused:', error)
        const name = error instanceof DOMException || error instanceof Error ? error.name : ''
        const notice: SystemAudioNotice = choice
          ? (name === 'NotFoundError' || name === 'OverconstrainedError' ? 'sourceMissing' : 'denied')
          : (name === 'NotFoundError' ? 'noAudio' : 'denied')
        if (run === runId) set({ state: 'idle', notice })
        return
      }
      if (run !== runId) {
        started.stop() // stopped while starting
        return
      }
      capture = started
      started.setDelay(get().delayMs / 1000) // changed while the picker was open
      channel = helper
      stream = new LiveStream(helper, (reason) => finish(run, reason))
      stream.setTargets(targets)
      levelPeak = 0
      levelAt = performance.now()
      silentMs = 0
      set({ state: 'live', deviceCount: stream.devices.length, capturing: started.info })
    },

    setTargets(targets) {
      if (get().state !== 'live' || !stream) return
      if (targets.length === 0) {
        finish(runId, 'noDevice')
        return
      }
      stream.setTargets(targets)
      set({ deviceCount: stream.devices.length })
    },

    setGainPct(pct) {
      set({ gainPct: clampGainPct(pct) })
      saveSettings(settings())
    },

    setDelayMs(ms) {
      const delayMs = clampDelayMs(ms)
      set({ delayMs })
      saveSettings(settings())
      capture?.setDelay(delayMs / 1000)
    },

    setSource(source) {
      if (get().state !== 'idle') return
      set({ source: source && source.deviceId ? { deviceId: source.deviceId, label: source.label } : null, notice: null })
      saveSettings(settings())
    },

    stop() {
      if (get().state === 'idle') return
      finish(runId, null)
    },
  }
})
