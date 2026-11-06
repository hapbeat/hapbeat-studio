import { deriveMoments, type SceneData, type SceneEvent, type SceneLib } from './sceneData'

/**
 * `Saved/HapticViewer/viewer-edits.json` (contracts scene-recording §3.5, DEC-112): what the user changed on single
 * recorded firings in the Scene tab — their gain and their time — kept apart from the recording, which Studio never
 * writes. Each entry names its firing as the recording has it (`of`: name, time, hand) and is laid over the recording
 * when it is read (matchEdits, applyEdits). Everything here is pure.
 */

export const VIEWER_EDITS_FILE = 'viewer-edits.json'
export type Hand = 'left' | 'right' | 'both'
export interface FiringEdit { of: { name: string; t: number; hand?: Hand }; gain?: number; t?: number }
export interface ViewerEdits { schema_version: 1; firings: FiringEdit[] }
/** One firing's change: a number sets the field, null takes the recorded value back, absent keeps it as it is. */
export interface FiringChange { gain?: number | null; t?: number | null }

export const emptyEdits = (): ViewerEdits => ({ schema_version: 1, firings: [] })

/** scene-session.schema.json `cueRef`. */
const CUE_REF = /^[a-z][a-z0-9_]*(:[a-z][a-z0-9_]*)?$/
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
const isHand = (v: unknown): v is Hand => v === 'left' || v === 'right' || v === 'both'

/**
 * viewer-edits.json → its entries; throws (naming what does not fit) when the file is not JSON, not schema_version 1
 * or has no `firings` array. Entries that do not fit are left out and counted (`dropped`).
 */
export function parseViewerEdits(text: string): { edits: ViewerEdits; dropped: number } {
  let v: unknown
  try { v = JSON.parse(text) } catch (error) { throw new Error(`${VIEWER_EDITS_FILE}: ${error instanceof Error ? error.message : String(error)}`) }
  if (!isRecord(v)) throw new Error(`${VIEWER_EDITS_FILE}: (root) is missing or invalid`)
  if (v.schema_version !== 1) throw new Error(`${VIEWER_EDITS_FILE}: schema_version must be 1`)
  if (!Array.isArray(v.firings)) throw new Error(`${VIEWER_EDITS_FILE}: firings is missing or invalid`)
  const firings: FiringEdit[] = []
  for (const e of v.firings as unknown[]) {
    const of = isRecord(e) ? e.of : undefined
    if (!isRecord(e) || !isRecord(of) || typeof of.name !== 'string' || !CUE_REF.test(of.name) || !isTime(of.t) || (of.hand !== undefined && !isHand(of.hand))
      || (e.gain !== undefined && !isTime(e.gain)) || (e.t !== undefined && !isTime(e.t)) || (e.gain === undefined && e.t === undefined)) continue
    firings.push({ of: { name: of.name, t: of.t, ...(of.hand !== undefined ? { hand: of.hand } : {}) }, ...(e.gain !== undefined ? { gain: e.gain } : {}), ...(e.t !== undefined ? { t: e.t } : {}) })
  }
  return { edits: { schema_version: 1, firings }, dropped: (v.firings as unknown[]).length - firings.length }
}

/** Times as the recorder writes them (4 decimals). */
export const roundTime = (t: number) => Math.round(t * 1e4) / 1e4
/** Time `t` on the nearest frame of `fps`, kept within 0..`end` (the video), as the file writes it. */
export const snapTime = (t: number, fps: number, end: number) => roundTime(Math.max(0, Math.min(end, Math.round(t * fps) / fps)))
/** Gains with 4 significant digits (0 stays 0). */
export const roundEditGain = (g: number) => g > 0 ? Number(g.toPrecision(4)) : 0
const HAND_ORDER = ['', 'both', 'left', 'right']
const byFiring = (a: FiringEdit, b: FiringEdit) => a.of.t - b.of.t || (a.of.name < b.of.name ? -1 : a.of.name > b.of.name ? 1 : 0)
  || HAND_ORDER.indexOf(a.of.hand ?? '') - HAND_ORDER.indexOf(b.of.hand ?? '')

/** The file's text: entries by `of.t`, then name, then hand; 2-space indent and a trailing newline. */
export function serializeViewerEdits(edits: ViewerEdits): string {
  const firings = [...edits.firings].sort(byFiring).map(e => ({
    of: { name: e.of.name, t: roundTime(e.of.t), ...(e.of.hand ? { hand: e.of.hand } : {}) },
    ...(e.gain !== undefined ? { gain: roundEditGain(e.gain) } : {}), ...(e.t !== undefined ? { t: roundTime(e.t) } : {}),
  }))
  return `${JSON.stringify({ schema_version: 1, firings }, null, 2)}\n`
}

/** Which recorded firing each entry is (recorded index → entry index) and the entries that are no firing (orphans). */
export interface EditsMatch { byEvent: Map<number, number>; orphans: number[] }

