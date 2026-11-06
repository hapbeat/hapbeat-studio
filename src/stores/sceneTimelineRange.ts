import { create } from 'zustand'

/**
 * The replay seconds the Scene timeline shows now ([start, end]; null while it draws nothing). The timeline sets it only
 * when the range changes (not every frame); the moments list marks the moments in it.
 */
interface SceneTimelineRangeState {
  range: readonly [number, number] | null
  /** The range from `start` to `end` (a new pair only when it changed: called every frame); null for none. */
  setRange: (start: number | null, end?: number) => void
}

/** Changes below this (s) are not a new range (a still view redrawn). */
const SAME_S = 1e-3

export const useSceneTimelineRange = create<SceneTimelineRangeState>((set, get) => ({
  range: null,
  setRange: (start, end = start ?? 0) => {
    const now = get().range
    if (start === null) { if (now) set({ range: null }); return }
    if (now && Math.abs(now[0] - start) < SAME_S && Math.abs(now[1] - end) < SAME_S) return
    set({ range: [start, end] })
  },
}))
