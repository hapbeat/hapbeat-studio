import { create } from 'zustand'

/**
 * The replay seconds the Scene timeline shows now ([start, end]; null while it draws nothing). The timeline sets it only
 * when the range changes (not every frame); the moments list marks the moments in it.
 */
interface SceneTimelineRangeState {
  range: readonly [number, number] | null
  setRange: (range: readonly [number, number] | null) => void
}

/** Changes below this (s) are not a new range (a still view redrawn). */
const SAME_S = 1e-3

export const useSceneTimelineRange = create<SceneTimelineRangeState>((set, get) => ({
  range: null,
  setRange: range => {
    const now = get().range
    if (now === range || (now && range && Math.abs(now[0] - range[0]) < SAME_S && Math.abs(now[1] - range[1]) < SAME_S)) return
    set({ range })
  },
}))
