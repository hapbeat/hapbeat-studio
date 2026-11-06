import { clipEnd, isTick, MOMENT_S, momentStart, type SceneChapter, type SceneEvent, type SceneItem } from './sceneData'
import type { CueTable } from './sceneCueTable'
import { firingStrength, occurrenceKeys } from './sceneFiringGain'
import { recordedIndexMap, recordedName } from './sceneStrength'

/**
 * The Scene timeline's editing (DEC-112), pure parts: firing numbers (the moments list's rows, shared by the bar
 * labels and the 「発生」 panel), the list's rows and the rows in the timeline's view, the repeat range, the drag axes under the
 * locks, frame snapping of a time drag, and which lanes are drawn.
 */

/** A firing's number as the moments list and the bar labels show it (zero-padded: 04). */
export const firingNumber = (n: number) => String(n).padStart(2, '0')

/** A shown firing made by a cue table `emit` (sceneEmit), not recorded: not numbered, not listed. */
export const isEmitted = (ev: SceneEvent) => !!(ev as { emitted?: true }).emitted

/**
 * Each shown firing's number (1, 2, … over the recorded firings in time order, edits applied: `events` are the shown
 * firings), aligned with `events`; null for an emitted firing. Firings at one time keep their order.
 */
export function firingNumbers(events: readonly SceneEvent[]): (number | null)[] {
  const out: (number | null)[] = events.map(() => null)
  let n = 0
  for (const i of events.map((_, i) => i).sort((a, b) => events[a].t - events[b].t || a - b)) if (!isEmitted(events[i])) out[i] = ++n
  return out
}

/**
 * One row of the moments list: a recorded firing (`index` into the shown firings), its number, its moment (items
 * index; null for none), and the group mark of a moment with several firings (`group`: its first / last row of a run
 * of consecutive rows of that moment; false for a moment of one firing).
 */
export interface FiringRow { index: number; num: number; moment: number | null; group: false | { first: boolean; last: boolean } }

/** The moments list's rows: every recorded firing once, in number order (time order), grouped by moment (firingMoments). */
export function firingRows(items: readonly SceneItem[], events: readonly SceneEvent[], ticks: readonly string[]): FiringRow[] {
  const nums = firingNumbers(events), moments = firingMoments(items, events, ticks)
  const rows = events.flatMap((_, i) => nums[i] === null ? [] : [{ index: i, num: nums[i]!, moment: moments[i] }]).sort((a, b) => a.num - b.num)
  const size = new Map<number, number>()
  for (const r of rows) if (r.moment !== null) size.set(r.moment, (size.get(r.moment) ?? 0) + 1)
  return rows.map((r, k) => ({ ...r, group: r.moment !== null && size.get(r.moment)! > 1
    ? { first: rows[k - 1]?.moment !== r.moment, last: rows[k + 1]?.moment !== r.moment } : false }))
}

/**
 * The first and last numbers of the recorded firings whose time is in [a, b] (the timeline's drawn range); null for
 * none. Firings are numbered in time order, so every number between them is in the range too.
 */
export function numbersInRange(events: readonly SceneEvent[], numbers: readonly (number | null)[], a: number, b: number): [number, number] | null {
  const lo = Math.min(a, b), hi = Math.max(a, b)
  let first = Infinity, last = -Infinity
  events.forEach((ev, i) => { const n = numbers[i]; if (n != null && ev.t >= lo && ev.t <= hi) { first = Math.min(first, n); last = Math.max(last, n) } })
  return first <= last ? [first, last] : null
}

/** First–last numbers ("04–08", one: "04"); '' for none. */
export function numberRangeText(range: readonly [number, number] | null): string {
  if (!range) return ''
  return range[0] === range[1] ? firingNumber(range[0]) : `${firingNumber(range[0])}–${firingNumber(range[1])}`
}

/**
 * What plays now (replay seconds, SceneRuntime's play range): W's part or a playing loop cue span (`part`), else a
 * moment from its lead-in to its end, else a chapter playing; null = the full replay.
 */
export function repeatRange(item: SceneItem, part: readonly [number, number] | null, leadSec: number, chapter: SceneChapter | null): [number, number] | null {
  if (part) return [part[0], part[1]]
  if (item.kind === 'clip') return [momentStart(item, leadSec), clipEnd(item)]
  return chapter ? [chapter.start, chapter.end] : null
}

/** Whether that range repeats (SceneRuntime.tick): W's part / a span always, else only with the loop setting on (off: it plays once and stops). */
export const rangeRepeats = (part: boolean, loop: boolean) => part || loop

