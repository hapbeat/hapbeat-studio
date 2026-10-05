import { useEffect, useMemo } from 'react'
import { useAgentTrialStore } from '@/stores/agentTrialStore'
import { useEditorSettings } from '@/stores/editorSettings'
import { useEventStore } from '@/stores/eventStore'
import { useSceneStore } from '@/stores/sceneStore'
import { trialTarget } from '@/utils/agentProtocol'
import { effectiveEvent, parseEventKey, planSequence, resolveEventName, type PlannedShot } from '@/utils/cueEvents'
import { isLoopCue, routeClips, sfxSounds } from '@/utils/sceneCueTable'
import { RATE, resampleClip } from '@/utils/sceneHaptics'
import type { EditorBufferPlayer } from '@/utils/editorBufferPlayer'
import { onUserStop } from '@/utils/playerStops'
import { CompanionSound, type SoundSource } from '@/utils/companionSound'
import { planSegmentShots, representativeSegment, type SceneSegment } from '@/utils/sceneSegments'
import { useSceneSegmentShots } from '@/utils/editorSceneSync'

/**
 * Event materials in the editor: an event's sound / haptic clip opened in the
 * waveform panel (played by the normal playback), a rendered preview sequence
 * (`preview.repeat` firings with their variation), and the event's sound played
 * on the PC with a haptic audition of the same event.
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

/** Opens route clip `clip` of event `key` in the waveform panel, at the level the game plays it (clip intensity × route gain). A loop cue's clip repeats. */
export function openEventHaptic(key: string, clip: string, gain: number, at: string): boolean {
  const s = useSceneStore.getState(), pcm = s.pcm[clip], entry = s.table?.clips[clip]
  if (!pcm || !entry) return false
  const factor = entry.intensity * gain, loop = loopCue(key)
  useEventStore.getState().showPreview({ id: `${key}|haptic|${clip}|${at}`, event: key, target: 'haptic', label: `${key} · ${clip}.wav × ${factorText(factor)}`, buffer: scaled([pcm], RATE, factor, loop ? LOOP_PREVIEW_SEC : 0) })
  return true
}
/** Opens sound `sound` of event `key` in the waveform panel, at its volume (PC playback only). A loop cue's sound repeats. */
export function openEventSound(key: string, sound: string, volume: number): boolean {
  const b = useSceneStore.getState().sfx[sound]
  if (!b) return false
  const channels = Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c))
  useEventStore.getState().showPreview({ id: `${key}|sound|${sound}`, event: key, target: 'sound', label: `${key} · ${sound}.wav × ${factorText(volume)}`,
    buffer: scaled(channels, b.sampleRate, volume, loopCue(key) ? LOOP_PREVIEW_SEC : 0) })
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
/** The repeated run of event `key` in the open recording (DEC-085), or null for a one-off / absent event. */
export function eventRun(key: string): SceneSegment | null {
  const data = useSceneStore.getState().data
  const seg = data ? representativeSegment(data.full.events, key, eventSoundSec(key)) : null
  return seg?.run ? seg : null
}

/**
 * "Repeat ×N ▶": renders the event's preview sequence — each firing with its own
 * picks and jitter — into one haptic buffer (16 kHz; the routes summed) shown in
 * the waveform panel (normal playback: devices per "send haptics"), and one
 * sound buffer played with it on the PC. Returns the shots for the read-out.
 * A repeated event of the recording uses its real firing times (the representative
 * run, DEC-085); `preview` is the stand-in when there is no recording of it.
 */
