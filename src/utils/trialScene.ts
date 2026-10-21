import { buildItems, itemEvents, type SceneData, type SceneLib } from './sceneData'
import type { TrialScene } from './agentProtocol'
import type { TrialSceneChoice } from './editorUiSettings'
import { LEAD_SEC, sceneSegment, TAIL_SEC, type SceneMark, type SceneSegment } from './sceneSegments'

/**
 * Editor Scene video panel: which stretch of the Scene tab project's full replay
 * shows an AI trial's game moment. A trial names its moment with `scene`
 * (hapbeat-trial@1: its cues and optionally a time `at` of the full replay); a moment picked in
 * the panel is saved per trial id in the editor settings as a replay time (TrialSceneChoice).
 */

export interface SceneClipOption {
  /** The option's key in the picker: `segment` for the representative stretch, else the moment's replay time (`@<s>`, momentKey). */
  key: string
  /** The video file (Saved/HapticViewer/<file>): the full replay. */
  file: string
  label: string
  /** Replay time of the cue mark (seconds; playback time 0). */
  mark: number
  /** When the moment happens in the full recording (seconds). */
  at: number
  /** The cue (of `cues`) the moment was matched by; null when any moment is offered. */
  cue: string | null
  /** Firings shown and played (video times; red = the targets, grey = other cues of the family; a moment: its mark). */
  marks: SceneMark[]
  /** Video time the moment ends (the video pauses there); null = the video's end. */
  end: number | null
  /** The stretch of the full replay: the representative one (DEC-085) or a moment's. */
  segment: SceneSegment
}

/** The moments of the recording that contain one of `cues` (every moment when `cues` is null), as their stretches of the full replay, marked at the first matching cue. */
export function trialSceneOptions(data: SceneData, cues: string[] | null): SceneClipOption[] {
  const items = buildItems(data)
  const out: SceneClipOption[] = []
  items.forEach((it, index) => {
    if (it.kind !== 'clip' || (cues && !it.names.some(n => cues.includes(n)))) return
    const own = itemEvents(it, data.full.events).find(e => e.own && (!cues || cues.includes(e.name)))
    const cue = cues ? cues.find(c => it.names.includes(c)) ?? null : null
    // Event names and time only ("03 roar (7.9 s)"); the haptic route (both / right) is not part of the moment's name.
    const mark = own ? own.t : it.event
    const marks: SceneMark[] = [{ t: mark, name: cue ?? it.name, target: true }]
    out.push({ key: momentKey(it.at), file: it.file, label: `${String(index).padStart(2, '0')} ${it.names.join(' + ')} (${it.at.toFixed(1)} s)`, at: it.at, mark, cue, marks, end: it.end,
      segment: { names: [cue ?? it.name], start: it.start, end: it.end, marks, repeating: false, total: 1 } })
  })
  return out
}

export type TrialSceneState =
  /** No Scene project open (`project`: the one wanted, if known). */
  | { kind: 'noProject'; project?: string }
  /** The wanted project is not the open one. */
  | { kind: 'otherProject'; project: string }
  /** The trial's cues never occur in the recording. */
  | { kind: 'noClips'; cues: string[] }
  /** `chosen` null: an older trial without `scene` and no saved pick yet. */
  | { kind: 'ready'; options: SceneClipOption[]; chosen: SceneClipOption | null }

/**
 * What the editor's Scene video panel does about the Scene project. The project open in the Events panel is
 * the only source of its video: a subject of another project gets a note (never a switch), and with no
 * project open the panel links the project last chosen in the Events panel (`last`; null = any folder),
 * not the subject's. null = the open project serves the subject.
 */
export type SceneProjectNeed = { kind: 'link'; project: string | null } | { kind: 'otherProject'; project: string; open: string } | null
export function sceneProjectNeed(state: TrialSceneState, open: string | null, last: string | null): SceneProjectNeed {
  if (state.kind === 'noProject') return { kind: 'link', project: last }
  if (state.kind === 'otherProject') return { kind: 'otherProject', project: state.project, open: open ?? '' }
  return null
}

/** The Scene project a trial / clip wants: the trial's `scene.project`, else the saved pick's, else `fallback` (a trial's `project` label). */
export function wantedSceneProject(o: { scene?: TrialScene; saved?: TrialSceneChoice; fallback?: string }): string | undefined {
  return o.scene?.project ?? o.saved?.project ?? o.fallback
}

/**
 * The representative scene of `targets` cut from the full replay (sceneSegment): a one-off firing, or a
 * repeating cue's continuous scene. The playback's 0 s is its first firing (`mark`).
 */
export function representativeOption(data: SceneData, targets: readonly string[], soundSec: (name: string) => number): SceneClipOption | null {
  const named = targets.filter(n => data.full.events.some(e => e.name === n))
  if (!named.length) return null
  const segment = sceneSegment(data.full.events, named, soundSec(named[0]))
  if (!segment) return null
  const first = segment.marks[0].t
  return { key: REPRESENTATIVE, file: data.full.file, label: `${named[0]} (${first.toFixed(1)} s)`, at: first, mark: first, cue: named[0], marks: segment.marks, end: segment.end, segment }
}

/** The picker key of the representative stretch (saved as `at: null`). */
export const REPRESENTATIVE = 'segment'
/** The picker key of the moment at replay time `t`. */
export const momentKey = (t: number) => `@${t.toFixed(3)}`
/** The saved choice for picker key `key` (REPRESENTATIVE or momentKey) in Scene project `project`. */
export function sceneChoiceOf(project: string, key: string): TrialSceneChoice {
  return { project, at: key === REPRESENTATIVE ? null : Number(key.slice(1)) }
}

