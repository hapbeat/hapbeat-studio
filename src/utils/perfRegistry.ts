/**
 * Live counts of what keeps Studio busy while idle — intervals, animation loops, AudioContexts — readable
 * as `window.__studioPerf` (diagnostics: a long-lived tab or many hot reloads must not pile them up).
 */
export type PerfKind = 'intervals' | 'rafLoops' | 'audioContexts'
const counts: Record<PerfKind, number> = { intervals: 0, rafLoops: 0, audioContexts: 0 }
export function perfTrack(kind: PerfKind, delta: 1 | -1) { counts[kind] = Math.max(0, counts[kind] + delta) }
export const perfCounts = () => ({ ...counts })
if (typeof window !== 'undefined') Object.defineProperty(window, '__studioPerf', { configurable: true, get: perfCounts })

/** Whether the page is visible (a hidden browser tab runs no polling or drawing). */
export const pageVisible = () => typeof document === 'undefined' || !document.hidden
