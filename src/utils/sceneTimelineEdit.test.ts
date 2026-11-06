import { describe, expect, it } from 'vitest'
import { dragAxes, firingMoments, firingSelectionAt, rangeRepeats, firingNumber, firingNumbers, firingRows, numberRangeText, numbersInRange, repeatRange, repeatRangeText, shownIndexOf, snapDt, tableHasSfx, visibleLanes } from './sceneTimelineEdit'
import { sampleTable } from './sceneTestFixtures'
import type { SceneEvent, SceneItem } from './sceneData'

const ev = (name: string, t: number, extra: Partial<SceneEvent> = {}): SceneEvent => ({ t, name, hand: 'right', ...extra })
const item = (kind: 'full' | 'clip', names: string[], at: number): SceneItem =>
  ({ kind, file: 'full.mp4', name: names[0] ?? 'full', names, hand: '', at, note: '', event: at, start: Math.max(0, at - 2), end: at + 3, levels: [] })
const items = [item('full', [], 0), item('clip', ['hit', 'step'], 1), item('clip', ['hit'], 5), item('clip', ['tick'], 5.1)]

describe('sceneTimelineEdit', () => {
  it('numbers firings like the moments list', () => {
    expect(firingNumber(4)).toBe('04')
    expect(firingNumber(12)).toBe('12')
  })
  it('numbers the recorded firings in time order (edited times; one time keeps its order) and not the emitted ones', () => {
    const events = [ev('b', 2), ev('a', 1), { ...ev('pulse', 1.5), emitted: true } as SceneEvent, ev('c', 1), ev('a', 3)]
    expect(firingNumbers(events)).toEqual([3, 1, null, 2, 4])
  })
  it('finds each firing’s moment by time within MOMENT_S of its first cue (a tick: its own moment)', () => {
    const events = [ev('hit', 1), ev('step', 1.15), ev('step', 1.5), ev('hit', 5), ev('tick', 5.1), ev('other', 1.05), ev('tick', 6)]
    expect(firingMoments(items, events, ['tick'])).toEqual([1, 1, null, 2, 3, 1, null])
  })
  it('keeps a renamed firing in its moment (an override renames the firing, not every moment that lists it)', () => {
    // hit_n 29.1 s + hit_table 29.2 s are one moment; hit_table is changed to smash (the moment keeps its names).
    const moments = [item('full', [], 0), item('clip', ['hit_n', 'hit_table'], 29.1), item('clip', ['applause'], 37.567)]
    const events = [ev('hit_n', 29.1), ev('smash', 29.2), ev('clap2', 37.567), ev('applause', 37.667), ev('applause', 37.733)]
    expect(firingMoments(moments, events, [])).toEqual([1, 1, 2, 2, 2])
    expect(firingRows(moments, events, []).map(r => r.group)).toEqual([
      { first: true, last: false }, { first: false, last: true }, { first: true, last: false }, { first: false, last: false }, { first: false, last: true }])
  })
  it('selects a haptic one-shot firing as a row click does (not a tick, an emitted or an unknown firing)', () => {
    const table = sampleTable(), cue = Object.keys(table.cues).find(c => table.cues[c].haptics?.length)!
    const recorded = [ev('tick', 0.5), ev(cue, 2), ev(cue, 1)]
    const shown = [recorded[0], recorded[2], recorded[1]] // time order: recorded 0, 2, 1
    expect(firingSelectionAt(table, ['tick'], shown, recorded, cue, 2)).toEqual([1])
    expect(firingSelectionAt(table, ['tick'], shown, recorded, cue, 1.01)).toEqual([2])
    expect(firingSelectionAt(table, ['tick'], shown, recorded, 'tick', 0.5)).toEqual([])
    expect(firingSelectionAt(table, ['tick'], shown, recorded, cue, 3)).toEqual([])
    expect(firingSelectionAt(null, ['tick'], shown, recorded, cue, 2)).toEqual([])
  })
  it('lists every recorded firing once as a row, joining a moment\u2019s firings by a group mark', () => {
    const events = [ev('hit', 1), ev('step', 1.15), { ...ev('pulse', 2), emitted: true } as SceneEvent, ev('hit', 5), ev('tick', 5.1)]
    expect(firingRows(items, events, ['tick'])).toEqual([
      { index: 0, num: 1, moment: 1, group: { first: true, last: false } },
      { index: 1, num: 2, moment: 1, group: { first: false, last: true } },
      { index: 3, num: 3, moment: 2, group: false },
      { index: 4, num: 4, moment: 3, group: false },
    ])
  })
  it('finds the first and last numbers of the firings in a time range (the timeline\u2019s drawn range)', () => {
    const events = [ev('hit', 1), ev('step', 1.1), { ...ev('pulse', 3), emitted: true } as SceneEvent, ev('hit', 5), ev('tick', 5.1)]
    const nums = firingNumbers(events)
    expect(numbersInRange(events, nums, 0, 2)).toEqual([1, 2])
    expect(numbersInRange(events, nums, 6, 1.1)).toEqual([2, 4])
    expect(numbersInRange(events, nums, 2.5, 4)).toBeNull()
    expect(numberRangeText([1, 3])).toBe('01–03')
    expect(numberRangeText([2, 2])).toBe('02')
    expect(numberRangeText(null)).toBe('')
  })
  it('says what repeats: a part or span, a moment from its lead-in, a chapter, else the full replay', () => {
    const moment = items[2] // at 5: stretch 3–8
    expect(repeatRange(moment, null, 1, null)).toEqual([4, 8])
    expect(repeatRange(moment, null, 5, null)).toEqual([3, 8])
    expect(repeatRange(moment, [4.5, 9.25], 1, null)).toEqual([4.5, 9.25])
    expect(repeatRange(items[0], null, 1, { start: 10, end: 20, label: 'Tennis' })).toEqual([10, 20])
    expect(repeatRange(items[0], null, 1, null)).toBeNull()
    expect(repeatRangeText([3.3, 8.26])).toBe('3.3–8.3')
    expect(repeatRangeText(null)).toBe('')
    // It repeats with W's part / a span or with the loop on; otherwise it plays once.
    expect(rangeRepeats(true, false)).toBe(true)
    expect(rangeRepeats(false, true)).toBe(true)
    expect(rangeRepeats(false, false)).toBe(false)
  })
  it('moves only the unlocked axes, Shift keeping the larger one', () => {
    expect(dragAxes(30, 5, { time: true, gain: false }, false)).toEqual({ time: false, gain: true })
    expect(dragAxes(30, 5, { time: false, gain: true }, true)).toEqual({ time: true, gain: false })
    expect(dragAxes(30, 5, { time: true, gain: true }, false)).toEqual({ time: false, gain: false })
    expect(dragAxes(30, 5, { time: false, gain: false }, false)).toEqual({ time: true, gain: true })
    expect(dragAxes(30, 5, { time: false, gain: false }, true)).toEqual({ time: true, gain: false })
    expect(dragAxes(3, -50, { time: false, gain: false }, true)).toEqual({ time: false, gain: true })
  })
  it('snaps a time shift to frames', () => {
    expect(snapDt(0.049, 30)).toBeCloseTo(1 / 30)
    expect(snapDt(-0.07, 30)).toBeCloseTo(-2 / 30)
    expect(snapDt(0.01, 30)).toBe(0)
  })
  it('maps recorded indices to shown firings (renamed ones by their recorded name, times as edited)', () => {
    const edited = [ev('b', 2), ev('a', 1), ev('a', 1)]
    const shown = [{ ...ev('x', 1), from: 'a' }, ev('a', 1), ev('b', 2), ev('emitted', 3)]
    expect([...shownIndexOf(shown, edited)]).toEqual([[1, 0], [2, 1], [0, 2]])
  })
  it('draws the sound lane only when chosen and the table has sound, and always one lane', () => {
    const table = sampleTable()
    expect(tableHasSfx(table)).toBe(Object.values(table.cues).some(c => !!c.sfx))
    expect(tableHasSfx(null)).toBe(false)
    expect(tableHasSfx({ ...table, cues: { a: { haptics: [] } } } as never)).toBe(false)
    expect(visibleLanes({ sound: true, haptics: true }, true)).toEqual({ sound: true, haptics: true })
    expect(visibleLanes({ sound: true, haptics: false }, true)).toEqual({ sound: true, haptics: false })
    expect(visibleLanes({ sound: true, haptics: false }, false)).toEqual({ sound: false, haptics: true })
    expect(visibleLanes({ sound: false, haptics: false }, true)).toEqual({ sound: false, haptics: true })
  })
})
