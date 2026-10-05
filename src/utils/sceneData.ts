/**
 * Scene tab (haptic authoring): the files a game project's recording leaves in
 * `<project>/Saved/HapticViewer/` (written by hapbeat-haptic-authoring
 * `build_viewer.py`, read the same way the standalone viewer did):
 *
 *   viewer-lib.json   the project's `lib`: title, paths of the cue table and the
 *                     clip / sound WAV folders (relative to the project root), the
 *                     `at` vocabulary, loop cues / sounds, name patterns, continuous
 *                     layers, cue families, tick cues, import / record commands
 *   viewer-data.json  the recording: fps, one clip per moment (video file, cues,
 *                     layer levels per frame) and the full replay (events, levels)
 *
 * Everything here is pure: parsing, the item list, cue timing and layer levels.
 */

export const VIEWER_DIR = 'Saved/HapticViewer'
/** Cues this close play "at once" (same value as build_viewer.py MOMENT_S). */
export const MOMENT_S = 0.2

export interface SceneLayer {
  /** The loop cue whose haptics follow this layer's recorded level. */
  cue: string
  /** Level columns of the left / right hand gain. */
  gain: number[]
  /** Level columns of the left / right playback rate, or null. */
  rate: number[] | null
  colors: string[]
}
export interface SceneFamily { label: string; color: string; cues: string[] }
export interface SceneLib {
  title: string
  project_name: string
  paths: { cues: string; clips: string; sounds: string }
  at: string[]
  loop_cues: string[]
  loop_sounds: string[]
  /** Positions a loop-cue route may use (optional; absent = any of `at`). T-Rex: ['hand']. */
  loop_at?: string[]
  /** Loop cues may carry a (looping) cue sound (optional, default false). T-Rex: true; Safety Mill: no. */
  loop_cue_sounds?: boolean
  clip_name: string
  sound_name: string
  layers: SceneLayer[]
  families: SceneFamily[]
  ticks: string[]
  import_command: string
  record_command?: string
}
export interface SceneEvent { t: number; name: string; hand: string; gain?: number }
export interface SceneClip {
  file: string
  /** The moment's first cue (the clip was cut for it). */
  name: string
  names: string[]
  hand: string
  /** Replay time of the cue. */
  at: number
  note: string
  /** Seconds from the clip start to the cue. */
  event: number
  levels: number[][]
}
export interface SceneData {
  fps: number
  clips: SceneClip[]
  full: { file: string; levels: number[][]; events: SceneEvent[] }
}
/** One entry of the moments list: the full replay first, then every clip. */
export interface SceneItem extends SceneClip { kind: 'full' | 'clip' }
/** A cue in an item's video time; `own` marks the cues of the moment a clip was cut for. */
export interface VisibleEvent extends SceneEvent { own: boolean }

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const isString = (value: unknown): value is string => typeof value === 'string'
const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every(isString)
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const isIndices = (value: unknown): value is number[] => Array.isArray(value) && value.every(v => Number.isInteger(v) && (v as number) >= 0)

