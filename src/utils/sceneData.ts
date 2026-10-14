import { AT_VALUES, SceneFormatError } from './sceneCueTable'

/**
 * Scene tab (haptic authoring): the files a game project's recording leaves in
 * `<project>/Saved/HapticViewer/` (hapbeat-contracts `specs/scene-recording.md`,
 * `schema_version` 1, written by `hapbeat-helper scene build`):
 *
 *   viewer-lib.json   the project's settings: title, paths of the cue table and the
 *                     clip / sound WAV folders (relative to the project root), and
 *                     optionally the `at` choices, continuous layers, cue families,
 *                     tick cues, moment rules, import / record commands
 *   viewer-data.json  the recording: fps, the full replay video, its cue events and
 *                     the loop cues' levels per frame (named columns)
 *
 * The moments list is made here from the events (deriveMoments): each moment is a
 * stretch of the full replay, not a video of its own. Everything here is pure:
 * parsing, the moments, the item list, cue timing and layer levels.
 */

export const VIEWER_DIR = 'Saved/HapticViewer'
/** The Scene recording format this Studio reads (scene-recording `schema_version`). */
export const SCENE_FORMAT_VERSION = 1
/** Cues this close play "at once" and share a moment (scene-recording section 3.4). */
export const MOMENT_S = 0.2
/** A moment's stretch of the full replay: from this long before its first cue … */
export const MOMENT_BEFORE_S = 2.0
/** … to this long after it. */
export const MOMENT_AFTER_S = 3.0

export interface SceneLayer {
  /** The loop cue whose haptics and loop sound follow this layer's recorded level. */
  cue: string
  /** Level columns of the left / right hand input (the same column twice for a cue without sides). */
  gain: number[]
  /** Level columns of the left / right playback rate, or null. */
  rate: number[] | null
  colors: string[]
}
export interface SceneFamily { label: string; color: string; cues: string[] }
/** How many moments a cue gets (keys `<cue>` or `<cue>:<variant>`, see ruleKey). */
export interface MomentRules { max: Record<string, number>; min_gap_s: Record<string, number>; default_max: number | null }
export interface SceneLib {
  title: string
  project_name: string
  paths: { cues: string; clips: string; sounds: string }
  /** Positions the screen offers for routes (default: every position). */
  at: string[]
  /** Positions the screen offers for a loop cue's routes (default: `at`). */
  loop_at: string[]
  /** The cue table's loop cues once it is read (before: the recording's layer cues). Not in the file. */
  loop_cues: string[]
  layers: SceneLayer[]
  families: SceneFamily[]
  ticks: string[]
  moment_rules: MomentRules
  /** "Apply to the game" command ('' = none, not shown). */
  import_command: string
  record_command?: string
}
/** `dist`: the distance to the player when it fired (cm), when the game logged it (distanceFalloff). `hand` '' = not given. */
export interface SceneEvent { t: number; name: string; hand: string; gain?: number; dist?: number; note?: string }
/** One moment of the recording: a stretch of the full replay around its first cue. */
export interface SceneClip {
  /** The full replay video (every moment plays a stretch of it). */
  file: string
  /** The moment's first cue. */
  name: string
  names: string[]
  hand: string
  /** Replay time of the first cue. */
  at: number
  note: string
  /** Video time of the first cue (the video is the full replay: the same as `at`). */
  event: number
  /** The stretch of the full replay (seconds). */
  start: number
  end: number
  levels: number[][]
}
export interface SceneData {
  fps: number
  clips: SceneClip[]
  /** `columns`: the names of the level columns (scene-recording section 2.1; empty without loop cues). */
  full: { file: string; levels: number[][]; columns: string[]; events: SceneEvent[] }
}
/** One entry of the moments list: the full replay first, then every moment. */
export interface SceneItem extends SceneClip { kind: 'full' | 'clip' }
/** A cue in an item's video time; `own` marks the cues of the item's moment. */
export interface VisibleEvent extends SceneEvent { own: boolean }

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const isString = (value: unknown): value is string => typeof value === 'string'
const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every(isString)
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const isPair = (value: unknown): value is number[] => Array.isArray(value) && value.length === 2 && value.every(v => Number.isInteger(v) && (v as number) >= 0)
const isNumberMap = (value: unknown, ok: (v: unknown) => boolean) => value === undefined || (isRecord(value) && Object.values(value).every(ok))
const isPositions = (value: unknown): value is string[] => isStrings(value) && value.length > 0 && value.every(a => AT_VALUES.includes(a))

