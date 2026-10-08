import { effectiveEvent, pairedClips, parseEventKey, resolveEventName } from './cueEvents'
import { routeClips, sfxSounds, soundIntensity, type CueTable } from './sceneCueTable'
import { RATE, resampleClip } from './sceneHaptics'

/**
 * What the editor plays besides the shown material at the representative stretch (DEC-085): the other firings
 * of the stretch. With "play the group" (cue + its variants, e.g. bite and bite:tear), a group member's firing
 * plays the member's representative sound AND haptic (the haptic goes to the devices), each at its material's
 * intensity (no scene multiplier); a cue outside the group plays its sound only (as before).
 * With a shown sound, the shown event's own firings get its haptic too (the clip paired with that sound on a
 * paired cue — also with the group off —, else the representative). Pure: offsets are seconds from the start of the shown buffer.
 */
export interface GroupPlan { targets: readonly number[]; others: readonly { atSec: number; name: string }[] }
export interface HapticPart { clip: string; atSec: number; gain: number }
export interface SoundFiring { sound: string; atSec: number; gain: number }

export function groupFirings(table: CueTable, plan: GroupPlan, shown: { event: string; target: 'sound' | 'haptic'; material: string }, group: boolean): { haptics: HapticPart[]; sounds: SoundFiring[] } {
  const cue = parseEventKey(shown.event).cue
  const haptics: HapticPart[] = [], sounds: SoundFiring[] = []
  const clipGain = (clip: string) => table.clips[clip]?.intensity ?? 1
  for (const o of plan.others) {
    const r = resolveEventName(table, o.name), e = r && effectiveEvent(table, r.ref)
    if (!e) continue
    const sound = e.sfx ? sfxSounds(e.sfx)[0] : undefined
    if (sound) sounds.push({ sound, atSec: o.atSec, gain: soundIntensity(table, sound) })
    // A group member: its representative haptic too (index 0, the pair of its representative sound).
    const clip = e.haptics[0] ? routeClips(e.haptics[0])[0] : undefined
    if (group && r.ref.cue === cue && clip) haptics.push({ clip, atSec: o.atSec, gain: clipGain(clip) })
  }
  const shownEvent = shown.target === 'sound' ? effectiveEvent(table, parseEventKey(shown.event)) : null
  // A shown sound sends its event's haptic with the group, and always on a paired cue (the clip of the same index).
  if (shown.target === 'sound' && (group || shownEvent?.variation?.paired === true)) {
    const e = shownEvent
    const index = e ? sfxSounds(e.sfx).indexOf(shown.material) : -1
    const clip = e ? (index >= 0 ? pairedClips(e, index)[0]?.clip : undefined) ?? (e.haptics[0] ? routeClips(e.haptics[0])[0] : undefined) : undefined
    if (clip) for (const atSec of plan.targets) haptics.push({ clip, atSec, gain: clipGain(clip) })
  }
  return { haptics, sounds }
}

/**
 * The haptic stream of a group play (mono, RATE): `base` (the shown haptic as played, at its own rate; null for a
 * shown sound) plus each part's clip × its gain, `durationSec` long (the player's length, so seeks map 1:1).
 * `layers`: an already rendered stream added as it is (an audition's context loops, renderContextLoops).
 */
export function mixGroupHaptics(base: { data: Float32Array; rate: number } | null, parts: readonly HapticPart[], pcm: Record<string, Float32Array>, durationSec: number, layers: Float32Array | null = null): Float32Array {
  const out = new Float32Array(Math.max(1, Math.round(durationSec * RATE)))
  const add = (data: Float32Array, start: number, gain: number) => { for (let i = 0; i < data.length && start + i < out.length; i++) if (start + i >= 0) out[start + i] += data[i] * gain }
  if (base) add(base.rate === RATE ? base.data : resampleClip(base.data, base.rate / RATE), 0, 1)
  if (layers) add(layers, 0, 1)
  for (const p of parts) { const data = pcm[p.clip]; if (data) add(data, Math.round(p.atSec * RATE), p.gain) }
  for (let i = 0; i < out.length; i++) out[i] = Math.max(-1, Math.min(1, out[i]))
  return out
}

/**
 * What each firing of the stretch plays, for the video overlay ("bite: bite_t51_a" while it sounds) and the marks'
 * titles: a red firing the shown material; a group member its representative of the shown kind (sound / haptic);
 * any other cue its sound (all it plays). `lengthSec`: a material's length (0 when unknown). Null where nothing plays.
 */
export function markMaterials(table: CueTable, marks: readonly { name: string; target: boolean }[], shown: { event: string; target: 'sound' | 'haptic'; material: string } | null,
  group: boolean, lengthSec: (kind: 'sound' | 'haptic', material: string) => number): ({ label: string; material: string; durSec: number } | null)[] {
  const cue = shown ? parseEventKey(shown.event).cue : null
  return marks.map(m => {
    const r = resolveEventName(table, m.name), e = r && effectiveEvent(table, r.ref)
    const label = r?.ref.variant ?? r?.ref.cue ?? m.name
    const kind = shown && m.target ? shown.target : shown && group && r?.ref.cue === cue ? shown.target : 'sound'
    const material = shown && m.target ? shown.material : !e ? undefined : kind === 'sound' ? sfxSounds(e.sfx)[0] : e.haptics[0] ? routeClips(e.haptics[0])[0] : undefined
    return material ? { label, material, durSec: lengthSec(kind, material) } : null
  })
}

/** When the last group haptic ends (seconds; 0 without parts): the playback lasts at least this long. */
export function groupHapticsEnd(parts: readonly HapticPart[], pcm: Record<string, Float32Array>): number {
  return Math.max(0, ...parts.map(p => p.atSec + (pcm[p.clip]?.length ?? 0) / RATE))
}

/** Where the shown haptic sounds (its firings, `lengthSec` each): the live strength applies there only, the group's parts keep their own. */
export function shownSpans(targets: readonly number[] | null, lengthSec: number): [number, number][] {
  return (targets ?? [0]).map(at => [at, at + lengthSec])
}
export const inSpans = (spans: readonly [number, number][], t: number) => spans.some(([a, b]) => t >= a && t < b)
