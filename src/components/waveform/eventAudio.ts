import { useEffect, useMemo } from 'react'
import { useAgentTrialStore } from '@/stores/agentTrialStore'
import { useEditorSettings } from '@/stores/editorSettings'
import { useSceneStore } from '@/stores/sceneStore'
import { trialTarget } from '@/utils/agentProtocol'
import { effectiveEvent, resolveEventName } from '@/utils/cueEvents'
import { sfxSounds } from '@/utils/sceneCueTable'
import type { EditorBufferPlayer } from '@/utils/editorBufferPlayer'

/**
 * PC audio of the Events panel (▶ of an event's sound or haptic clip; one at a
 * time, explicit clicks only) and the decided sound played with a haptic AI
 * candidate's audition. Nothing here sends to a device.
 */
let ctx: AudioContext | null = null
let current: AudioBufferSourceNode | null = null
const audio = () => {
  if (!ctx) ctx = new AudioContext()
  if (ctx.state === 'suspended') void ctx.resume()
  return ctx
}

export function stopPreview() { try { current?.stop() } catch { /* already ended */ } current = null }
export function playPreview(buffer: AudioBuffer, gain: number) {
  stopPreview()
  const c = audio(), src = c.createBufferSource(), g = c.createGain()
  src.buffer = buffer; g.gain.value = gain; src.connect(g).connect(c.destination)
  src.start()
  current = src
}
/** Mono samples (a 16 kHz Kit clip) on the PC. */
export function playSamples(samples: Float32Array, rate: number, gain: number) {
  if (!samples.length) return
  const buffer = new AudioBuffer({ numberOfChannels: 1, length: samples.length, sampleRate: rate })
  buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0)
  playPreview(buffer, gain)
}

/**
 * While a haptic AI candidate is auditioned for an event whose sound is decided
 * (the trial's first scene cue in the open Scene project), that sound plays on
 * the PC with each playback, from the same position. Follows the editor's PC
 * audio toggle (muted = silent).
 */
export function useDecidedSoundSync(player: EditorBufferPlayer) {
  const audition = useAgentTrialStore(s => s.audition)
  const trials = useAgentTrialStore(s => s.trials)
  const muted = useEditorSettings(s => s.muted)
  const table = useSceneStore(s => s.table)
  const lib = useSceneStore(s => s.lib)
  const buffers = useSceneStore(s => s.sfx)
  const sound = useMemo(() => {
    const trial = audition ? trials.find(r => r.trial.id === audition.trialId)?.trial : undefined
    if (!trial || trialTarget(trial) !== 'haptic' || !trial.scene || !table || !lib || trial.scene.project !== lib.project_name) return null
    for (const name of trial.scene.cues) {
      const r = resolveEventName(table, name), e = r && effectiveEvent(table, r.ref)
      const first = sfxSounds(e?.sfx)[0]
      if (e?.sfx && first && buffers[first]) return { buffer: buffers[first], volume: e.sfx.volume }
    }
    return null
  }, [audition, trials, table, lib, buffers])
  useEffect(() => {
    if (!sound || muted) return
    let src: AudioBufferSourceNode | null = null
    const stop = () => { try { src?.stop() } catch { /* already ended */ } src = null }
    const start = (time: number) => {
      stop()
      if (time >= sound.buffer.duration) return
      const c = audio(), g = c.createGain()
      src = c.createBufferSource(); src.buffer = sound.buffer; g.gain.value = sound.volume
      src.connect(g).connect(c.destination)
      src.start(0, Math.max(0, time))
    }
    const unsubs = [
      player.on('play', start),
      player.on('pause', stop),
      player.on('finish', stop),
      player.on('seeking', time => { if (player.isPlaying()) start(time) }),
    ]
    return () => { unsubs.forEach(unsub => unsub()); stop() }
  }, [player, sound, muted])
}