function parseJson(text: string, file: string): unknown {
  try { return JSON.parse(text) } catch (error) { throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`) }
}

/** Layer colours [left, right] by layer order, for layers made from the column names. */
const LAYER_COLORS = [['#4ea1ff', '#ff8a3d'], ['#5cd18b', '#c77dff'], ['#f5d547', '#ff5c8a'], ['#3dd6d0', '#ffb020']]

/**
 * viewer-lib.json → SceneLib; throws naming the first field that does not fit, or SceneFormatError for another
 * `schema_version`. Omitted fields get their defaults; `layers` stays empty when omitted (made from the recording's
 * columns, layersFromColumns) and `loop_cues` is the layers' cues until the cue table is read.
 */
export function parseViewerLib(text: string): SceneLib {
  const v = parseJson(text, 'viewer-lib.json')
  const fail = (field: string): never => { throw new Error(`viewer-lib.json: ${field} is missing or invalid`) }
  if (!isRecord(v)) return fail('(root)')
  if (v.schema_version !== SCENE_FORMAT_VERSION) throw new SceneFormatError('viewer-lib.json')
  if (!isString(v.title)) fail('title')
  if (!isString(v.project_name)) fail('project_name')
  const paths = v.paths
  if (!isRecord(paths) || !isString(paths.cues) || !isString(paths.clips) || !isString(paths.sounds)) return fail('paths')
  if (v.at !== undefined && !isPositions(v.at)) fail('at')
  if (v.loop_at !== undefined && !isPositions(v.loop_at)) fail('loop_at')
  if (v.ticks !== undefined && !isStrings(v.ticks)) fail('ticks')
  if (v.families !== undefined && !(Array.isArray(v.families) && v.families.every(f => isRecord(f) && isString(f.label) && isString(f.color) && isStrings(f.cues)))) fail('families')
  if (v.layers !== undefined && !(Array.isArray(v.layers) && v.layers.every(l => isRecord(l) && isString(l.cue) && isPair(l.level)
    && (l.rate === null || l.rate === undefined || isPair(l.rate)) && isStrings(l.colors)))) fail('layers')
  const rules = v.moment_rules
  if (rules !== undefined && !(isRecord(rules) && isNumberMap(rules.max, x => Number.isInteger(x) && (x as number) >= 1)
    && isNumberMap(rules.min_gap_s, x => isNumber(x) && x >= 0) && (rules.default_max === undefined || rules.default_max === null || (Number.isInteger(rules.default_max) && (rules.default_max as number) >= 1)))) fail('moment_rules')
  for (const key of ['import_command', 'record_command'] as const) if (v[key] !== undefined && !isString(v[key])) fail(key)
  const at = (v.at as string[] | undefined) ?? [...AT_VALUES]
  const layers = ((v.layers ?? []) as { cue: string; level: number[]; rate?: number[] | null; colors: string[] }[]).map((l, i) => ({
    cue: l.cue, gain: l.level, rate: l.rate ?? null, colors: layerColors(l.colors, i),
  }))
  const r = (rules ?? {}) as Partial<MomentRules>
  return {
    title: v.title as string, project_name: v.project_name as string,
    paths: { cues: paths.cues, clips: paths.clips, sounds: paths.sounds },
    at, loop_at: (v.loop_at as string[] | undefined) ?? at,
    loop_cues: layers.map(l => l.cue), layers,
    families: (v.families as SceneFamily[] | undefined) ?? [],
    ticks: (v.ticks as string[] | undefined) ?? [],
    moment_rules: { max: r.max ?? {}, min_gap_s: r.min_gap_s ?? {}, default_max: r.default_max ?? null },
    import_command: (v.import_command as string | undefined) ?? '',
    ...(isString(v.record_command) ? { record_command: v.record_command } : {}),
  }
}

/** Two colours (left, right) for layer `index`: the lib's (one colour serves both hands), else the default pair. */
function layerColors(colors: readonly string[], index: number): string[] {
  if (colors.length >= 2) return [...colors]
  if (colors.length === 1) return [colors[0], colors[0]]
  return [...LAYER_COLORS[index % LAYER_COLORS.length]]
}

const LEVEL_COLUMN = /^([a-z][a-z0-9_]*):(level|rate)(?::(left|right))?$/

/**
 * The loop cues' layers from the recording's column names (scene-recording section 2.1): `<cue>:level` (both hands),
 * `<cue>:level:left` / `:right`, and the optional `<cue>:rate[...]`. A side without its own column uses the other's.
 * Columns of another form are left out.
 */
export function layersFromColumns(columns: readonly string[]): SceneLayer[] {
  const found = new Map<string, { level: (number | undefined)[]; rate: (number | undefined)[] }>()
  columns.forEach((name, i) => {
    const m = LEVEL_COLUMN.exec(name)
    if (!m) return
    const entry = found.get(m[1]) ?? { level: [undefined, undefined], rate: [undefined, undefined] }
    found.set(m[1], entry)
    const sides = m[3] === 'left' ? [0] : m[3] === 'right' ? [1] : [0, 1]
    for (const s of sides) entry[m[2] as 'level' | 'rate'][s] = i
  })
  const pair = (p: (number | undefined)[]): number[] | null => p[0] === undefined && p[1] === undefined ? null : [p[0] ?? p[1]!, p[1] ?? p[0]!]
  return [...found].flatMap(([cue, e], i) => {
    const gain = pair(e.level)
    return gain ? [{ cue, gain, rate: pair(e.rate), colors: layerColors([], i) }] : []
  })
}

/** The lib with the recording's layers when it names none (made from the column names), and those as its loop cues. */
export function withRecordingLayers(lib: SceneLib, data: SceneData): SceneLib {
  if (lib.layers.length) return lib
  const layers = layersFromColumns(data.full.columns)
  return { ...lib, layers, loop_cues: layers.map(l => l.cue) }
}

function isLevels(value: unknown, width: number): value is number[][] {
  return Array.isArray(value) && value.every(row => Array.isArray(row) && row.length === width && row.every(x => isNumber(x) && x >= 0))
}

/**
 * viewer-data.json → SceneData; throws naming the first field that does not fit, or SceneFormatError for another
 * `schema_version`. The moments (`clips`) are made from the events with the lib's ticks and moment rules (deriveMoments).
 */
export function parseViewerData(text: string, lib: Pick<SceneLib, 'ticks' | 'moment_rules'>): SceneData {
  const v = parseJson(text, 'viewer-data.json')
  const fail = (field: string): never => { throw new Error(`viewer-data.json: ${field} is missing or invalid`) }
  if (!isRecord(v)) return fail('(root)')
  if (v.schema_version !== SCENE_FORMAT_VERSION) throw new SceneFormatError('viewer-data.json')
  if (!isNumber(v.fps) || v.fps <= 0) fail('fps')
  if (!Number.isInteger(v.frames) || (v.frames as number) < 1) fail('frames')
  if (!isString(v.video) || !v.video) fail('video')
  const events = v.events
  if (!Array.isArray(events) || !events.every(e => isRecord(e) && isNumber(e.t) && e.t >= 0 && isString(e.name)
    && (e.hand === undefined || e.hand === 'left' || e.hand === 'right' || e.hand === 'both')
    && (e.gain === undefined || isNumber(e.gain)) && (e.dist === undefined || isNumber(e.dist)) && (e.note === undefined || isString(e.note)))) return fail('events')
  const lv = v.levels
  if (lv !== undefined && !(isRecord(lv) && isStrings(lv.columns) && lv.columns.length > 0 && isLevels(lv.rows, lv.columns.length))) fail('levels')
  const fps = v.fps as number, frames = v.frames as number, file = v.video as string
  const levels = lv ? (lv as { rows: number[][] }).rows : Array.from({ length: frames }, () => [] as number[])
  const columns = lv ? (lv as { columns: string[] }).columns : []
  const full: SceneEvent[] = (events as Record<string, unknown>[]).map(e => ({
    t: e.t as number, name: e.name as string, hand: (e.hand as string | undefined) ?? '',
    ...(e.gain !== undefined ? { gain: e.gain as number } : {}), ...(e.dist !== undefined ? { dist: e.dist as number } : {}),
    ...(e.note !== undefined ? { note: e.note as string } : {}),
  }))
  const clips = deriveMoments(full, lib, frames / fps).map(m => ({ ...m, file, event: m.at, levels }))
  return { fps, clips, full: { file, levels, columns, events: full } }
}

const cueOf = (name: string) => name.split(':')[0]
/**
 * The key of `record` (moment_rules.max / min_gap_s) that applies to event `name`: `<cue>:<variant>` itself, else its
 * `<cue>` (which covers the cue and every variant); null when neither is there.
 */
export function ruleKey(record: Readonly<Record<string, unknown>>, name: string): string | null {
  return Object.prototype.hasOwnProperty.call(record, name) ? name : Object.prototype.hasOwnProperty.call(record, cueOf(name)) ? cueOf(name) : null
}
/** A tick cue (lib.ticks, `<cue>` covering its variants): it fires often and gets a moment of its own. */
export const isTick = (ticks: readonly string[], name: string) => ticks.includes(name) || ticks.includes(cueOf(name))

/** A moment as deriveMoments makes it (SceneClip without the video and levels). */
export type SceneMoment = Pick<SceneClip, 'name' | 'names' | 'hand' | 'at' | 'note' | 'start' | 'end'>

/**
 * The moments list (scene-recording section 3.4; the rules of the former build_viewer.py): a non-tick cue within
 * MOMENT_S of the previous moment's first cue joins that moment; a tick cue is a moment of its own. The moment rules
 * apply to a moment's first cue: `min_gap_s` skips a moment that comes too soon after the last one kept under the
 * same key, `max` (else `default_max`) keeps the first n moments per key (a `<cue>` key counts the cue and its
 * variants together; without a `max` key each name counts on its own). Each moment's stretch runs from MOMENT_BEFORE_S
 * before its first cue to MOMENT_AFTER_S after it, within [0, `duration`].
 */
export function deriveMoments(events: readonly SceneEvent[], lib: Pick<SceneLib, 'ticks' | 'moment_rules'>, duration: number): SceneMoment[] {
  const sorted = [...events].sort((a, b) => a.t - b.t)
  const groups: SceneEvent[][] = []
  for (const e of sorted) {
    if (isTick(lib.ticks, e.name)) continue
    const last = groups[groups.length - 1]
    if (last && e.t - last[0].t <= MOMENT_S + 1e-9) last.push(e); else groups.push([e])
  }
  for (const e of sorted) if (isTick(lib.ticks, e.name)) groups.push([e])
  groups.sort((a, b) => a[0].t - b[0].t)
  const { max, min_gap_s: gaps, default_max: defaultMax } = lib.moment_rules
  const count = new Map<string, number>(), lastAt = new Map<string, number>()
  const out: SceneMoment[] = []
  for (const group of groups) {
    const first = group[0], gapKey = ruleKey(gaps, first.name) ?? first.name, maxKey = ruleKey(max, first.name)
    const prev = lastAt.get(gapKey)
    if (prev !== undefined && first.t - prev < (gaps[gapKey] ?? 0)) continue
    const key = maxKey ?? first.name, n = (count.get(key) ?? 0) + 1
    count.set(key, n)
    if (n > (maxKey ? max[maxKey] : defaultMax ?? Infinity)) continue
    lastAt.set(gapKey, first.t)
    out.push({
      name: first.name, names: [...new Set(group.map(e => e.name))], hand: first.hand, at: first.t, note: first.note ?? '',
      start: Math.max(0, first.t - MOMENT_BEFORE_S), end: Math.min(duration, first.t + MOMENT_AFTER_S),
    })
  }
  return out
}

/** The moments list: the full replay, then one entry per moment. */
export function buildItems(data: SceneData): SceneItem[] {
  return [
    { kind: 'full', file: data.full.file, name: 'full', names: [], hand: '', at: 0, note: '', event: 0, start: 0, end: Infinity, levels: data.full.levels },
    ...data.clips.map(c => ({ kind: 'clip' as const, ...c })),
  ]
}

/** Where a moment's play range ends (the full replay: its own end). Video time is replay time for every item. */
export const clipEnd = (item: SceneItem) => item.kind === 'full' ? Infinity : item.end
/** Where a moment plays from: `leadSec` before its mark, not before its stretch. */
export const momentStart = (item: SceneItem, leadSec: number) => item.kind === 'full' ? 0 : Math.max(item.start, item.event - leadSec)

/** Cues visible in an item: the full replay's all, a moment's within its stretch (`own` = the moment's cues at its mark). */
export function itemEvents(item: SceneItem, all: SceneEvent[]): VisibleEvent[] {
  if (item.kind === 'full') return all.map(e => ({ ...e, own: false }))
  return all.filter(e => e.t >= item.start && e.t <= item.end)
    .map(e => ({ ...e, own: item.names.includes(e.name) && Math.abs(e.t - item.event) <= MOMENT_S + 1e-9 }))
}

/** The cue E / W act on: a moment's own cue, or in the full replay the last non-tick cue up to just after `t`. */
export function focusEvent(item: SceneItem, events: VisibleEvent[], t: number, ticks: string[]): VisibleEvent | undefined {
  if (item.kind === 'clip') return events.find(x => x.own && x.name === item.name) ?? { t: item.event, name: item.name, hand: item.hand, own: true }
  return events.filter(x => !isTick(ticks, x.name) && x.t <= t + 0.6).pop() ?? events[0]
}

/** Distinct non-tick cues within MOMENT_S of `t` (the cues that play together with the selected one). */
export function momentCues(events: VisibleEvent[], t: number | null, ticks: string[]): string[] {
  if (t == null) return []
  return [...new Set(events.filter(e => Math.abs(e.t - t) <= MOMENT_S && !isTick(ticks, e.name)).map(e => e.name))]
}

/** Marker colour by family (not per cue): the label on the marker names the cue. A family naming the `cue:variant` wins over one naming its cue. */
export function familyColor(lib: SceneLib, name: string): string {
  const cue = cueOf(name)
  return (lib.families.find(f => f.cues.includes(name)) ?? lib.families.find(f => f.cues.includes(cue)))?.color ?? '#888888'
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
