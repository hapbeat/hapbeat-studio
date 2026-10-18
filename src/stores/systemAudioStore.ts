/**
 * PC sound → Hapbeat: what the PC plays is captured (`systemAudioCapture`) and
 * streamed live to the chosen devices (`LiveStream`) until the user stops it, the
 * devices are taken by another stream, the helper disconnects or the capture ends.
 * In the desktop app (Windows) there is no picker; in a browser the user picks the
 * screen and its system audio.
 *
 * The level (gain) and the vibration delay are kept in this browser (per PC, as the
 * delay depends on its speakers / headphones). The delay only makes the vibration
 * later (DEC-093's environment term for this source): PC sound reaches the device
 * about 80–100 ms after the PC mixes it (dev-notes/studio-desktop/
 * system-audio-loopback-20261015.md), so it serves outputs slower than that, such
 * as Bluetooth headphones.
 */

import { create } from 'zustand'
import { desktopApi } from '@/config/desktopShell'
import { getActiveHelperChannel, type HelperChannel } from '@/utils/helperRequest'
import { LiveStream, floatToPcm16, type LiveStreamLoss } from '@/utils/liveStream'
import { MAX_CAPTURE_DELAY_S, startSystemAudioCapture, type SystemAudioCapture } from '@/utils/systemAudioCapture'

export type SystemAudioState = 'idle' | 'starting' | 'live'

/** Why the last run did not start or stopped by itself (null after a stop by the user). */
export type SystemAudioNotice =
  | 'denied' | 'noAudio' | 'noHelper' | 'noDevice' | 'helperLost' | 'ended' | LiveStreamLoss

export const SYSTEM_AUDIO_STORAGE_KEY = 'hapbeat-studio-pc-sound'
export const GAIN_PCT_MAX = 200
export const DELAY_MS_MAX = Math.round(MAX_CAPTURE_DELAY_S * 1000)

export const clampGainPct = (pct: number) => Number.isFinite(pct) ? Math.max(0, Math.min(GAIN_PCT_MAX, Math.round(pct))) : 100
export const clampDelayMs = (ms: number) => Number.isFinite(ms) ? Math.max(0, Math.min(DELAY_MS_MAX, Math.round(ms))) : 0

function readSettings(): { gainPct: number; delayMs: number } {
  try {
    const data = JSON.parse(localStorage.getItem(SYSTEM_AUDIO_STORAGE_KEY) ?? 'null') as { gainPct?: unknown; delayMs?: unknown } | null
    return {
      gainPct: typeof data?.gainPct === 'number' ? clampGainPct(data.gainPct) : 100,
      delayMs: typeof data?.delayMs === 'number' ? clampDelayMs(data.delayMs) : 0,
    }
  } catch {
    return { gainPct: 100, delayMs: 0 }
  }
}

function saveSettings(settings: { gainPct: number; delayMs: number }) {
  try {
    localStorage.setItem(SYSTEM_AUDIO_STORAGE_KEY, JSON.stringify(settings))
  } catch { /* a preference must not stop the stream */ }
}

/** The app captures without a picker when it says so; a browser shows its own picker; an app without it cannot. */
export function systemAudioMode(): 'app' | 'browser' | null {
  const api = desktopApi()
  if (api) return api.systemAudio === true ? 'app' : null
  return typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getDisplayMedia === 'function' ? 'browser' : null
}

interface SystemAudioStore {
  state: SystemAudioState
  notice: SystemAudioNotice | null
  /** Peak level (0..1) of what goes to the devices (after the gain), about 10 times a second while live. */
  level: number
  /** Devices the stream goes to. */
  deviceCount: number
  /** Level of the vibration, % of the captured sound (0..GAIN_PCT_MAX). */
  gainPct: number
  /** Vibration delay (ms, 0..DELAY_MS_MAX). */
  delayMs: number
  /** Call straight from the click (the capture needs the user gesture). */
  start(targets: string[]): Promise<void>
  /** Follows a new device choice while live (no devices = stop). */
  setTargets(targets: string[]): void
  setGainPct(pct: number): void
  setDelayMs(ms: number): void
  stop(): void
}

const LEVEL_INTERVAL_MS = 100

let capture: SystemAudioCapture | null = null
let stream: LiveStream | null = null
let channel: HelperChannel | null = null
/** Bumped by every start and stop, so callbacks of an earlier run do nothing. */
let runId = 0
let levelPeak = 0
let levelAt = 0

export const useSystemAudio = create<SystemAudioStore>((set, get) => {
  const finish = (run: number, notice: SystemAudioNotice | null) => {
    if (run !== runId) return
    runId++
    capture?.stop()
    capture = null
    stream?.dispose() // END, unless the helper already dropped it
    stream = null
    channel = null
    set({ state: 'idle', notice, level: 0, deviceCount: 0 })
  }

  const onChunk = (run: number, interleaved: Float32Array) => {
    if (run !== runId || !stream) return
    // The provider publishes a new channel on every (re)connect and none while disconnected.
    if (getActiveHelperChannel() !== channel) {
      finish(run, 'helperLost')
      return
    }
    const { pcm, peak } = floatToPcm16(interleaved, get().gainPct / 100)
    stream.push(pcm)
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
    ...readSettings(),

    async start(targets) {
      if (get().state !== 'idle') return
      const mode = systemAudioMode()
      const helper = getActiveHelperChannel()
      if (!mode) return
      if (!helper) {
        set({ notice: 'noHelper' })
        return
      }
      if (targets.length === 0) {
        set({ notice: 'noDevice' })
        return
      }
      const run = ++runId
      set({ state: 'starting', notice: null, level: 0 })
      let started: SystemAudioCapture
      try {
        started = await startSystemAudioCapture({
          picker: mode === 'browser',
          delaySeconds: get().delayMs / 1000,
          onChunk: (chunk) => onChunk(run, chunk),
          onEnded: () => finish(run, 'ended'),
        })
      } catch (error) {
        console.warn('[SystemAudio] capture refused:', error)
        const noAudio = error instanceof DOMException && error.name === 'NotFoundError'
        if (run === runId) set({ state: 'idle', notice: noAudio ? 'noAudio' : 'denied' })
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
      set({ state: 'live', deviceCount: stream.devices.length })
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
      const gainPct = clampGainPct(pct)
      set({ gainPct })
      saveSettings({ gainPct, delayMs: get().delayMs })
    },

    setDelayMs(ms) {
      const delayMs = clampDelayMs(ms)
      set({ delayMs })
      saveSettings({ gainPct: get().gainPct, delayMs })
      capture?.setDelay(delayMs / 1000)
    },

    stop() {
      if (get().state === 'idle') return
      finish(runId, null)
    },
  }
})
