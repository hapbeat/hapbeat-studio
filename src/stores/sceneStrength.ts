import { create } from 'zustand'
import { eventKey, parseEventKey } from '@/utils/cueEvents'
import { eventRoutes, scaleFiringGain, setFiringGain, setRouteGains } from '@/utils/sceneStrength'
import { editOf, snapTime, type FiringChange } from '@/utils/sceneEdits'
import { applyTableGains } from '@/utils/sceneVersions'
import type { CueTable } from '@/utils/sceneCueTable'
import { useSceneStore, type VersionRestore } from './sceneStore'

/**
 * The Scene tab's strength editing session (DEC-102 r3; nothing here is saved): which recorded firings are selected
 * (viewer-data `events` indices, shared by the strength panel and the timeline), the hovered one, a drag's live ratio,
 * the M / S toggles of the haptic events, and one undo stack (≤ 100) for the strength edits made in the panel and the
 * timeline: firing edits (viewer-edits.json, sceneStore.setFiringEdits), event route gains (the cue table,
 * sceneStore.edit) and a version's strength values set by restoreVersion.
 */

/** A recorded firing's edit entry fields (gain / time), or null for none (the recorded values). */
export type FiringEntry = { gain?: number; t?: number } | null
/**
 * One strength edit: the edit entries of recorded firings (by index) before / after, the route gains of the event key
 * that holds them, or the strength values of the whole cue table (a version restored; applyTableGains).
 */
export type StrengthEdit =
  | { kind: 'edits'; before: [number, FiringEntry][]; after: [number, FiringEntry][] }
  | { kind: 'routes'; owner: string; before: number[]; after: number[] }
  | { kind: 'table'; before: CueTable; after: CueTable }
export const UNDO_LIMIT = 100

interface SceneStrengthState {
  selected: ReadonlySet<number>
  hover: number | null
  /** A drag's ratio on the selected firings while it lasts (timeline bar / relative fader); applied on release. */
  dragRatio: number | null
  /** A drag's time shift (s) on the selected firings while it lasts (the timeline draws it); applied on release (moveSelected). */
  dragDt: number | null
  muted: ReadonlySet<string>
  soloed: ReadonlySet<string>
  undo: StrengthEdit[]
  redo: StrengthEdit[]
  /** `replace`: these only; `toggle`: each in / out; `add`: these too. */
  select: (indices: readonly number[], mode: 'replace' | 'toggle' | 'add') => void
  clear: () => void
  setHover: (index: number | null) => void
  setDragRatio: (ratio: number | null) => void
  setDragDt: (dt: number | null) => void
  toggleMute: (name: string) => void
  toggleSolo: (name: string) => void
  /** The selected firings' gains (their edited gain, else the recorded one) × `ratio` (one undo step); false when nothing changed. */
  scaleSelected: (ratio: number) => boolean
  /** Every selected firing's gain set to `gain` (one undo step). */
  setSelected: (gain: number) => boolean
  /** Every selected firing's time moved by `dt` s (snapped to frames, kept within the video; one undo step). */
  moveSelected: (dt: number) => boolean
  /** The selected firings back to their recorded values (their edit entries removed; one undo step). */
  resetSelected: () => boolean
  /** Records a route-gain change already applied (a fader drag: live edits, one step on release). */
  pushRoutes: (owner: string, before: number[], after: number[]) => void
  /** Records a cue table strength change already applied (a version restored). */
  pushTable: (before: CueTable, after: CueTable) => void
  undoLast: () => void
  redoLast: () => void
}

/** A step that can no longer apply was dropped (said so; the next Ctrl+Z goes on with the older ones). */
const dropped = () => useSceneStore.getState().note({ id: 'scene.strength.stepDropped', error: true })
const toggled = <T,>(set: ReadonlySet<T>, value: T) => { const next = new Set(set); if (!next.delete(value)) next.add(value); return next }

/**
 * Applies one side of an edit to the edits / the cue table: `gone` = never again (its firings or its event's routes are
 * no longer there — another recording, the event renamed or removed, the table changed outside Studio; the step is
 * dropped so older ones still work).
 */
function apply(edit: StrengthEdit, side: 'before' | 'after'): 'ok' | 'gone' {
  const s = useSceneStore.getState()
  if (edit.kind === 'edits') {
    const events = s.recorded?.full.events ?? []
    if (!s.root || edit[side].some(([i]) => !events[i])) return 'gone'
    // The entries exactly as they were: both fields given (null = none).
    s.setFiringEdits(new Map(edit[side].map(([i, e]) => [i, { gain: e?.gain ?? null, t: e?.t ?? null }])))
    return 'ok'
  }
  if (edit.kind === 'table') {
    const table = s.table
    if (!table) return 'gone'
    const next = applyTableGains(table, edit[side]).table
    return next === table || s.edit(() => next) ? 'ok' : 'gone'
  }
  const now = s.table && eventRoutes(s.table, edit.owner)
  if (!now || eventKey(now.owner) !== edit.owner || now.gains.length !== edit[side].length) return 'gone'
  try { return s.edit(tb => setRouteGains(tb, parseEventKey(edit.owner), edit[side])) ? 'ok' : 'gone' } catch { return 'gone' }
}
/** Each selected firing's edit entry now (recorded index → its fields, null without one). */
function selectedEntries(selected: ReadonlySet<number>): [number, FiringEntry][] {
  const s = useSceneStore.getState(), events = s.recorded?.full.events ?? []
  return [...selected].flatMap(i => events[i] ? [[i, editOf(s.edits, s.editsMatch.get(i))] as [number, FiringEntry]] : [])
}
const sameEntry = (a: FiringEntry, b: FiringEntry) => a?.gain === b?.gain && a?.t === b?.t