/**
 * Contract §3.5: an entry is the recorded firing with the same name and hand (both absent = the same) whose time is
 * within half a frame of `of.t`; each firing takes at most one entry. Entries are placed by ascending `of.t`, each on
 * the nearest firing still free (equal distance: the lower index).
 */
export function matchEdits(events: readonly SceneEvent[], fps: number, firings: readonly FiringEdit[]): EditsMatch {
  const byName = new Map<string, number[]>()
  events.forEach((ev, i) => { const list = byName.get(ev.name); if (list) list.push(i); else byName.set(ev.name, [i]) })
  const half = 0.5 / fps + 1e-9, taken = new Set<number>(), byEvent = new Map<number, number>(), orphans: number[] = []
  const order = firings.map((_, k) => k).sort((a, b) => firings[a].of.t - firings[b].of.t || a - b)
  for (const k of order) {
    const of = firings[k].of
    let best = -1, bestD = Infinity
    for (const i of byName.get(of.name) ?? []) {
      const ev = events[i], d = Math.abs(ev.t - of.t)
      if (taken.has(i) || (ev.hand || '') !== (of.hand ?? '') || d > half) continue
      if (d < bestD) { best = i; bestD = d }
    }
    if (best < 0) orphans.push(k)
    else { taken.add(best); byEvent.set(best, k) }
  }
  return { byEvent, orphans: orphans.sort((a, b) => a - b) }
}

/**
 * The recording with the matched entries laid over it: `full.events` in the recorded order and length (index i is
 * recorded firing i), each matched one with its gain / time replaced (a time kept within the video, 0..frames / fps).
 * The levels and every other field stay the same objects (the runtime keeps its video). The recording itself when
 * nothing matched.
 */
export function applyEdits(recording: SceneData, firings: readonly FiringEdit[], byEvent: ReadonlyMap<number, number>): SceneData {
  if (!byEvent.size) return recording
  const end = recording.full.levels.length / recording.fps
  const events = recording.full.events.map((ev, i) => {
    const k = byEvent.get(i), e = k === undefined ? undefined : firings[k]
    if (!e) return ev
    return { ...ev, ...(e.gain !== undefined ? { gain: e.gain } : {}), ...(e.t !== undefined ? { t: Math.max(0, Math.min(end, e.t)) } : {}) }
  })
  return { ...recording, full: { ...recording.full, events } }
}

/**
 * `edited` (applyEdits of `recording`) as Studio plays it: when a firing's time moved, the events in time order (a
 * stable sort, so firings at one time keep their order) and the moments made again from them (contract §3.5: a moved
 * firing is in the moments list at its new time). `edited` itself when no time moved.
 */
export function retimed(recording: SceneData, edited: SceneData, lib: Pick<SceneLib, 'ticks' | 'moment_rules'>): SceneData {
  if (edited === recording || edited.full.events.every((ev, i) => ev.t === recording.full.events[i].t)) return edited
  const events = edited.full.events.map((ev, i) => [ev, i] as const).sort((a, b) => a[0].t - b[0].t || a[1] - b[1]).map(([ev]) => ev)
  const { file, levels } = edited.full
  const clips = deriveMoments(events, lib, levels.length / edited.fps).map(m => ({ ...m, file, event: m.at, levels }))
  return { ...edited, clips, full: { ...edited.full, events } }
}

/**
 * The edits with the entry of recorded firing `ev` changed (FiringChange; rounded as the file writes them): added,
 * replaced or — with neither field left — removed. `entry`: the index of its matched entry (matchEdits), else the
 * entry naming exactly its name, hand and time is the one.
 */
export function setEditFor(edits: ViewerEdits, ev: SceneEvent, change: FiringChange, entry?: number): ViewerEdits {
  const hand = ev.hand ? ev.hand as Hand : undefined
  const at = entry ?? edits.firings.findIndex(e => e.of.name === ev.name && (e.of.hand ?? '') === (ev.hand || '') && Math.abs(e.of.t - ev.t) < 1e-4)
  const old = at >= 0 ? edits.firings[at] : undefined
  const gain = change.gain === undefined ? old?.gain : change.gain === null ? undefined : roundEditGain(change.gain)
  const t = change.t === undefined ? old?.t : change.t === null ? undefined : roundTime(change.t)
  const next: FiringEdit | null = gain === undefined && t === undefined ? null
    : { of: { name: ev.name, t: roundTime(ev.t), ...(hand ? { hand } : {}) }, ...(gain !== undefined ? { gain } : {}), ...(t !== undefined ? { t } : {}) }
  const firings = edits.firings.filter((_, k) => k !== at)
  if (next) firings.splice(at >= 0 ? at : firings.length, 0, next)
  return { schema_version: 1, firings }
}

/** A recorded firing's entry fields (the undo record of an edit), or null without one. */
export function editOf(edits: ViewerEdits, entry: number | undefined): { gain?: number; t?: number } | null {
  const e = entry === undefined ? undefined : edits.firings[entry]
  return e ? { ...(e.gain !== undefined ? { gain: e.gain } : {}), ...(e.t !== undefined ? { t: e.t } : {}) } : null
}