export function openEventSequence(key: string): PlannedShot[] | null {
  const s = useSceneStore.getState(), table = s.table, lib = s.lib
  const e = table ? effectiveEvent(table, parseEventKey(key)) : null
  if (!e || !table || !lib) return null
  const run = eventRun(key)
  const shots = run ? planSegmentShots(e, run.marks, isLoopCue(lib, e.ref.cue)) : planSequence(e, isLoopCue(lib, e.ref.cue))
  // Haptics: every route of every shot (clip intensity × route gain × jitter), at the shot's rate.
  const hapticParts = shots.flatMap(shot => shot.routes.flatMap(r => {
    const pcm = s.pcm[r.clip], clip = table.clips[r.clip]
    return pcm && clip ? [{ start: Math.round(shot.atSec * RATE), data: resampleClip(pcm, shot.rate), gain: clip.intensity * r.gain }] : []
  }))
  // Sound: the picked sound per shot, pitch as a rate change, volume × jitter.
  const first = shots.map(sh => sh.sound && s.sfx[sh.sound]).find(Boolean) || null
  const soundRate = first ? first.sampleRate : 48000, channels = first ? first.numberOfChannels : 1
  const soundParts = shots.flatMap(shot => {
    const b = shot.sound ? s.sfx[shot.sound] : undefined
    if (!b) return []
    const rate = 2 ** (shot.pitchSt / 12) * (b.sampleRate / soundRate)
    return [{ start: Math.round(shot.atSec * soundRate), data: Array.from({ length: channels }, (_, c) => resampleClip(b.getChannelData(Math.min(c, b.numberOfChannels - 1)), rate)), gain: shot.soundGain }]
  })
  const mix = mixParts
  const hapticBuf = hapticParts.length ? mix(hapticParts.map(p => ({ ...p, data: [p.data] })), RATE, 1) : null
  const soundBuf = soundParts.length ? mix(soundParts, soundRate, channels) : null
  const label = `${key} · ×${shots.length}`
  if (hapticBuf) useEventStore.getState().showPreview({ id: `${key}|seq`, event: key, target: 'haptic', label, buffer: hapticBuf, shots, companion: soundBuf ? { buffer: soundBuf, volume: 1 } : undefined, autoplay: true })
  else if (soundBuf) useEventStore.getState().showPreview({ id: `${key}|seq`, event: key, target: 'sound', label, buffer: soundBuf, shots, autoplay: true })
  else return null
  return shots
}

let ctx: AudioContext | null = null
const audio = () => {
  if (!ctx) ctx = new AudioContext()
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
    if (preview?.companion) return preview.companion
    if (!table || !lib) return null
    let names: string[] = []
    if (audition && auditionCues) {
      const [project, ...cues] = auditionCues.split('\n')
      if (project === lib.project_name) names = cues
    } else if (!audition && preview?.target === 'haptic') names = [preview.event]
    for (const name of names) {
      const r = resolveEventName(table, name), e = r && effectiveEvent(table, r.ref)
      const first = sfxSounds(e?.sfx)[0]
      if (e?.sfx && first && buffers[first]) return { buffer: buffers[first], volume: e.sfx.volume, loop: isLoopCue(lib, e.ref.cue) }
    }
    return null
  }, [audition, auditionCues, preview, table, lib, buffers])
  // A repeated event shown with its run (Scene video panel): the sound fires on every mark, each with its own pick and jitter.
  const segmentShots = useSceneSegmentShots(s => s.shots)
  const repeated = useMemo((): SoundSource | null => {
    if (!picked || preview?.companion || !segmentShots || segmentShots.length < 2 || picked.loop) return picked
    const sfx = useSceneStore.getState().sfx
    const parts = segmentShots.flatMap(shot => {
      const b = (shot.sound && sfx[shot.sound]) || picked.buffer
      if (b.sampleRate !== picked.buffer.sampleRate) return []
      const rate = 2 ** (shot.pitchSt / 12)
      return [{ start: Math.round(shot.atSec * b.sampleRate), data: Array.from({ length: picked.buffer.numberOfChannels }, (_, c) => resampleClip(b.getChannelData(Math.min(c, b.numberOfChannels - 1)), rate)), gain: shot.soundGain }]
    })
    return parts.length ? { buffer: mixParts(parts, picked.buffer.sampleRate, picked.buffer.numberOfChannels), volume: 1 } : picked
  }, [picked, preview?.companion, segmentShots])
  const companion = useMemo(() => new CompanionSound(startOnPc), [])
  // By value: the same buffer / volume / loop keeps playing (see CompanionSound).
  useEffect(() => { companion.setSource(muted ? null : repeated) }, [companion, muted, repeated?.buffer, repeated?.volume, repeated?.loop])
  useEffect(() => {
    const unsubs = [
      player.on('play', time => companion.play(time)),
      player.on('seeking', time => { if (player.isPlaying()) companion.play(time) }),
      // A natural end lets a one-shot sound ring out (a loop stops with it); a stop stops it.
      player.on('finish', () => { if (companion.loops) companion.stop() }),
      onUserStop(player, () => companion.stop()),
    ]
    return () => { unsubs.forEach(unsub => unsub()); companion.stop() }
  }, [player, companion])
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
