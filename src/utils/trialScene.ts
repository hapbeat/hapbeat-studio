import { buildItems, itemEvents, type SceneData, type SceneLib } from './sceneData'
import type { TrialScene } from './agentProtocol'
import type { TrialSceneChoice } from './editorUiSettings'
import { representativeSegment, TAIL_SEC, type SceneSegment } from './sceneSegments'

/**
 * Editor Scene video panel: which recorded clip of the Scene tab project shows
 * an AI trial's game moment. A trial names its moment with `scene`
 * (hapbeat-trial@1); older trials get a clip picked in the panel, saved per
 * trial id in the editor settings.
 */

export interface SceneClipOption {
  /** The clip's video file (Saved/HapticViewer/<file>); also the saved choice key. */
  file: string
  label: string
  /** Time of the cue mark in the clip video (seconds). */
  mark: number
  /** When the moment happens in the full recording (seconds). */
  at: number
  /** The cue (of `cues`) the clip was matched by; null when any clip is offered. */
  cue: string | null
  /** Every firing shown and played (video times; a clip: its mark only). */
  marks: number[]
  /** Video time the moment ends (the video pauses there); null = the video's end. */
  end: number | null
  /** The representative stretch of the full replay (DEC-085); null for a recorded clip. */
  segment: SceneSegment | null
}

/** Clips of the recording that contain one of `cues` (every clip when `cues` is null), with the mark of the first matching cue. */
export function trialSceneOptions(data: SceneData, cues: string[] | null): SceneClipOption[] {
  const items = buildItems(data)
  const out: SceneClipOption[] = []
  items.forEach((it, index) => {
    if (it.kind !== 'clip' || (cues && !it.names.some(n => cues.includes(n)))) return
    const own = itemEvents(it, data.full.events, data.fps).find(e => e.own && (!cues || cues.includes(e.name)))
    const cue = cues ? cues.find(c => it.names.includes(c)) ?? null : null
    // Event names and time only ("03 roar (7.9 s)"); the haptic route (both / right) is not part of the moment's name.
    const mark = own ? own.t : it.event
    out.push({ file: it.file, label: `${String(index).padStart(2, '0')} ${it.names.join(' + ')} (${it.at.toFixed(1)} s)`, at: it.at, mark, cue, marks: [mark], end: null, segment: null })
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

/** The Scene project a trial / clip wants: the trial's `scene.project`, else the saved pick's, else `fallback` (a trial's `project` label). */
export function wantedSceneProject(o: { scene?: TrialScene; saved?: TrialSceneChoice; fallback?: string }): string | undefined {
  return o.scene?.project ?? o.saved?.project ?? o.fallback
}

/**
 * The representative moment of the first of `cues` that fires in the recording, cut from the full replay: one
 * firing (a repeated event: the first of its run) from 1 s before to the sound's length + 0.5 s after — one mark,
 * played once. `segment` keeps the run (its marks) for "×5".
 */
export function representativeOption(data: SceneData, cues: readonly string[], soundSec: (name: string) => number): SceneClipOption | null {
  for (const name of cues) {
    const segment = representativeSegment(data.full.events, name, soundSec(name))
    const first = segment?.marks[0]
    if (segment && first !== undefined) return { file: data.full.file, label: `${name} (${first.toFixed(1)} s)`, at: first, mark: first, cue: name, marks: [first], end: first + Math.max(0, soundSec(name)) + TAIL_SEC, segment }
  }
  return null
}

/**
 * A trial / event with `scene` (DEC-085): the representative stretch of its first firing cue, cut from the
 * full replay — the editor offers no list of moments. The user's pick for the trial, then the trial's own
 * `scene.clip` (a recorded clip), still win; they are listed after it. Without the cues in the recording:
 * the earliest recorded clip of any of them. Without `scene` (an editor clip): every recorded clip.
 * `soundSec`: the length of an event's sound (one-off stretches end after it).
 */
export function resolveTrialScene(o: { lib: SceneLib | null; data: SceneData | null; scene?: TrialScene; saved?: TrialSceneChoice; project?: string; soundSec?: (name: string) => number }): TrialSceneState {
  const wanted = o.project ?? wantedSceneProject(o)
  if (!o.lib || !o.data) return wanted ? { kind: 'noProject', project: wanted } : { kind: 'noProject' }
  if (wanted && wanted !== o.lib.project_name) return { kind: 'otherProject', project: wanted }
  const options = trialSceneOptions(o.data, o.scene?.cues ?? null)
  const rep = o.scene ? representativeOption(o.data, o.scene.cues, o.soundSec ?? (() => 1)) : null
  if (o.scene && !options.length && !rep) return { kind: 'noClips', cues: o.scene.cues }
  const savedFile = o.saved && o.saved.project === o.lib.project_name ? o.saved.file : undefined
  if (rep) {
    const named = o.scene?.clip ? options.find(x => x.file === o.scene!.clip) : undefined
    const savedOption = savedFile === rep.file ? rep : options.find(x => x.file === savedFile)
    const extra = [...new Set([savedOption, named].filter((x): x is SceneClipOption => !!x && x !== rep))]
    return { kind: 'ready', options: [rep, ...extra], chosen: savedOption ?? named ?? rep }
  }
  const saved = savedFile ? options.find(x => x.file === savedFile) : undefined
  // The user's pick for this trial, else the trial's own `scene.clip`, else the earliest moment of any of its
  // cues (footstep → the T-Rex walking in, not a later footstep hidden behind the meat).
  const named = o.scene?.clip ? options.find(x => x.file === o.scene!.clip) : undefined
  const earliest = o.scene ? options.reduce<SceneClipOption | null>((best, x) => !best || x.at < best.at ? x : best, null) : null
  return { kind: 'ready', options, chosen: saved ?? named ?? earliest }
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
