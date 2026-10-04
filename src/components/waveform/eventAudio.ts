import { useEffect, useMemo } from 'react'
import { useAgentTrialStore } from '@/stores/agentTrialStore'
import { useEditorSettings } from '@/stores/editorSettings'
import { useEventStore } from '@/stores/eventStore'
import { useSceneStore } from '@/stores/sceneStore'
import { trialTarget } from '@/utils/agentProtocol'
import { effectiveEvent, resolveEventName } from '@/utils/cueEvents'
import { sfxSounds } from '@/utils/sceneCueTable'
import { RATE } from '@/utils/sceneHaptics'
import type { EditorBufferPlayer } from '@/utils/editorBufferPlayer'

/**
 * Event materials in the editor: an event's sound / haptic clip opened in the
 * waveform panel (played by the normal playback), and the decided sound played
 * on the PC with a haptic audition of the same event.
 */

function scaled(channels: Float32Array[], rate: number, factor: number): AudioBuffer {
  const length = channels[0]?.length ?? 0
  const buffer = new AudioBuffer({ numberOfChannels: Math.max(1, channels.length), length: Math.max(1, length), sampleRate: rate })
  channels.forEach((data, c) => { const out = buffer.getChannelData(c); for (let i = 0; i < length; i++) out[i] = Math.max(-1, Math.min(1, data[i] * factor)) })
  return buffer
}
const factorText = (x: number) => Number.isInteger(x * 10) ? x.toFixed(1) : String(Math.round(x * 1000) / 1000)

/** Opens route clip `clip` of event `key` in the waveform panel, at the level the game plays it (clip intensity × route gain). */
export function openEventHaptic(key: string, clip: string, gain: number, at: string): boolean {
  const s = useSceneStore.getState(), pcm = s.pcm[clip], entry = s.table?.clips[clip]
  if (!pcm || !entry) return false
  const factor = entry.intensity * gain
  useEventStore.getState().showPreview({ id: `${key}|haptic|${clip}|${at}`, event: key, target: 'haptic', label: `${key} · ${clip}.wav × ${factorText(factor)}`, buffer: scaled([pcm], RATE, factor) })
  return true
}
/** Opens sound `sound` of event `key` in the waveform panel, at its volume (PC playback only). */
export function openEventSound(key: string, sound: string, volume: number): boolean {
  const b = useSceneStore.getState().sfx[sound]
  if (!b) return false
  const channels = Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c))
  useEventStore.getState().showPreview({ id: `${key}|sound|${sound}`, event: key, target: 'sound', label: `${key} · ${sound}.wav × ${factorText(volume)}`, buffer: scaled(channels, b.sampleRate, volume) })
  return true
}

let ctx: AudioContext | null = null
const audio = () => {
  if (!ctx) ctx = new AudioContext()
  if (ctx.state === 'suspended') void ctx.resume()
  return ctx
}

/**
 * While a haptic of an event is played in the editor — an AI candidate of a
 * haptic trial (its first scene cue in the open Scene project) or the event's
 * own haptic clip opened from the Events panel — the event's decided sound plays
 * on the PC from the same position. Follows the editor's PC audio toggle (muted = silent).
 */
export function useDecidedSoundSync(player: EditorBufferPlayer) {
  const audition = useAgentTrialStore(s => s.audition)
  const trials = useAgentTrialStore(s => s.trials)
  const preview = useEventStore(s => s.preview)
  const muted = useEditorSettings(s => s.muted)
  const table = useSceneStore(s => s.table)
  const lib = useSceneStore(s => s.lib)
  const buffers = useSceneStore(s => s.sfx)
  const sound = useMemo(() => {
    if (!table || !lib) return null
    let names: string[] = []
    if (audition) {
      const trial = trials.find(r => r.trial.id === audition.trialId)?.trial
      if (trial && trialTarget(trial) === 'haptic' && trial.scene && trial.scene.project === lib.project_name) names = trial.scene.cues
    } else if (preview?.target === 'haptic') names = [preview.event]
    for (const name of names) {
      const r = resolveEventName(table, name), e = r && effectiveEvent(table, r.ref)
      const first = sfxSounds(e?.sfx)[0]
      if (e?.sfx && first && buffers[first]) return { buffer: buffers[first], volume: e.sfx.volume }
    }
    return null
  }, [audition, trials, preview, table, lib, buffers])
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
