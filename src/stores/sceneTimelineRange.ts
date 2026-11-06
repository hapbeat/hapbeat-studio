import { create } from 'zustand'

/**
 * What the Scene timeline shows now, for the moments list (DEC-112): the replay seconds it draws ([start, end]; null
 * while it draws nothing), the first / last numbers of the recorded firings in that range (numbersInRange; null for
 * none) and what repeats ([a, b]; null = the full replay). The timeline sets them every frame; a new value is stored
 * only when it changed.
 */
interface SceneTimelineRangeState {
  range: readonly [number, number] | null
  rows: readonly [number, number] | null
  repeat: readonly [number, number] | null
  /** The drawn range from `start` to `end` with its firing numbers `rows`; `start` null for none. */
  setRange: (start: number | null, end?: number, rows?: readonly [number, number] | null) => void
  setRepeat: (repeat: readonly [number, number] | null) => void
}

/** Changes below this (s) are not a new range (a still view redrawn). */
const SAME_S = 1e-3
const samePair = (a: readonly [number, number] | null, b: readonly [number, number] | null, eps: number) =>
  a === b || (!!a && !!b && Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps)

export const useSceneTimelineRange = create<SceneTimelineRangeState>((set, get) => ({
  range: null,
  rows: null,
  repeat: null,
  setRange: (start, end = start ?? 0, rows = null) => {
    const now = get()
    if (start === null) { if (now.range || now.rows) set({ range: null, rows: null }); return }
    const range = samePair(now.range, [start, end], SAME_S) ? now.range : [start, end] as const
    const nextRows = samePair(now.rows, rows, 0) ? now.rows : rows
    if (range !== now.range || nextRows !== now.rows) set({ range, rows: nextRows })
  },
  setRepeat: repeat => { if (!samePair(get().repeat, repeat, SAME_S)) set({ repeat: repeat && [repeat[0], repeat[1]] }) },
}))
