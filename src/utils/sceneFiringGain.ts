import { effectiveEvent, falloffGain, fireShot, MaterialPicker, resolveEventName, scaleAt } from './cueEvents'
import { isLoopCue, routeClips, soundIntensity, type CueTable } from './sceneCueTable'
import type { SceneEvent } from './sceneData'
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

export function firingGains(table: CueTable, events: readonly SceneEvent[], ev: SceneEvent): FiringGains {
  const r = resolveEventName(table, ev.name), e = r && effectiveEvent(table, r.ref)
  if (!e || isLoopCue(table, e.ref.cue)) return { sound: null, haptics: null }
  const shot = fireShot(e, false, new FirstPicker(), NO_JITTER, runPosition(events, ev), ev.dist)
  const sound = e.sfx && shot.sound ? shot.soundGain * soundIntensity(table, shot.sound) : e.sfx ? 0 : null
  const routes = shot.routes.flatMap(x => { const clip = table.clips[x.clip]; return clip && !clip.loop ? [clip.intensity * x.gain * (ev.gain ?? 1)] : [] })
  return { sound, haptics: e.haptics.length ? Math.max(0, ...routes) : null }
}

/** Gains of every firing of the recording, keyed by firingKey (replay time). */
export function recordingFiringGains(table: CueTable, events: readonly SceneEvent[]): Map<string, FiringGains> {
  return new Map(events.map(ev => [firingKey(ev.name, ev.t), firingGains(table, events, ev)]))
}
/**
 * A haptic one-shot firing's strength in its groups (DEC-102 r3; never mixed): `material` = the loudest route's clip
 * intensity (editor / Kit; the Scene tab never edits it), `software` = that route's gain × the variant's hapticsGain
 * (ramp) × distanceFalloff × the firing's own gain, `sent` = material × software (what fire() sends, before this PC's
 * overall multiplier and the send clamp). The software multiplier is `route` × `scale` (variant × falloff) × `firing`
 * (viewer-data events[].gain, omitted = 1). Resolved like firingGains (the representative clip of each route, no
 * jitter). null: not a haptic one-shot (no routes, a loop cue, an unknown event).
 */
export interface FiringStrength { software: number; material: number; sent: number; route: number; scale: number; firing: number }

export function firingStrength(table: CueTable, events: readonly SceneEvent[], ev: SceneEvent): FiringStrength | null {
  const r = resolveEventName(table, ev.name), e = r && effectiveEvent(table, r.ref)
  if (!e || !e.haptics.length || isLoopCue(table, e.ref.cue)) return null
  const scale = scaleAt(e, runPosition(events, ev)).haptics * falloffGain(e.falloff, ev.dist), firing = ev.gain ?? 1
  let best: FiringStrength | null = null
  for (const route of e.haptics) {
    const name = routeClips(route)[0], clip = name === undefined ? undefined : table.clips[name]
    if (clip?.loop) continue
    const software = route.gain * scale * firing, material = clip?.intensity ?? 0, sent = material * software
    if (!best || sent > best.sent) best = { software, material, sent, route: route.gain, scale, firing }
  }
  return best
}
/** Strength of every firing of the recording, keyed by firingKey (replay time). */
export function recordingFiringStrength(table: CueTable, events: readonly SceneEvent[]): Map<string, FiringStrength | null> {
  return new Map(events.map(ev => [firingKey(ev.name, ev.t), firingStrength(table, events, ev)]))
}

/** A firing's key: its name and replay time (ms). */
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