function parseJson(text: string, file: string): unknown {
  try { return JSON.parse(text) } catch (error) { throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`) }
}

/** viewer-lib.json → SceneLib; throws naming the first field that does not fit. */
export function parseViewerLib(text: string): SceneLib {
  const v = parseJson(text, 'viewer-lib.json')
  const fail = (field: string): never => { throw new Error(`viewer-lib.json: ${field} is missing or invalid`) }
  if (!isRecord(v)) return fail('(root)')
  if (!isString(v.title)) fail('title')
  if (!isString(v.project_name)) fail('project_name')
  const paths = v.paths
  if (!isRecord(paths) || !isString(paths.cues) || !isString(paths.clips) || !isString(paths.sounds)) fail('paths')
  for (const key of ['at', 'loop_cues', 'loop_sounds', 'ticks'] as const) if (!isStrings(v[key])) fail(key)
  if (v.loop_at !== undefined && !isStrings(v.loop_at)) fail('loop_at')
  if (v.loop_cue_sounds !== undefined && typeof v.loop_cue_sounds !== 'boolean') fail('loop_cue_sounds')
  for (const key of ['clip_name', 'sound_name'] as const) {
    if (!isString(v[key])) fail(key)
    try { new RegExp(v[key] as string) } catch { fail(key) }
  }
  if (!Array.isArray(v.layers) || !v.layers.every(l => isRecord(l) && isString(l.cue) && isIndices(l.gain) && (l.rate === null || l.rate === undefined || isIndices(l.rate)) && isStrings(l.colors))) fail('layers')
  if (!Array.isArray(v.families) || !v.families.every(f => isRecord(f) && isString(f.label) && isString(f.color) && isStrings(f.cues))) fail('families')
  if (!isString(v.import_command)) fail('import_command')
  const lib = v as unknown as SceneLib
  return { ...lib, layers: lib.layers.map(l => ({ ...l, rate: l.rate ?? null })) }
}

function isLevels(value: unknown): value is number[][] {
  return Array.isArray(value) && value.every(row => Array.isArray(row) && row.every(isNumber))
}

/** viewer-data.json → SceneData; throws naming the first field that does not fit. */
export function parseViewerData(text: string): SceneData {
  const v = parseJson(text, 'viewer-data.json')
  const fail = (field: string): never => { throw new Error(`viewer-data.json: ${field} is missing or invalid`) }
  if (!isRecord(v)) return fail('(root)')
  if (!isNumber(v.fps) || v.fps <= 0) fail('fps')
  const full = v.full
  if (!isRecord(full) || !isString(full.file) || !isLevels(full.levels)) fail('full')
  const events = (full as Record<string, unknown>).events
  if (!Array.isArray(events) || !events.every(e => isRecord(e) && isNumber(e.t) && isString(e.name) && isString(e.hand) && (e.gain === undefined || isNumber(e.gain)))) fail('full.events')
  if (!Array.isArray(v.clips) || !v.clips.every(c => isRecord(c) && isString(c.file) && isString(c.name) && isStrings(c.names) && isString(c.hand)
    && isNumber(c.at) && isNumber(c.event) && isLevels(c.levels) && (c.note === undefined || isString(c.note)))) fail('clips')
  const data = v as unknown as SceneData
  return { ...data, clips: data.clips.map(c => ({ ...c, note: c.note ?? '' })) }
}

/** The moments list: the full replay, then one entry per clip. */
export function buildItems(data: SceneData): SceneItem[] {
  return [
    { kind: 'full', file: data.full.file, name: 'full', names: [], hand: '', at: 0, note: '', event: 0, levels: data.full.levels },
    ...data.clips.map(c => ({ kind: 'clip' as const, ...c })),
  ]
}

/** Replay time = video time + offset (a clip starts `event` seconds before its cue at replay time `at`). */
export const offsetOf = (item: SceneItem) => item.kind === 'full' ? 0 : item.at - item.event
export const clipEnd = (item: SceneItem, fps: number) => item.kind === 'full' ? Infinity : item.levels.length / fps

/** Cues visible in an item, in its video time. */
export function itemEvents(item: SceneItem, all: SceneEvent[], fps: number): VisibleEvent[] {
  if (item.kind === 'full') return all.map(e => ({ ...e, own: false }))
  const o = offsetOf(item), end = clipEnd(item, fps)
  return all.filter(e => e.t - o >= 0 && e.t - o <= end)
    .map(e => ({ ...e, t: e.t - o, own: item.names.includes(e.name) && Math.abs(e.t - o - item.event) <= MOMENT_S }))
}

/** The cue E / W act on: a clip's own cue, or in the full replay the last non-tick cue up to just after `t`. */
export function focusEvent(item: SceneItem, events: VisibleEvent[], t: number, ticks: string[]): VisibleEvent | undefined {
  if (item.kind === 'clip') return events.find(x => x.own && x.name === item.name) ?? { t: item.event, name: item.name, hand: item.hand, own: true }
  return events.filter(x => !ticks.includes(x.name) && x.t <= t + 0.6).pop() ?? events[0]
}

/** Distinct non-tick cues within MOMENT_S of `t` (the cues that play together with the selected one). */
export function momentCues(events: VisibleEvent[], t: number | null, ticks: string[]): string[] {
  if (t == null) return []
  return [...new Set(events.filter(e => Math.abs(e.t - t) <= MOMENT_S && !ticks.includes(e.name)).map(e => e.name))]
}

/** Marker colour by family (not per cue): the label on the marker names the cue. A `cue:variant` takes its cue's family. */
export function familyColor(lib: SceneLib, name: string): string {
  const cue = name.split(':')[0]
  return lib.families.find(f => f.cues.includes(name) || f.cues.includes(cue))?.color ?? '#888888'
}

/**
 * Recorded layer level at replay time `t`: [gain, playback rate], linearly
 * interpolated between frames. `side` 0 / 1 = left / right hand; -1 (a route
 * at a fixed position) follows the louder hand.
 */
export function levelAt(levels: number[][], fps: number, layer: SceneLayer, t: number, side: number): [number, number] {
  const f = t * fps, i = Math.floor(f)
  if (i < 0 || i >= levels.length - 1) return [0, 1]
  const k = f - i, at = (j: number) => levels[i][j] + (levels[i + 1][j] - levels[i][j]) * k
  const s = side >= 0 ? side : at(layer.gain[1]) > at(layer.gain[0]) ? 1 : 0
  return [at(layer.gain[s]), layer.rate ? at(layer.rate[s]) : 1]
}

export function frameAt(item: SceneItem, fps: number, t: number): number {
  return Math.min(Math.floor(t * fps + 1e-4), item.levels.length - 1)
}
