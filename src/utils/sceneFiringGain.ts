import { effectiveEvent, fireShot, MaterialPicker, resolveEventName } from './cueEvents'
import { isLoopCue, soundIntensity, type CueTable } from './sceneCueTable'
import type { SceneEvent, SceneLib } from './sceneData'
import { runPosition } from './sceneSegments'

/**
 * The gain a one-shot firing on the Scene timeline plays at, resolved like the runtime's fire() (fireShot, then
 * playSfx / shotVoices): the event's representative materials (the first starred, no random pick) and no jitter.
 * sound = sound intensity × sfx.volume × variant sfxVolume (ramp) × distanceFalloff; haptics = the loudest route's
 * clip intensity × route gain × variant hapticsGain (ramp) × distanceFalloff × the recorded firing gain.
 * null: the lane does not show it as a one-shot (no sound / a loop cue, which the layer level drives).
 */
export interface FiringGains { sound: number | null; haptics: number | null }

/** The representative of each pick (the first option), so a bar does not change between frames. */
class FirstPicker extends MaterialPicker {
  override pick<T>(_key: string, options: readonly T[]): T | undefined { return options[0] }
}
/** random() = 0.5 makes every jitter of fireShot 0. */
const NO_JITTER = () => 0.5

export function firingGains(table: CueTable, lib: SceneLib, events: readonly SceneEvent[], ev: SceneEvent): FiringGains {
  const r = resolveEventName(table, ev.name), e = r && effectiveEvent(table, r.ref)
  if (!e || isLoopCue(lib, e.ref.cue)) return { sound: null, haptics: null }
  const shot = fireShot(e, false, new FirstPicker(), NO_JITTER, runPosition(events, ev), ev.dist)
  const sound = e.sfx && shot.sound ? shot.soundGain * soundIntensity(table, shot.sound) : e.sfx ? 0 : null
  const routes = shot.routes.flatMap(x => { const clip = table.clips[x.clip]; return clip && !clip.loop ? [clip.intensity * x.gain * (ev.gain ?? 1)] : [] })
  return { sound, haptics: e.haptics.length ? Math.max(0, ...routes) : null }
}

/** Gains of every firing of the recording, keyed by firingKey (replay time). */
export function recordingFiringGains(table: CueTable, lib: SceneLib, events: readonly SceneEvent[]): Map<string, FiringGains> {
  return new Map(events.map(ev => [firingKey(ev.name, ev.t), firingGains(table, lib, events, ev)]))
}
/** A firing's key: its name and replay time (ms, so an item's offset added back still matches). */
export const firingKey = (name: string, replaySec: number) => `${name}@${Math.round(replaySec * 1000)}`

/** Shortest bar drawn for a gain above 0 (CSS px). */
export const MIN_BAR_PX = 3
/**
 * A firing's bar in a lane from `y0` (gain 1) to `y1` (gain 0): its top y; `over` above 1 (clamped to the lane top,
 * drawn with a cap mark); `stub` at 0 (drawn dotted).
 */
export function firingBar(gain: number, y0: number, y1: number, minPx = MIN_BAR_PX): { top: number; over: boolean; stub: boolean } {
  if (!(gain > 0)) return { top: y1, over: false, stub: true }
  const height = Math.max(minPx, Math.min(1, gain) * (y1 - y0))
  return { top: y1 - height, over: gain > 1, stub: false }
}
