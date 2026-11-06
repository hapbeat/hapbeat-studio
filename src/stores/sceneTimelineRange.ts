import { create } from 'zustand'

/**
 * What the Scene timeline shows now, for the moments list (DEC-112): the first / last numbers of the recorded firings
 * in the replay seconds it draws (numbersInRange; null for none) and what plays ([a, b]; null = the full replay). The
 * timeline sets them every frame and clears them when it closes; a new value is stored only when it changed.
 */
interface SceneTimelineRangeState {
  rows: readonly [number, number] | null
  repeat: readonly [number, number] | null
  setRows: (rows: readonly [number, number] | null) => void
  setRepeat: (repeat: readonly [number, number] | null) => void
}

/** Changes below this (s) are not a new range (a still view redrawn). */
const SAME_S = 1e-3
const samePair = (a: readonly [number, number] | null, b: readonly [number, number] | null, eps: number) =>
  a === b || (!!a && !!b && Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps)

export const useSceneTimelineRange = create<SceneTimelineRangeState>((set, get) => ({
  rows: null,
  repeat: null,
  setRows: rows => { if (!samePair(get().rows, rows, 0)) set({ rows: rows && [rows[0], rows[1]] }) },
  setRepeat: repeat => { if (!samePair(get().repeat, repeat, SAME_S)) set({ repeat: repeat && [repeat[0], repeat[1]] }) },
}))
