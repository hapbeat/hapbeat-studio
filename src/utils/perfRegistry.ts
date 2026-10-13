/**
 * Live counts of what keeps Studio busy while idle — intervals, animation loops, AudioContexts — readable
 * as `window.__studioPerf` (diagnostics: a long-lived tab or many hot reloads must not pile them up).
 */
export type PerfKind = 'intervals' | 'rafLoops' | 'audioContexts'
const counts: Record<PerfKind, number> = { intervals: 0, rafLoops: 0, audioContexts: 0 }
export function perfTrack(kind: PerfKind, delta: 1 | -1) { counts[kind] = Math.max(0, counts[kind] + delta) }
export const perfCounts = () => ({ ...counts })
if (typeof window !== 'undefined') Object.defineProperty(window, '__studioPerf', { configurable: true, get: perfCounts })

/**
 * Recent durations in ms per label (last 20), readable as `window.__studioTimings`: where a slow path spends
 * its time (e.g. `trials.save`, `trials.poll`). Durations of 100 ms or more also go to console.debug.
 */
const timings: Record<string, number[]> = {}
export function perfTiming(label: string, ms: number) {
  const list = (timings[label] ??= [])
  list.push(Math.round(ms))
  if (list.length > 20) list.shift()
  if (ms >= 100) console.debug(`[perf] ${label} ${Math.round(ms)} ms`)
}
export const perfTimings = () => Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, [...v]]))
if (typeof window !== 'undefined') Object.defineProperty(window, '__studioTimings', { configurable: true, get: perfTimings })

/** Whether the page is visible (a hidden browser tab runs no polling or drawing). */
export const pageVisible = () => typeof document === 'undefined' || !document.hidden
