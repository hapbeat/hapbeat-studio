import { MOMENT_S, type SceneEvent, type SceneItem } from './sceneData'
import type { CueTable } from './sceneCueTable'
import { occurrenceKeys } from './sceneFiringGain'
import { recordedIndexMap, recordedName } from './sceneStrength'

/**
 * The Scene timeline's editing (DEC-112 stage B), pure parts: moment numbers of firings (the moments list's numbering,
 * shared by the bar labels, the card and the list's in-view / chosen rows), the drag axes under the locks, frame
 * snapping of a time drag, and which lanes are drawn.
 */

/** A moment's number as the moments list shows it (zero-padded: 04). */
export const momentNumber = (k: number) => String(k).padStart(2, '0')

/**
 * Each firing's moment (its row `k` in the moments list), aligned with `events`; null when it belongs to none (a moment
 * left out by the moment rules, an emitted firing far from any moment). A firing belongs to moment k when the moment
 * lists its name and it fires within MOMENT_S after the moment's first cue (deriveMoments' grouping).
 */
export function firingMoments(items: readonly SceneItem[], events: readonly SceneEvent[]): (number | null)[] {
  const clips = items.flatMap((it, k) => it.kind === 'clip' ? [k] : [])
  return events.map(ev => {
    // The last moment starting at or before the firing, then back while still within MOMENT_S.
    let lo = 0, hi = clips.length
    while (lo < hi) { const m = (lo + hi) >> 1; if (items[clips[m]].at <= ev.t + 1e-9) lo = m + 1; else hi = m }
    for (let j = lo - 1; j >= 0; j--) {
      const it = items[clips[j]]
      if (ev.t - it.at > MOMENT_S + 1e-9) break
      if (it.names.includes(ev.name)) return clips[j]
    }
    return null
  })
}

/** The moment numbers (sorted, distinct) of the firings between replay times `a` and `b`. */
export function momentsInRange(events: readonly SceneEvent[], moments: readonly (number | null)[], a: number, b: number): number[] {
  const lo = Math.min(a, b), hi = Math.max(a, b), found = new Set<number>()
  events.forEach((ev, i) => { const k = moments[i]; if (k != null && ev.t >= lo && ev.t <= hi) found.add(k) })
  return [...found].sort((x, y) => x - y)
}

/** First–last moment numbers ("04–08", one: "04"); '' for none. */
export function momentRangeText(numbers: readonly number[]): string {
  if (!numbers.length) return ''
  const first = Math.min(...numbers), last = Math.max(...numbers)
  return first === last ? momentNumber(first) : `${momentNumber(first)}–${momentNumber(last)}`
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

/** A selected bar this close (CSS px) to the firing card (SceneFiringCard)'s side counts as under it. */
const BAR_MARGIN = 6

/**
 * Where the card is drawn in a `panel` × `card` sized box: `pos` (from the panel's right or left edge, and its top) kept
 * inside the panel, on the right unless a selected bar (`xs`, CSS px from the panel's left) would be under it there and
 * none would be on the left (then mirrored: the same distance from the left edge).
 */
export function cardPlace(pos: { right: number; top: number }, panel: { w: number; h: number }, card: { w: number; h: number }, xs: readonly number[]): { side: 'right' | 'left'; x: number; top: number } {
  const x = Math.max(0, Math.min(pos.right, panel.w - card.w)), top = Math.max(0, Math.min(pos.top, panel.h - card.h))
  const covers = (a: number) => xs.some(bx => bx >= a - BAR_MARGIN && bx <= a + card.w + BAR_MARGIN)
  return { side: covers(panel.w - x - card.w) && !covers(x) ? 'left' : 'right', x, top }
}
