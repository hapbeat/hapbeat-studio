import { create } from 'zustand'

/**
 * This PC's sound / haptics offset (DEC-093, the environment term E): + = the haptic plays that much later than the
 * PC sound, − = the PC sound that much later (nothing is cut either way). It makes what Studio plays on this PC feel
 * the way the materials are meant to meet, so sync points are not set to cover this PC's own delays. Kept in this
 * browser only (per PC): never in a project, the Scene settings or the cue table, and never used by a game.
 */
export const PC_TIMING_STORAGE_KEY = 'hapbeat-pc-timing'
export const PC_OFFSET_MIN = -300
export const PC_OFFSET_MAX = 300
export const clampPcOffset = (ms: number) => Number.isFinite(ms) ? Math.max(PC_OFFSET_MIN, Math.min(PC_OFFSET_MAX, Math.round(ms))) : 0

function read(): number {
  try {
    const data = JSON.parse(localStorage.getItem(PC_TIMING_STORAGE_KEY) ?? 'null') as { offsetMs?: unknown } | null
    return typeof data?.offsetMs === 'number' ? clampPcOffset(data.offsetMs) : 0
  } catch { return 0 }
}

export const usePcTiming = create<{ offsetMs: number; setOffsetMs: (ms: number) => void }>(set => ({
  offsetMs: read(),
  setOffsetMs: ms => {
    const offsetMs = clampPcOffset(ms)
    set({ offsetMs })
    try { localStorage.setItem(PC_TIMING_STORAGE_KEY, JSON.stringify({ offsetMs })) } catch { /* a preference must not stop work */ }
  },
}))