export const useSceneStrength = create<SceneStrengthState>((set, get) => {
  const push = (edit: StrengthEdit) => set(st => ({ undo: [...st.undo.slice(-(UNDO_LIMIT - 1)), edit], redo: [] }))
  /**
   * Changes every selected firing (`change` gets its edited event: the gain / time it plays at; returns its change, or
   * null for none) as one undo step, recorded as the entries before and after.
   */
  const firings = (change: (ev: { gain?: number; t: number }, i: number) => FiringChange | null) => {
    const s = useSceneStore.getState(), edited = s.edited?.full.events ?? []
    const before = selectedEntries(get().selected), changes = new Map<number, FiringChange>()
    for (const [i] of before) { const c = edited[i] && change(edited[i], i); if (c) changes.set(i, c) }
    if (!changes.size) return false
    s.setFiringEdits(changes)
    const after = selectedEntries(get().selected)
    if (after.every(([, e], k) => sameEntry(e, before[k][1]))) return false
    push({ kind: 'edits', before, after })
    return true
  }
  return {
    selected: new Set(), hover: null, dragRatio: null, dragDt: null, muted: new Set(), soloed: new Set(), undo: [], redo: [],
    select: (indices, mode) => set(st => {
      if (mode === 'replace') return { selected: new Set(indices) }
      let next = new Set(st.selected)
      for (const i of indices) next = mode === 'add' ? next.add(i) : toggled(next, i)
      return { selected: next }
    }),
    clear: () => { if (get().selected.size) set({ selected: new Set() }) },
    setHover: hover => { if (get().hover !== hover) set({ hover }) },
    setDragRatio: dragRatio => set({ dragRatio }),
    setDragDt: dragDt => set({ dragDt }),
    toggleMute: name => set(st => ({ muted: toggled(st.muted, name) })),
    toggleSolo: name => set(st => ({ soloed: toggled(st.soloed, name) })),
    scaleSelected: ratio => firings(ev => { const g = ev.gain ?? 1, next = scaleFiringGain(g, ratio); return next === g ? null : { gain: next } }),
    setSelected: gain => firings(ev => { const next = setFiringGain(gain); return next === (ev.gain ?? 1) ? null : { gain: next } }),
    moveSelected: dt => {
      const r = useSceneStore.getState().recorded
      if (!r) return false
      const end = r.full.levels.length / r.fps
      return firings(ev => { const t = snapTime(ev.t + dt, r.fps, end); return t === ev.t ? null : { t } })
    },
    resetSelected: () => firings((_, i) => useSceneStore.getState().editsMatch.has(i) ? { gain: null, t: null } : null),
    pushRoutes: (owner, before, after) => { if (after.some((g, i) => g !== before[i])) push({ kind: 'routes', owner, before, after }) },
    pushTable: (before, after) => { if (before !== after) push({ kind: 'table', before, after }) },
    undoLast: () => {
      const { undo } = get(), edit = undo[undo.length - 1]
      if (!edit) return
      const result = apply(edit, 'before')
      set(st => ({ undo: st.undo.slice(0, -1), redo: result === 'ok' ? [...st.redo, edit] : st.redo }))
      if (result === 'gone') dropped()
    },
    redoLast: () => {
      const { redo } = get(), edit = redo[redo.length - 1]
      if (!edit) return
      const result = apply(edit, 'after')
      set(st => ({ redo: st.redo.slice(0, -1), undo: result === 'ok' ? [...st.undo, edit] : st.undo }))
      if (result === 'gone') dropped()
    },
  }
})

/** The route gains event `name` would be edited through (its owner's key and gains), or null. */
export function routesOf(name: string): { owner: string; gains: number[] } | null {
  const table = useSceneStore.getState().table, r = table && eventRoutes(table, name)
  return r ? { owner: eventKey(r.owner), gains: r.gains } : null
}

// Another recording (a project opened, another folder): its indices mean other firings, so the session starts over.
useSceneStore.subscribe((state, prev) => {
  if (state.recorded?.full.levels !== prev.recorded?.full.levels || state.root !== prev.root)
    useSceneStrength.setState({ selected: new Set(), hover: null, dragRatio: null, dragDt: null, muted: new Set(), soloed: new Set(), undo: [], redo: [] })
})

/**
 * restoreVersion (sceneStore) with its cue table change as one undo step here (Ctrl+Z puts the strength values back;
 * the edits it wrote are kept in the before-restore version).
 */
export async function restoreVersion(id: string): Promise<VersionRestore> {
  const result = await useSceneStore.getState().restoreVersion(id)
  if (result.ok && result.table) useSceneStrength.getState().pushTable(result.table.before, result.table.after)
  return result
}
