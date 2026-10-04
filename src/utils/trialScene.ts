import { buildItems, itemEvents, type SceneData, type SceneLib } from './sceneData'
import type { TrialScene } from './agentProtocol'
import type { TrialSceneChoice } from './editorUiSettings'

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
  /** The cue (of `cues`) the clip was matched by; null when any clip is offered. */
  cue: string | null
}

/** Clips of the recording that contain one of `cues` (every clip when `cues` is null), with the mark of the first matching cue. */
export function trialSceneOptions(data: SceneData, cues: string[] | null): SceneClipOption[] {
  const items = buildItems(data)
  const out: SceneClipOption[] = []
  items.forEach((it, index) => {
    if (it.kind !== 'clip' || (cues && !it.names.some(n => cues.includes(n)))) return
    const own = itemEvents(it, data.full.events, data.fps).find(e => e.own && (!cues || cues.includes(e.name)))
    const cue = cues ? cues.find(c => it.names.includes(c)) ?? null : null
    out.push({ file: it.file, label: `${String(index).padStart(2, '0')} ${it.names.join(' + ')} · ${it.hand} (${it.at.toFixed(1)} s)`, mark: own ? own.t : it.event, cue })
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

export function resolveTrialScene(o: { lib: SceneLib | null; data: SceneData | null; scene?: TrialScene; saved?: TrialSceneChoice; project?: string }): TrialSceneState {
  const wanted = o.project ?? wantedSceneProject(o)
  if (!o.lib || !o.data) return wanted ? { kind: 'noProject', project: wanted } : { kind: 'noProject' }
  if (wanted && wanted !== o.lib.project_name) return { kind: 'otherProject', project: wanted }
  const options = trialSceneOptions(o.data, o.scene?.cues ?? null)
  if (o.scene && !options.length) return { kind: 'noClips', cues: o.scene.cues }
  const saved = o.saved && o.saved.project === o.lib.project_name ? options.find(x => x.file === o.saved!.file) : undefined
  // Default: a moment of the first cue listed (an event's own cue before its variants), else the first match.
  const first = o.scene ? options.find(x => x.cue === o.scene!.cues[0]) ?? options[0] : null
  return { kind: 'ready', options, chosen: saved ?? first }
}

/** Video time for editor playback time `playerTime`: playback time 0 sounds on the cue mark. */
export function sceneVideoTime(mark: number, playerTime: number): number {
  return Math.max(0, mark + playerTime)
}
