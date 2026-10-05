import type { SceneEvent } from './sceneData'

/**
 * DEC-085: the editor shows one representative stretch of the full replay per
 * event (cue or `cue:variant`), cut by time from `full.events` — never a choice
 * among recorded clips.
 *
 * - One-off event: from 1 s before its first firing to the sound's length + 0.5 s after it.
 * - Repeated event (the same name ≥ 3 times, ≤ 1.5 s apart): the first such run, up to 6 firings.
 *   The editor shows its first firing like a one-off; "×5" plays a material on its marks (no jitter);
 *   the run with the variation is played in the Scene tab.
 */
export const RUN_GAP_SEC = 1.5
export const RUN_MIN = 3
export const RUN_MAX = 6
export const LEAD_SEC = 1
export const TAIL_SEC = 0.5

export interface SceneSegment {
  /** The event (full.events `name`). */
  name: string
  /** Video times in the full replay. */
  start: number
  end: number
  /** Firings shown and played (full replay times, ascending); the first is the playback's 0 s. */
  marks: number[]
  /** A run of a repeated event (else a one-off firing). */
  run: boolean
  /** How often the event fires in the whole recording. */
  total: number
}

/** Every firing of `name` in the recording (ascending times). */
export function occurrences(events: readonly SceneEvent[], name: string): number[] {
  return events.filter(e => e.name === name).map(e => e.t).sort((a, b) => a - b)
}

/** Runs of ≥ RUN_MIN firings with gaps ≤ RUN_GAP_SEC. */
export function findRuns(times: readonly number[]): number[][] {
  const runs: number[][] = []
  let current: number[] = []
  for (const t of times) {
    if (current.length && t - current[current.length - 1] > RUN_GAP_SEC) { if (current.length >= RUN_MIN) runs.push(current); current = [] }
    current.push(t)
  }
  if (current.length >= RUN_MIN) runs.push(current)
  return runs
}

/** The representative stretch of event `name`; null when it never fires. `soundSec`: the length of its sound (one-offs end after it). */
export function representativeSegment(events: readonly SceneEvent[], name: string, soundSec: number): SceneSegment | null {
  const times = occurrences(events, name)
  if (!times.length) return null
  const tail = Math.max(0, soundSec) + TAIL_SEC
  const run = findRuns(times)[0]
  const marks = run ? run.slice(0, RUN_MAX) : [times[0]]
  return { name, start: Math.max(0, marks[0] - LEAD_SEC), end: marks[marks.length - 1] + tail, marks, run: !!run, total: times.length }
}

/**
 * The offsets of `times` plays of one material in an editor audition (no jitter): the real timing of the
 * cue's representative run (its first firings; a shorter run continues at its mean gap), else (a one-off
 * cue, no recording) `soundSec` + 0.4 s apart.
 */
export const LISTEN_PAUSE_SEC = 0.4
export function listenOffsets(events: readonly SceneEvent[] | null, name: string, times: number, soundSec: number): number[] {
  const run = events ? findRuns(occurrences(events, name))[0] : undefined
  const out = run ? run.slice(0, times).map(t => t - run[0]) : [0]
  const gap = run && run.length > 1 ? (run[run.length - 1] - run[0]) / (run.length - 1) : Math.max(0, soundSec) + LISTEN_PAUSE_SEC
  while (out.length < times) out.push(out[out.length - 1] + gap)
  return out
}

/** A waveform selection on a repeated audition as seconds of one play (for `useRange`); null when it is empty. */
export function toFirstPlay(sel: { start: number; end: number } | null, offsets: readonly number[] | null, duration: number): { start: number; end: number } | null {
  if (!sel) return null
  const o = offsets ? [...offsets].reverse().find(x => x <= sel.start + 1e-9) ?? 0 : 0
  const start = Math.max(0, sel.start - o), end = Math.min(duration, sel.end - o)
  return end > start ? { start, end } : null
}