/** A repeat range as 「3.3–8.3」 (seconds, one decimal); '' for the full replay. */
export const repeatRangeText = (range: readonly [number, number] | null) => range ? `${range[0].toFixed(1)}–${range[1].toFixed(1)}` : ''

/**
 * Each firing's moment (items index), aligned with `events`; null when it belongs to none (an emitted firing far from
 * any moment). By time, as deriveMoments groups: a non-tick firing belongs to the last non-tick moment starting at or
 * before it within MOMENT_S, a tick firing to the tick moment at its own time. Not by name: an override renames a
 * firing without renaming every moment that lists it.
 */
export function firingMoments(items: readonly SceneItem[], events: readonly SceneEvent[], ticks: readonly string[]): (number | null)[] {
  const clips = items.flatMap((it, k) => it.kind === 'clip' ? [k] : [])
  const plain = clips.filter(k => !isTick(ticks, items[k].name)), tick = clips.filter(k => isTick(ticks, items[k].name))
  /** The last of `ks` (sorted by `at`) starting at or before `t`; -1 for none. */
  const lastAtOrBefore = (ks: number[], t: number) => {
    let lo = 0, hi = ks.length
    while (lo < hi) { const m = (lo + hi) >> 1; if (items[ks[m]].at <= t + 1e-9) lo = m + 1; else hi = m }
    return lo - 1
  }
  return events.map(ev => {
    if (isTick(ticks, ev.name)) {
      const j = lastAtOrBefore(tick, ev.t)
      return j >= 0 && Math.abs(items[tick[j]].at - ev.t) <= 1e-9 ? tick[j] : null
    }
    const j = lastAtOrBefore(plain, ev.t)
    return j >= 0 && ev.t - items[plain[j]].at <= MOMENT_S + 1e-9 ? plain[j] : null
  })
}

/**
 * The firing selection (recorded indices) for the firing `name` at shown time `t`, as a moments row click makes it: that
 * firing when it is a haptic one-shot (not a tick, with a strength in `table`), else none. `shown`: data.full.events;
 * `edited`: the recording with the edits (recorded order).
 */
export function firingSelectionAt(table: CueTable | null, ticks: readonly string[], shown: readonly SceneEvent[], edited: readonly SceneEvent[] | null, name: string, t: number): number[] {
  if (!table || !edited) return []
  const k = shown.findIndex(e => e.name === name && Math.abs(e.t - t) < 0.02), ev = shown[k]
  if (!ev || isEmitted(ev) || isTick(ticks, ev.name) || !firingStrength(table, shown, ev)) return []
  const i = [...shownIndexOf(shown, edited)].find(([, kk]) => kk === k)?.[0]
  return i === undefined ? [] : [i]
}

/**
 * Which axes a drag on a selected bar moves: a locked axis never; with both unlocked, both, or with Shift only the
 * larger one (|dx| vs |dy| in CSS px).
 */
export function dragAxes(dx: number, dy: number, locks: { time: boolean; gain: boolean }, shift: boolean): { time: boolean; gain: boolean } {
  const time = !locks.time, gain = !locks.gain
  if (time && gain && shift) return Math.abs(dx) >= Math.abs(dy) ? { time: true, gain: false } : { time: false, gain: true }
  return { time, gain }
}

/** A time shift snapped to whole frames. */
export const snapDt = (dt: number, fps: number) => fps > 0 ? Math.round(dt * fps) / fps : dt

/**
 * Index of each shown firing (data.full.events) by its recorded firing's index (viewer-data events[i], keys over
 * `edited`: the recording with the edits, in recorded order). Emitted firings are not recorded and get none.
 */
export function shownIndexOf(shown: readonly SceneEvent[], edited: readonly SceneEvent[]): Map<number, number> {
  const indexOf = recordedIndexMap(edited), keys = occurrenceKeys(shown, recordedName), out = new Map<number, number>()
  keys.forEach((key, k) => { const i = indexOf.get(key); if (i !== undefined && !out.has(i)) out.set(i, k) })
  return out
}

/** Whether the cue table plays any sound (a cue or a variant with a sfx). */
export const tableHasSfx = (table: CueTable | null) => !!table && Object.values(table.cues).some(c => !!c.sfx || Object.values(c.variants ?? {}).some(v => !!v.sfx))

/** The lanes drawn: sound only when chosen and the table has sound; haptics when chosen, or when no other lane is. */
export function visibleLanes(lanes: { sound: boolean; haptics: boolean }, hasSfx: boolean): { sound: boolean; haptics: boolean } {
  const sound = lanes.sound && hasSfx
  return { sound, haptics: lanes.haptics || !sound }
}
