import { levelAt, type SceneData, type SceneLib } from './sceneData'
import { isLoopCue, routeClips, soundIntensity, type CueTable } from './sceneCueTable'
import { effectiveEvent, parseEventKey, resolveEventName } from './cueEvents'
import { groupContext } from './eventGroups'
import { groupFirings, type SoundFiring } from './groupPlayback'
import { buildLoopSounds, type LoopSound } from './sceneLoopSounds'
import { buildLoopVoices, RATE, type LoopVoice } from './sceneHaptics'
import { mapLevel } from './levelMap'

/**
 * A trial's `scene.context` (hapbeat-trial@1): cues that sound around the target in the game (engage → the cut_loop
 * sound and the feed_loop haptic carrying on). While a candidate is auditioned over the representative stretch,
 * they play with it from the cue table (decided materials, never candidates), as the Scene tab plays them:
 * one-shot cues at their recorded firings, loop cues following their layers' recorded levels.
 */
export interface ContextPlan {
  /** One-shot context firings in the stretch: seconds from the first target firing (the playback's 0 s). */
  firings: { atSec: number; name: string }[]
  /** lib.layers indices of the context loop cues. */
  layers: number[]
  /** Full replay time of the playback's 0 s (the loop levels are read there + the playback time). */
  mark: number
  /** Where the stretch ends (seconds of the playback): a context audition runs at least this long. */
  endSec: number
}

const cueOf = (name: string) => name.split(':')[0]
/** A recorded firing `name` is of context entry `entry`: the same name, or any variant of a bare cue. */
const isOf = (name: string, entry: string) => name === entry || (!entry.includes(':') && cueOf(name) === entry)

/** Context names the open project does not know (unknown cue or variant); [] when all are known. */
export function unknownContextCues(table: CueTable, names: readonly string[]): string[] {
  return names.filter(name => { const r = resolveEventName(table, name); return !r || r.unknownVariant !== null })
}

/**
 * The context of a stretch: `mark` / `end` are full replay times (the first target firing, the stretch's end). Firings
 * from the mark to the end (the lead-in before the mark is not played); loop cues are their layers (their logged
 * firings, if any, are not played as one-shots).
 */
export function contextPlan(data: Pick<SceneData, 'full'>, lib: Pick<SceneLib, 'layers' | 'loop_cues'>, context: readonly string[], mark: number, end: number): ContextPlan {
  const loops = context.filter(c => isLoopCue(lib as SceneLib, cueOf(c)))
  const pulses = context.filter(c => !loops.includes(c))
  const firings = data.full.events
    .filter(e => e.t >= mark - 1e-6 && e.t <= end + 1e-6 && pulses.some(c => isOf(e.name, c)))
    .sort((a, b) => a.t - b.t)
    .map(e => ({ atSec: e.t - mark, name: e.name }))
  const layers = lib.layers.flatMap((l, i) => loops.some(c => cueOf(c) === l.cue) ? [i] : [])
  return { firings, layers, mark, endSec: Math.max(0, end - mark) }
}

/**
 * The context loop cues' haptics as one mono stream (RATE), `durationSec` long: each route's clip looped at its layer's
 * recorded level (through the route's levelMap, DEC-090) and rate (renderChunk's loop voices, sceneHaptics). The editor sends one
 * stream, so a `hand` route's two wrists become one voice following the louder hand. Gain = clip intensity only (no scene route gain),
 * like the context's one-shots.
 */
export function renderContextLoops(table: CueTable, lib: SceneLib, data: Pick<SceneData, 'full' | 'fps'>, plan: Pick<ContextPlan, 'layers' | 'mark'>,
  pcm: Record<string, Float32Array>, durationSec: number): Float32Array | null {
  const voices: LoopVoice[] = buildLoopVoices(table, lib).filter(v => plan.layers.includes(v.layer) && v.side !== 1)
    .map(v => ({ ...v, side: -1, gain: table.clips[v.clip]?.intensity ?? 1 }))
  const live = voices.filter(v => pcm[v.clip]?.length)
  if (!live.length) return null
  const out = new Float32Array(Math.max(1, Math.round(durationSec * RATE)))
  for (const v of live) {
    const p = pcm[v.clip]
    let ph = 0
    for (let i = 0; i < out.length; i++) {
      const [g, r] = levelAt(data.full.levels, data.fps, lib.layers[v.layer], plan.mark + i / RATE, v.side)
      const m = mapLevel(v.levelMap, g)
      if (m > 0) out[i] += p[Math.floor(ph) % p.length] * m * v.gain
      ph = (ph + r) % p.length
    }
  }
  return out
}

/**
 * The context of an audition of `targets` (the stretch's target names, the first names its event): the trial's own
 * `scene.context` and the other cues of the target's 「同時」 group, never a cue of the targets' family. `context` is what
 * they play over the stretch (`mark` / `end`: full replay times); null while 「周りのイベントも鳴らす」 is off (`on`) or without any.
 */
export function auditionContext(o: { own: readonly string[]; groups: readonly (readonly string[])[]; targets: readonly string[]; on: boolean;
  data: Pick<SceneData, 'full'> | null; lib: Pick<SceneLib, 'layers' | 'loop_cues'> | null; mark: number; end: number }): { contextCues: string[]; context: ContextPlan | null } {
  const family = new Set(o.targets.map(n => parseEventKey(n).cue))
  const contextCues = [...new Set([...o.own, ...(o.targets.length ? groupContext(o.groups, parseEventKey(o.targets[0]).cue) : [])])].filter(c => !family.has(parseEventKey(c).cue))
  return { contextCues, context: o.on && contextCues.length && o.data && o.lib ? contextPlan(o.data, o.lib, contextCues, o.mark, o.end) : null }
}

/** The context's one-shot firings as sounds (each event's decided sound at its intensity, as the stretch's other cues; groupFirings). */
export function contextSoundFirings(table: CueTable, plan: Pick<ContextPlan, 'firings'>): SoundFiring[] {
  return groupFirings(table, { targets: [], others: plan.firings }, { event: '', target: 'haptic', material: '' }, false).sounds
}

/** The context's one-shot firings as haptic parts of the device stream: each event's first route clip at its intensity (as a group member's, groupFirings). */
export function contextHapticParts(table: CueTable, plan: Pick<ContextPlan, 'firings'>): { clip: string; atSec: number; gain: number }[] {
  return plan.firings.flatMap(f => {
    const r = resolveEventName(table, f.name), e = r && effectiveEvent(table, r.ref), clip = e?.haptics[0] ? routeClips(e.haptics[0])[0] : undefined
    return clip !== undefined && !table.clips[clip]?.loop ? [{ clip, atSec: f.atSec, gain: table.clips[clip]?.intensity ?? 1 }] : []
  })
}

/** The context loop cues' sounds (lib.loop_cue_sounds; those layers' loop sounds, levelMap kept) at the sound's intensity only (no sfx.volume), like the context's one-shots. */
export function contextLoopSounds(table: CueTable, lib: SceneLib, plan: Pick<ContextPlan, 'layers'>): LoopSound[] {
  return buildLoopSounds(table, lib).filter(x => plan.layers.includes(x.layer)).map(x => ({ ...x, gain: soundIntensity(table, x.sound) }))
}

/** The full replay time whose recorded loop levels play at editor playback time `playSec` (the PC sounds play `leadSec` later). */
export const contextReplayTime = (plan: Pick<ContextPlan, 'mark'>, playSec: number, leadSec = 0) => plan.mark + playSec - leadSec
