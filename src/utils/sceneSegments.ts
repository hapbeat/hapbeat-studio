import type { SceneEvent } from './sceneData'

/**
 * DEC-085: the editor shows one representative stretch of the full replay per event, cut by time from
 * `full.events` (never a choice among recorded clips), and plays it at the recording's timing.
 *
 * - One-off target: from 1 s before its first firing to its sound's length + 0.5 s after it.
 * - Repeating target (≥ 3 firings, median gap ≤ 2.5 s): the firings of its family (the cues of the targets
 *   and their variants: bite + bite:tear, footstep + footstep:approach) chained while ≤ 2.5 s apart; the
 *   first chain with ≥ 3 target firings (else the one with the most), cut after its 6th target firing.
 *   The window runs from 1.5 s before the chain's first firing to the last firing + sound + 1 s.
 *
 * Target firings play the auditioned material; the family's other firings play their decided sound.
 */
export const CHAIN_GAP_SEC = 1.5 + 1 // 2.5 s
export const REPEAT_MIN = 3
export const REPEAT_MEDIAN_GAP_SEC = 2.5
export const MAX_TARGETS = 6
export const LEAD_SEC = 1
export const TAIL_SEC = 0.5
export const CHAIN_LEAD_SEC = 1.5
export const CHAIN_TAIL_SEC = 1

export interface SceneMark { t: number; name: string; /** A firing of the targets (red; plays the auditioned material); else another cue of the family (grey; its decided sound). */ target: boolean }
export interface SceneSegment {
  /** The targets (cues / `cue:variant` names; the first names the stretch). */
  names: string[]
  /** Video times in the full replay. */
  start: number
  end: number
  /** Firings in the stretch, ascending (full replay times). */
  marks: SceneMark[]
  /** A repeating target (a chain of its family); else one firing. */
  repeating: boolean
  /** How often the targets fire in the whole recording. */
  total: number
}

const cueOf = (name: string) => name.split(':')[0]

/** Every firing of `name` in the recording (ascending times). */
export function occurrences(events: readonly SceneEvent[], name: string): number[] {
  return events.filter(e => e.name === name).map(e => e.t).sort((a, b) => a - b)
}

export function medianGap(times: readonly number[]): number | null {
  if (times.length < 2) return null
  const gaps = times.slice(1).map((t, i) => t - times[i]).sort((a, b) => a - b), mid = gaps.length >> 1
  return gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2
}
/** Targets that repeat in the recording: ≥ 3 firings whose consecutive gaps have a median ≤ 2.5 s. */
export function isRepeating(events: readonly SceneEvent[], names: readonly string[]): boolean {
  const times = events.filter(e => names.includes(e.name)).map(e => e.t).sort((a, b) => a - b)
  const gap = medianGap(times)
  return times.length >= REPEAT_MIN && gap !== null && gap <= REPEAT_MEDIAN_GAP_SEC
}

/** The representative stretch of `targets` (null when none fires). `soundSec`: the length of the targets' sound. */
export function sceneSegment(events: readonly SceneEvent[], targets: readonly string[], soundSec: number): SceneSegment | null {
  const names = [...targets]
  const own = events.filter(e => names.includes(e.name)).sort((a, b) => a.t - b.t)
  if (!own.length) return null
  const sound = Math.max(0, soundSec)
  if (!isRepeating(events, names)) {
    const t = own[0].t
    return { names, start: Math.max(0, t - LEAD_SEC), end: t + sound + TAIL_SEC, marks: [{ t, name: own[0].name, target: true }], repeating: false, total: own.length }
  }
  const family = new Set(names.map(cueOf))
  const fired = events.filter(e => family.has(cueOf(e.name))).sort((a, b) => a.t - b.t)
  const chains: SceneEvent[][] = []
  for (const e of fired) {
    const last = chains[chains.length - 1]
    if (last && e.t - last[last.length - 1].t <= CHAIN_GAP_SEC) last.push(e); else chains.push([e])
  }
  const count = (chain: SceneEvent[]) => chain.filter(e => names.includes(e.name)).length
  const chain = chains.find(c => count(c) >= REPEAT_MIN) ?? chains.reduce((best, c) => count(c) > count(best) ? c : best)
  // Up to the 6th target firing (the other cues fired before it stay in).
  const marks: SceneMark[] = []
  let targetsSeen = 0
  for (const e of chain) {
    const target = names.includes(e.name)
    if (target && targetsSeen === MAX_TARGETS) break
    if (target) targetsSeen++
    marks.push({ t: e.t, name: e.name, target })
  }
  // Nothing of the family after the last target firing when the cut stopped the chain.
  return { names, start: Math.max(0, marks[0].t - CHAIN_LEAD_SEC), end: marks[marks.length - 1].t + sound + CHAIN_TAIL_SEC, marks, repeating: true, total: own.length }
}

/** A waveform selection on a stretch's audition as seconds of one play (for `useRange`); null when it is empty. */
export function toFirstPlay(sel: { start: number; end: number } | null, offsets: readonly number[] | null, duration: number): { start: number; end: number } | null {
  if (!sel) return null
  const o = offsets ? [...offsets].reverse().find(x => x <= sel.start + 1e-9) ?? 0 : 0
  const start = Math.max(0, sel.start - o), end = Math.min(duration, sel.end - o)
  return end > start ? { start, end } : null
}
