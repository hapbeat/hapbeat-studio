import { useEffect, useMemo } from 'react'
import { useAgentTrialStore } from '@/stores/agentTrialStore'
import { useEditorSettings } from '@/stores/editorSettings'
import { useEventStore } from '@/stores/eventStore'
import { useSceneStore } from '@/stores/sceneStore'
import { trialTarget } from '@/utils/agentProtocol'
import { effectiveEvent, parseEventKey, representativeSound, resolveEventName } from '@/utils/cueEvents'
import { isLoopCue, routeClips, sfxSounds } from '@/utils/sceneCueTable'
import { RATE, resampleClip } from '@/utils/sceneHaptics'
import type { EditorBufferPlayer } from '@/utils/editorBufferPlayer'
import { onUserStop } from '@/utils/playerStops'
import { CompanionSound, type SoundSource } from '@/utils/companionSound'
import { FiringScheduler, type Firing } from '@/utils/firingScheduler'
import { perfTrack } from '@/utils/perfRegistry'
import { useAuditionPlan } from './EditorScenePanel'

/**
 * Event materials in the editor: an event's sound / haptic clip opened in the
 * waveform panel (played by the normal playback), "×5" (one material five times
 * at the cue's real timing), and the event's sound played on the PC with a
 * haptic audition of the same event.
 */

/** Loop cue previews repeat their material to this length (the player has no endless loop). */
export const LOOP_PREVIEW_SEC = 8

function scaled(channels: Float32Array[], rate: number, factor: number, loopToSec = 0): AudioBuffer {
  const source = channels[0]?.length ?? 0
  const length = loopToSec > 0 && source > 0 ? Math.max(source, Math.round(loopToSec * rate)) : source
  const buffer = new AudioBuffer({ numberOfChannels: Math.max(1, channels.length), length: Math.max(1, length), sampleRate: rate })
  channels.forEach((data, c) => { const out = buffer.getChannelData(c); for (let i = 0; i < length; i++) out[i] = Math.max(-1, Math.min(1, data[i % source] * factor)) })
  return buffer
}
const factorText = (x: number) => Number.isInteger(x * 10) ? x.toFixed(1) : String(Math.round(x * 1000) / 1000)
const loopCue = (key: string) => { const lib = useSceneStore.getState().lib; return !!lib && isLoopCue(lib, parseEventKey(key).cue) }

/** Route clip `clip` of event `key` at the level the game plays it (clip intensity × route gain); null when not loaded. `loopSec`: a loop cue's clip repeats to that length. */
function hapticBuffer(clip: string, gain: number, loopSec: number): { buffer: AudioBuffer; factor: number } | null {
  const s = useSceneStore.getState(), pcm = s.pcm[clip], entry = s.table?.clips[clip]
  if (!pcm || !entry) return null
  const factor = entry.intensity * gain
  return { buffer: scaled([pcm], RATE, factor, loopSec), factor }
}
/** Sound `sound` at `volume`; null when not loaded. */
function soundBuffer(sound: string, volume: number, loopSec: number): AudioBuffer | null {
  const b = useSceneStore.getState().sfx[sound]
  if (!b) return null
  return scaled(Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c)), b.sampleRate, volume, loopSec)
}
/** Opens route clip `clip` of event `key` in the waveform panel, at the level the game plays it (clip intensity × route gain). A loop cue's clip repeats. */
export function openEventHaptic(key: string, clip: string, gain: number, at: string, autoplay = false): boolean {
  const made = hapticBuffer(clip, gain, loopCue(key) ? LOOP_PREVIEW_SEC : 0)
  if (!made) return false
  useEventStore.getState().showPreview({ id: `${key}|haptic|${clip}|${at}`, event: key, target: 'haptic', label: `${key} · ${clip}.wav × ${factorText(made.factor)}`, buffer: made.buffer, autoplay })
  return true
}
/** Opens sound `sound` of event `key` in the waveform panel, at its volume (PC playback only). A loop cue's sound repeats. */
export function openEventSound(key: string, sound: string, volume: number, autoplay = false): boolean {
  const buffer = soundBuffer(sound, volume, loopCue(key) ? LOOP_PREVIEW_SEC : 0)
  if (!buffer) return false
  useEventStore.getState().showPreview({ id: `${key}|sound|${sound}`, event: key, target: 'sound', label: `${key} · ${sound}.wav × ${factorText(volume)}`, buffer, autoplay })
  return true
}

type Part = { start: number; data: Float32Array[]; gain: number }
/** Sums `parts` (sample offsets) into one buffer, clipped to ±1. */
function mixParts(parts: Part[], rate: number, nCh: number): AudioBuffer {
  const length = Math.max(1, ...parts.map(p => p.start + p.data[0].length))
  const buffer = new AudioBuffer({ numberOfChannels: nCh, length, sampleRate: rate })
  for (let c = 0; c < nCh; c++) {
    const out = buffer.getChannelData(c)
    for (const p of parts) { const d = p.data[Math.min(c, p.data.length - 1)]; for (let i = 0; i < d.length; i++) out[p.start + i] += d[i] * p.gain }
    for (let i = 0; i < length; i++) out[i] = Math.max(-1, Math.min(1, out[i]))
  }
  return buffer
}

/** `buffer` played once per firing (at `atSec`, × `gain`, at playback rate `rate`): one firing per mark of a repeated event (DEC-085). */
export function repeatBuffer(buffer: AudioBuffer, plays: readonly { atSec: number; gain: number; rate: number }[]): AudioBuffer {
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c))
  return mixParts(plays.map(p => ({ start: Math.round(p.atSec * buffer.sampleRate), data: channels.map(ch => p.rate === 1 ? ch : resampleClip(ch, p.rate)), gain: p.gain })), buffer.sampleRate, buffer.numberOfChannels)
}

