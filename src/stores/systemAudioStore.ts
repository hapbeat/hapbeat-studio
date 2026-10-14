/**
 * PC sound → Hapbeat (desktop app on Windows): what the PC plays is captured
 * (`systemAudioCapture`) and streamed live to the chosen devices (`LiveStream`)
 * until the user stops it, the devices are taken by another stream, the helper
 * disconnects or the capture ends.
 */

import { create } from 'zustand'
import { getActiveHelperChannel, type HelperChannel } from '@/utils/helperRequest'
import { LiveStream, floatToPcm16, type LiveStreamLoss } from '@/utils/liveStream'
import { startSystemAudioCapture, type SystemAudioCapture } from '@/utils/systemAudioCapture'

export type SystemAudioState = 'idle' | 'starting' | 'live'

/** Why the last run did not start or stopped by itself (null after a stop by the user). */
export type SystemAudioNotice = 'denied' | 'noHelper' | 'noDevice' | 'helperLost' | 'ended' | LiveStreamLoss

interface SystemAudioStore {
  state: SystemAudioState
  notice: SystemAudioNotice | null
  /** Peak level (0..1) of the captured sound, about 10 times a second while live. */
  level: number
  /** Devices the stream goes to. */
  deviceCount: number
  /** Call straight from the click (the capture needs the user gesture). */
  start(targets: string[]): Promise<void>
  /** Follows a new device choice while live (no devices = stop). */
  setTargets(targets: string[]): void
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
    const { pcm, peak } = floatToPcm16(interleaved)
    stream.push(pcm)
    levelPeak = Math.max(levelPeak, peak)
    const now = performance.now()
    if (now - levelAt >= LEVEL_INTERVAL_MS) {
      set({ level: levelPeak })
      levelPeak = 0
      levelAt = now
    }
  }

  return {
    state: 'idle',
    notice: null,
    level: 0,
    deviceCount: 0,

    async start(targets) {
      if (get().state !== 'idle') return
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
      set({ state: 'starting', notice: null, level: 0 })
      let started: SystemAudioCapture
      try {
        started = await startSystemAudioCapture({
          onChunk: (chunk) => onChunk(run, chunk),
          onEnded: () => finish(run, 'ended'),
        })
      } catch (error) {
        console.warn('[SystemAudio] capture refused:', error)
        if (run === runId) set({ state: 'idle', notice: 'denied' })
        return
      }
      if (run !== runId) {
        started.stop() // stopped while starting
        return
      }
      capture = started
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

    stop() {
      if (get().state === 'idle') return
      finish(runId, null)
    },
  }
})
