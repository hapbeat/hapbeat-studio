import { describe, expect, it } from 'vitest'
import { applyEdits, matchEdits, parseViewerEdits, retimed, serializeViewerEdits, setEditFor, snapTime, type FiringEdit } from './sceneEdits'
import type { SceneEvent } from './sceneData'
import { sampleData, sampleLib } from './sceneTestFixtures'

const ev = (t: number, name: string, hand = ''): SceneEvent => ({ t, name, hand })

describe('viewer-edits.json', () => {
  it('reads the entries, leaves out (and counts) the ones that do not fit', () => {
    const { edits, dropped } = parseViewerEdits(JSON.stringify({ schema_version: 1, firings: [
      { of: { name: 'roar', t: 4 }, gain: 0.6 },
      { of: { name: 'grab', t: 6, hand: 'right' }, gain: 1.2, t: 6.05 },
      { of: { name: 'Roar', t: 4 }, gain: 1 },
      { of: { name: 'roar', t: -1 }, gain: 1 },
      { of: { name: 'roar', t: 1, hand: 'up' }, gain: 1 },
      { of: { name: 'roar', t: 1 } },
      { of: { name: 'roar', t: 1 }, gain: -0.5 },
      'x',
    ] }))
    expect(edits.firings).toEqual([{ of: { name: 'roar', t: 4 }, gain: 0.6 }, { of: { name: 'grab', t: 6, hand: 'right' }, gain: 1.2, t: 6.05 }])
    expect(dropped).toBe(6)
  })
  it('refuses a file that is not JSON, of another version or without firings', () => {
    expect(() => parseViewerEdits('{')).toThrow(/viewer-edits.json/)
    expect(() => parseViewerEdits('{"schema_version":2,"firings":[]}')).toThrow(/schema_version/)
    expect(() => parseViewerEdits('{"schema_version":1}')).toThrow(/firings/)
  })
  it('writes entries by time, name and hand; times to 4 decimals, gains to 4 significant digits; reads back the same', () => {
    const firings: FiringEdit[] = [
      { of: { name: 'grab', t: 6, hand: 'right' }, t: 6.033333333 },
      { of: { name: 'grab', t: 6 }, gain: 0.123456 },
      { of: { name: 'arm', t: 6 }, gain: 2 },
      { of: { name: 'roar', t: 1.00004 }, gain: 0 },
    ]
    const text = serializeViewerEdits({ schema_version: 1, firings })
    expect(text.endsWith('}\n')).toBe(true)
    expect(text).toContain('\n  "firings": [\n    {')
    expect(JSON.parse(text).firings).toEqual([
      { of: { name: 'roar', t: 1 }, gain: 0 },
      { of: { name: 'arm', t: 6 }, gain: 2 },
      { of: { name: 'grab', t: 6 }, gain: 0.1235 },
      { of: { name: 'grab', t: 6, hand: 'right' }, t: 6.0333 },
    ])
    expect(serializeViewerEdits(parseViewerEdits(text).edits)).toBe(text)
  })
})

describe('matching the entries to the recorded firings', () => {
  const fps = 30, half = 0.5 / fps
  it('same name and hand (both absent: the same), within half a frame', () => {
    const events = [ev(1, 'roar'), ev(2, 'grab', 'right'), ev(3, 'grab')]
    const m = matchEdits(events, fps, [
      { of: { name: 'roar', t: 1 + half * 0.99 }, gain: 1 },
      { of: { name: 'grab', t: 2, hand: 'right' }, gain: 1 },
      { of: { name: 'grab', t: 3, hand: 'left' }, gain: 1 },
      { of: { name: 'grab', t: 3 + half * 1.01 }, gain: 1 },
      { of: { name: 'other', t: 1 }, gain: 1 },
    ])
    expect([...m.byEvent]).toEqual([[0, 0], [1, 1]])
    expect(m.orphans).toEqual([2, 3, 4])
  })
  it('each firing takes one entry; entries by time take the nearest free one (equal distance: the lower index)', () => {
    const events = [ev(1, 'tap'), ev(1, 'tap'), ev(1.02, 'tap')]
    // Two entries at 1: the two firings at 1 (lower index first); one between 1 and 1.02 (equal): the free one at 1.02.
    const m = matchEdits(events, fps, [{ of: { name: 'tap', t: 1.01 }, gain: 3 }, { of: { name: 'tap', t: 1 }, gain: 1 }, { of: { name: 'tap', t: 1 }, gain: 2 }])
    expect(m.byEvent.get(0)).toBe(1)
    expect(m.byEvent.get(1)).toBe(2)
    expect(m.byEvent.get(2)).toBe(0)
    const tie = matchEdits([ev(1, 'tap'), ev(1.02, 'tap')], fps, [{ of: { name: 'tap', t: 1.01 }, gain: 1 }])
    expect([...tie.byEvent]).toEqual([[0, 0]])
    const one = matchEdits([ev(1, 'tap')], fps, [{ of: { name: 'tap', t: 1 }, gain: 1 }, { of: { name: 'tap', t: 1.001 }, gain: 2 }])
    expect([...one.byEvent]).toEqual([[0, 0]])
    expect(one.orphans).toEqual([1])
  })
})