/** The length of event `key`'s (first) sound in seconds; 1 s when it has none loaded. */
export function eventSoundSec(key: string): number {
  const s = useSceneStore.getState(), r = s.table ? resolveEventName(s.table, key) : null, e = r && s.table ? effectiveEvent(s.table, r.ref) : null
  const sound = e?.sfx ? sfxSounds(e.sfx)[0] : undefined
  return (sound && s.sfx[sound]?.duration) || 1
}
let ctx: AudioContext | null = null
// A hot reload of this module must not leave its AudioContext running.
import.meta.hot?.dispose(() => { if (ctx) { void ctx.close(); perfTrack('audioContexts', -1); ctx = null } })
const audio = () => {
  if (!ctx) { ctx = new AudioContext(); perfTrack('audioContexts', 1) }
  if (ctx.state === 'suspended') void ctx.resume()
  return ctx
}
const startOnPc = (source: SoundSource, offset: number) => {
  const c = audio(), src = c.createBufferSource(), g = c.createGain()
  src.buffer = source.buffer; src.loop = !!source.loop; g.gain.value = source.volume
  src.connect(g).connect(c.destination)
  src.start(0, offset)
  return { stop: () => src.stop() }
}

/**
 * While a haptic of an event is played in the editor — an AI candidate of a
 * haptic trial (its first scene cue in the open Scene project), the event's own
 * haptic clip, or a preview sequence (its rendered sound) — the event's sound
 * plays on the PC from the same position. It rings out after the haptic ends
 * (a loop cue's sound stops with it) and stops on a stop. Follows the editor's
 * PC audio toggle (muted = silent).
 *
 * The sound is chosen by value (buffer + volume): store refreshes (the AI trials
 * poll every 2 s) never restart or stop what is playing (CompanionSound).
 */
export function useDecidedSoundSync(player: EditorBufferPlayer) {
  const audition = useAgentTrialStore(s => s.audition)
  // Only what picks the sound: the auditioned trial's scene cues (not the whole, often replaced, trial list).
  const auditionCues = useAgentTrialStore(s => {
    const trial = s.audition ? s.trials.find(r => r.trial.id === s.audition!.trialId)?.trial : undefined
    return trial && trialTarget(trial) === 'haptic' && trial.scene ? `${trial.scene.project}\n${trial.scene.cues.join('\n')}` : ''
  })
  const preview = useEventStore(s => s.preview)
  const muted = useEditorSettings(s => s.muted)
  const table = useSceneStore(s => s.table)
  const lib = useSceneStore(s => s.lib)
  const buffers = useSceneStore(s => s.sfx)
  const picked = useMemo((): SoundSource | null => {
    if (!table || !lib) return null
    let names: string[] = []
    if (audition && auditionCues) {
      const [project, ...cues] = auditionCues.split('\n')
      if (project === lib.project_name) names = cues
    } else if (!audition && preview?.target === 'haptic') names = [preview.event]
    return representativeSound(table, lib, names, buffers)
  }, [audition, auditionCues, preview, table, lib, buffers])
  // A scene (DEC-085): each firing is its own source on the AudioContext clock — the event's sound on the rated
  // cue's firings (with a haptic audition) and the decided sound of the scene's other cues on theirs (no jitter).
  const plan = useAuditionPlan()
  const firings = useMemo((): Firing[] | null => {
    if (!plan || picked?.loop || !table) return null
    const out: Firing[] = []
    if (picked) for (const atSec of plan.targets) out.push({ buffer: picked.buffer, atSec, gain: picked.volume })
    for (const o of plan.others) {
      const r = resolveEventName(table, o.name), e = r && effectiveEvent(table, r.ref), first = sfxSounds(e?.sfx)[0], b = first ? buffers[first] : undefined
      if (e?.sfx && b) out.push({ buffer: b, atSec: o.atSec, gain: e.sfx.volume })
    }
    return out
  }, [plan, picked, table, buffers])
  const companion = useMemo(() => new CompanionSound(startOnPc), [])
  const scheduler = useMemo(() => new FiringScheduler(() => audio()), [])
  // By value (see CompanionSound / FiringScheduler): recomputing the same sounds keeps them playing.
  useEffect(() => {
    scheduler.setFirings(muted || !firings ? [] : firings)
    companion.setSource(muted || firings ? null : picked)
  }, [companion, scheduler, muted, firings, picked?.buffer, picked?.volume, picked?.loop])
  useEffect(() => {
    const play = (time: number) => { companion.play(time); scheduler.play(time) }
    const unsubs = [
      player.on('play', play),
      player.on('seeking', time => { if (player.isPlaying()) play(time) }),
      // A natural end lets one-shot sounds ring out (a loop stops with it); a stop stops them.
      player.on('finish', () => { if (companion.loops) companion.stop() }),
      onUserStop(player, () => { companion.stop(); scheduler.stop() }),
    ]
    return () => { unsubs.forEach(unsub => unsub()); companion.stop(); scheduler.stop() }
  }, [player, companion, scheduler])
}

/** On selecting an event: the waveform panel shows its haptic (first route's clip), else its sound, else the editor clip again. */
export function openEventDefault(key: string) {
  const table = useSceneStore.getState().table
  const e = table ? effectiveEvent(table, parseEventKey(key)) : null
  const route = e?.haptics[0], clip = route ? routeClips(route)[0] : undefined
  if (route && clip && openEventHaptic(key, clip, route.gain, route.at)) return
  const sound = sfxSounds(e?.sfx)[0]
  if (e?.sfx && sound && openEventSound(key, sound, e.sfx.volume)) return
  useEventStore.getState().clearPreview()
}