/**
 * The moment at replay time `at` (a trial's `scene.at`, a saved pick): the option of `options` at exactly that time (a
 * picked moment), else of those whose stretch contains it the one whose first cue is nearest; else a stretch around it, as a one-off firing of the targets
 * (sceneSegment): from LEAD_SEC before `at` to its sound's length + TAIL_SEC after it, marked at the first firing of the
 * targets in it (at `at` itself when none fires there).
 */
export function momentAt(data: SceneData, options: readonly SceneClipOption[], at: number, targets: readonly string[], soundSec: (name: string) => number): SceneClipOption {
  const exact = options.find(o => o.key === momentKey(at))
  if (exact) return exact
  const containing = options.filter(o => o.segment.start - 1e-9 <= at && at <= o.segment.end + 1e-9)
  const nearest = containing.reduce<SceneClipOption | null>((best, o) => !best || Math.abs(o.at - at) < Math.abs(best.at - at) ? o : best, null)
  if (nearest) return nearest
  const name = targets[0] ?? ''
  const start = Math.max(0, at - LEAD_SEC), end = at + Math.max(0, name ? soundSec(name) : 0) + TAIL_SEC
  const fired = data.full.events.filter(e => targets.includes(e.name)).sort((a, b) => a.t - b.t)
  const inside = fired.filter(e => e.t >= start && e.t <= end)
  const first = inside[0] ?? { t: at, name }
  const marks: SceneMark[] = [{ t: first.t, name: first.name, target: true }]
  return { key: momentKey(at), file: data.full.file, label: `${name || '—'} (${at.toFixed(1)} s)`, at, mark: first.t, cue: name || null, marks, end,
    segment: { names: [first.name], start, end, marks, repeating: false, total: Math.max(1, fired.length) } }
}

/**
 * A trial / event with `scene` (DEC-085): the representative stretch of its first firing cue, cut from the
 * full replay — the editor offers no list of moments. The user's pick for the trial, then the trial's own
 * `scene.at` (a replay time: the moment containing it, momentAt), still win; they are listed after it. Without the
 * cues in the recording: the earliest recorded moment of any of them. Without `scene` (an editor clip): every recorded moment.
 * `soundSec`: the length of an event's sound (one-off stretches end after it).
 */
export function resolveTrialScene(o: { lib: SceneLib | null; data: SceneData | null; scene?: TrialScene; saved?: TrialSceneChoice; project?: string; soundSec?: (name: string) => number; targets?: readonly string[] }): TrialSceneState {
  const wanted = o.project ?? wantedSceneProject(o)
  if (!o.lib || !o.data) return wanted ? { kind: 'noProject', project: wanted } : { kind: 'noProject' }
  if (wanted && wanted !== o.lib.project_name) return { kind: 'otherProject', project: wanted }
  const data = o.data, soundSec = o.soundSec ?? (() => 1)
  const targets = o.targets ?? o.scene?.cues ?? []
  const options = trialSceneOptions(data, o.scene?.cues ?? null)
  const rep = o.scene ? representativeOption(data, targets, soundSec) : null
  if (o.scene && !options.length && !rep && o.scene.at === undefined) return { kind: 'noClips', cues: o.scene.cues }
  const saved = o.saved && o.saved.project === o.lib.project_name ? o.saved : undefined
  // A time inside the representative stretch picks it (a repeating cue's run is one stretch, not its recorded moments).
  const at = (t: number | null | undefined) => t === undefined || t === null ? undefined : momentAt(data, rep ? [rep, ...options] : options, t, targets, soundSec)
  const named = at(o.scene?.at)
  const savedOption = saved?.at === null ? rep ?? undefined : at(saved?.at)
  /** `list` plus the ones not in it (by key). */
  const withExtra = (list: SceneClipOption[], extra: (SceneClipOption | undefined)[]) =>
    extra.reduce<SceneClipOption[]>((out, x) => x && !out.some(y => y.key === x.key) ? [...out, x] : out, list)
  if (rep) return { kind: 'ready', options: withExtra([rep], [savedOption, named]), chosen: savedOption ?? named ?? rep }
  // The user's pick for this trial, else the trial's own `scene.at`, else the earliest moment of any of its
  // cues (footstep → the T-Rex walking in, not a later footstep hidden behind the meat).
  const earliest = o.scene ? options.reduce<SceneClipOption | null>((best, x) => !best || x.at < best.at ? x : best, null) : null
  return { kind: 'ready', options: withExtra(options, [savedOption, named]), chosen: savedOption ?? named ?? earliest }
}

/** Video time for editor playback time `playerTime`: playback time 0 sounds on the cue mark. */
export function sceneVideoTime(mark: number, playerTime: number): number {
  return Math.max(0, mark + playerTime)
}

/** Seconds from the event start (the cue mark = 0; negative in the lead-in) at video time `videoTime`. */
export function sceneEventTime(mark: number, videoTime: number): number {
  return videoTime - mark
}

/** One video frame (1/30 s) from event time `time`, kept inside the video (`videoDuration` unknown = no upper limit). */
export const SCENE_FRAME_SEC = 1 / 30
export function stepSceneFrame(time: number, direction: 1 | -1, mark: number, videoDuration: number): number {
  const next = time + direction * SCENE_FRAME_SEC
  const max = Number.isFinite(videoDuration) && videoDuration > 0 ? videoDuration - mark : Infinity
  return Math.max(-mark, Math.min(max, next))
}