describe('laying the edits over the recording', () => {
  it('keeps the recorded order and length, the levels and every other field; a time stays within the video', () => {
    const data = sampleData(), firings: FiringEdit[] = [{ of: { name: 'button', t: 3, hand: 'right' }, gain: 0.25 }, { of: { name: 'grab', t: 3.1, hand: 'right' }, t: 99 }]
    const m = matchEdits(data.full.events, data.fps, firings)
    const out = applyEdits(data, firings, m.byEvent)
    expect(out.full.events.map(e => e.name)).toEqual(data.full.events.map(e => e.name))
    expect(out.full.events[1]).toEqual({ ...data.full.events[1], gain: 0.25 })
    expect(out.full.events[2].t).toBe(5)
    expect(out.full.levels).toBe(data.full.levels)
    expect(out.clips).toBe(data.clips)
    expect(out.full.events[0]).toBe(data.full.events[0])
    expect(applyEdits(data, [], new Map())).toBe(data)
  })
  it('a firing moved past its neighbour plays in time order, at its new time and once; the moments follow it', () => {
    const data = sampleData(), lib = sampleLib()
    // button 3.0 → 4.0 (past grab 3.1, detent 3.15).
    const firings: FiringEdit[] = [{ of: { name: 'button', t: 3, hand: 'right' }, t: 4 }]
    const edited = applyEdits(data, firings, matchEdits(data.full.events, data.fps, firings).byEvent)
    expect(edited.full.events[1]).toMatchObject({ name: 'button', t: 4 })
    const shown = retimed(data, edited, lib)
    expect(shown.full.events.map(e => e.t)).toEqual([1, 3.1, 3.15, 4, 4.5])
    expect(shown.full.levels).toBe(data.full.levels)
    // The runtime's scheduling (every firing in (cursor, end] of each step) fires it once, at 4.
    const fired: [string, number][] = []
    let cursor = -1
    for (let end = 0; end <= 5.001; end += 1 / 30) { for (const e of shown.full.events) if (e.t > cursor && e.t <= end) fired.push([e.name, e.t]); cursor = end }
    expect(fired.filter(([n]) => n === 'button')).toEqual([['button', 4]])
    // The moments: grab at 3.1 now starts its own, button at 4 another (detent is a tick: one each).
    expect(shown.clips.map(c => [c.name, c.at])).toEqual([['detent', 1], ['grab', 3.1], ['detent', 3.15], ['button', 4], ['feed_loop', 4.5]])
    expect(shown.clips[3]).toMatchObject({ file: data.full.file, event: 4, start: 2, end: 5, levels: data.full.levels })
    // No time moved: the edited recording as it is.
    expect(retimed(data, data, lib)).toBe(data)
  })
  it('snaps a time to the nearest frame within the video', () => {
    expect(snapTime(1.01, 30, 5)).toBe(1)
    expect(snapTime(1.02, 30, 5)).toBe(1.0333)
    expect(snapTime(-1, 30, 5)).toBe(0)
    expect(snapTime(9, 30, 5)).toBe(5)
  })
})

describe('changing the entry of one firing', () => {
  const button = ev(3, 'button', 'right')
  it('adds, replaces, takes a field back and removes the entry', () => {
    let e = setEditFor({ schema_version: 1, firings: [] }, button, { gain: 0.123456 })
    expect(e.firings).toEqual([{ of: { name: 'button', t: 3, hand: 'right' }, gain: 0.1235 }])
    e = setEditFor(e, button, { t: 3.5 })
    expect(e.firings).toEqual([{ of: { name: 'button', t: 3, hand: 'right' }, gain: 0.1235, t: 3.5 }])
    e = setEditFor(e, button, { gain: null })
    expect(e.firings).toEqual([{ of: { name: 'button', t: 3, hand: 'right' }, t: 3.5 }])
    e = setEditFor(e, button, { t: null })
    expect(e.firings).toEqual([])
  })
  it('replaces the matched entry (its `of` written as recorded), others stay where they are', () => {
    const firings: FiringEdit[] = [{ of: { name: 'tap', t: 1 }, gain: 2 }, { of: { name: 'button', t: 3.01, hand: 'right' }, gain: 0.5 }]
    const e = setEditFor({ schema_version: 1, firings }, button, { gain: 0.7 }, 1)
    expect(e.firings).toEqual([firings[0], { of: { name: 'button', t: 3, hand: 'right' }, gain: 0.7 }])
  })
})
