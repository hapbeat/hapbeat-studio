import { create } from 'zustand'
import { eventKey, parseEventKey } from '@/utils/cueEvents'
import { eventRoutes, scaleFiringGain, setRouteGains } from '@/utils/sceneStrength'
import { useSceneStore } from './sceneStore'
import { useSceneSettings } from './sceneSettings'

/**
 * The Scene tab's strength editing session (DEC-102 r3; nothing here is saved): which recorded firings are selected
 * (viewer-data `events` indices, shared by the strength panel and the timeline), the hovered one, a drag's live ratio,
 * the M / S toggles of the haptic events, and one undo stack (≤ 100) for the strength edits made in the panel and the
 * timeline: firing gains (sceneStore.setFiringGains) and event route gains (the cue table, sceneStore.edit).
 */

/** One strength edit: firing gains by recorded index, or the route gains of the event key that holds them. */
export type StrengthEdit =
  | { kind: 'firings'; before: [number, number][]; after: [number, number][] }
  | { kind: 'routes'; owner: string; before: number[]; after: number[] }
export const UNDO_LIMIT = 100

interface SceneStrengthState {
  selected: ReadonlySet<number>
  hover: number | null
  /** A drag's ratio on the selected firings while it lasts (timeline bar / relative fader); applied on release. */
  dragRatio: number | null
  muted: ReadonlySet<string>
  soloed: ReadonlySet<string>
  undo: StrengthEdit[]
  redo: StrengthEdit[]
  /** `replace`: these only; `toggle`: each in / out; `add`: these too. */
  select: (indices: readonly number[], mode: 'replace' | 'toggle' | 'add') => void
  clear: () => void
  setHover: (index: number | null) => void
  setDragRatio: (ratio: number | null) => void
  toggleMute: (name: string) => void
  toggleSolo: (name: string) => void
  /** Firing gains × `ratio` on the selection (one undo step); false when nothing changed. */
  scaleSelected: (ratio: number) => boolean
  /** Every selected firing's gain set to `gain` (one undo step). */
  setSelected: (gain: number) => boolean
  /** Records a route-gain change already applied (a fader drag: live edits, one step on release). */
  pushRoutes: (owner: string, before: number[], after: number[]) => void
  undoLast: () => void
  redoLast: () => void
}

const toggled = <T,>(set: ReadonlySet<T>, value: T) => { const next = new Set(set); if (!next.delete(value)) next.add(value); return next }

/**
 * Applies one side of an edit to the recording / the cue table; false when it cannot be now (firing gains with
 * per-firing editing off, or an event the table no longer has): the step stays where it is.
 */
function apply(edit: StrengthEdit, side: 'before' | 'after'): boolean {
  const s = useSceneStore.getState()
  if (edit.kind === 'firings') {
    if (!useSceneSettings.getState().editFirings) return false
    s.setFiringGains(new Map(edit[side]))
    return true
  }
  const owner = parseEventKey(edit.owner)
  try { return s.edit(tb => setRouteGains(tb, owner, edit[side])) } catch { return false }
}
/** The recorded gain of each selected firing (omitted = 1). */
function selectedGains(selected: ReadonlySet<number>): [number, number][] {
  const events = useSceneStore.getState().recorded?.full.events ?? []
  return [...selected].flatMap(i => events[i] ? [[i, events[i].gain ?? 1] as [number, number]] : [])
}

export const useSceneStrength = create<SceneStrengthState>((set, get) => {
  const push = (edit: StrengthEdit) => set(st => ({ undo: [...st.undo.slice(-(UNDO_LIMIT - 1)), edit], redo: [] }))
  const firings = (next: (gain: number) => number) => {
    const before = selectedGains(get().selected), after = before.map(([i, g]) => [i, next(g)] as [number, number])
    if (!after.some(([, g], k) => g !== before[k][1])) return false
    useSceneStore.getState().setFiringGains(new Map(after))
    push({ kind: 'firings', before, after })
    return true
  }
  return {
    selected: new Set(), hover: null, dragRatio: null, muted: new Set(), soloed: new Set(), undo: [], redo: [],
    select: (indices, mode) => set(st => {
      if (mode === 'replace') return { selected: new Set(indices) }
      let next = new Set(st.selected)
      for (const i of indices) next = mode === 'add' ? next.add(i) : toggled(next, i)
      return { selected: next }
    }),
    clear: () => { if (get().selected.size) set({ selected: new Set() }) },
    setHover: hover => { if (get().hover !== hover) set({ hover }) },
    setDragRatio: dragRatio => set({ dragRatio }),
    toggleMute: name => set(st => ({ muted: toggled(st.muted, name) })),
    toggleSolo: name => set(st => ({ soloed: toggled(st.soloed, name) })),
    scaleSelected: ratio => firings(g => scaleFiringGain(g, ratio)),
    setSelected: gain => firings(() => scaleFiringGain(gain, 1)),
    pushRoutes: (owner, before, after) => { if (after.some((g, i) => g !== before[i])) push({ kind: 'routes', owner, before, after }) },
    undoLast: () => {
      const { undo } = get(), edit = undo[undo.length - 1]
      if (!edit || !apply(edit, 'before')) return
      set(st => ({ undo: st.undo.slice(0, -1), redo: [...st.redo, edit] }))
    },
    redoLast: () => {
      const { redo } = get(), edit = redo[redo.length - 1]
      if (!edit || !apply(edit, 'after')) return
      set(st => ({ redo: st.redo.slice(0, -1), undo: [...st.undo, edit] }))
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
    useSceneStrength.setState({ selected: new Set(), hover: null, dragRatio: null, muted: new Set(), soloed: new Set(), undo: [], redo: [] })
})
