import { fireShot, MaterialPicker, type EffectiveEvent, type PlannedShot } from './cueEvents'
import type { SceneEvent } from './sceneData'

/**
 * DEC-085: the editor shows one representative stretch of the full replay per
 * event (cue or `cue:variant`), cut by time from `full.events` — never a choice
 * among recorded clips.
 *
 * - One-off event: from 1 s before its first firing to the sound's length + 0.5 s after it.
 * - Repeated event (the same name ≥ 3 times, ≤ 1.5 s apart): the first such run, up to
 *   6 firings; every firing in it is a mark, and each mark fires sound and haptics.
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
 * One firing per mark, at the game's timing (offsets from the first mark), each with
 * its own variation draw (picks, gain / pitch / rate jitter). Loop cues: the jitter of a loop.
 */
export function planSegmentShots(e: EffectiveEvent, marks: readonly number[], loop: boolean, random: () => number = Math.random): PlannedShot[] {
  const picker = new MaterialPicker(random)
  return marks.map((t, index) => ({ index, atSec: t - marks[0], ...fireShot(e, loop, picker, random) }))
}
