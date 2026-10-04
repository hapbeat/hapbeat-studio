import { describe, expect, it } from 'vitest'
import { buildItems, clipEnd, familyColor, focusEvent, itemEvents, levelAt, momentCues, offsetOf, parseViewerData, parseViewerLib } from './sceneData'
import { sampleData, sampleLib } from './sceneTestFixtures'

describe('scene data files', () => {
  it('parses viewer-lib.json and defaults a missing layer rate to null', () => {
    const raw = { ...sampleLib(), layers: [{ cue: 'feed_loop', gain: [0, 1], colors: ['#fff', '#000'] }] }
    const lib = parseViewerLib(JSON.stringify(raw))
    expect(lib.layers[0].rate).toBeNull()
    expect(lib.paths.cues).toBe('Content/Hapbeat/cues.json')
  })

  it('names the field a broken lib or recording lacks', () => {
    expect(() => parseViewerLib('{')).toThrow(/viewer-lib.json/)
    expect(() => parseViewerLib(JSON.stringify({ ...sampleLib(), paths: { cues: 'a' } }))).toThrow(/paths/)
    expect(() => parseViewerLib(JSON.stringify({ ...sampleLib(), clip_name: '(' }))).toThrow(/clip_name/)
    expect(() => parseViewerLib(JSON.stringify({ ...sampleLib(), loop_at: 'hand' }))).toThrow(/loop_at/)
    expect(parseViewerLib(JSON.stringify({ ...sampleLib(), loop_at: ['hand'] })).loop_at).toEqual(['hand'])
    expect(() => parseViewerData(JSON.stringify({ ...sampleData(), fps: 0 }))).toThrow(/fps/)
    const data = sampleData()
    expect(() => parseViewerData(JSON.stringify({ ...data, clips: [{ ...data.clips[0], levels: 'x' }] }))).toThrow(/clips/)
  })

  it('lists the full replay first, then every clip', () => {
    const items = buildItems(parseViewerData(JSON.stringify(sampleData())))
    expect(items.map(i => i.kind)).toEqual(['full', 'clip'])
    expect(items[0].file).toBe('full_replay.mp4')
    expect(offsetOf(items[1])).toBeCloseTo(1.0)
    expect(clipEnd(items[1], 30)).toBe(5)
    expect(clipEnd(items[0], 30)).toBe(Infinity)
  })
})

describe('scene cue timing', () => {
  const data = sampleData(), items = buildItems(data), clip = items[1], all = data.full.events

  it('shifts events into a clip video time and marks its own moment', () => {
    const ev = itemEvents(clip, all, 30)
    expect(ev.map(e => [e.name, +e.t.toFixed(2), e.own])).toEqual([
      ['detent', 0, false], ['button', 2, true], ['grab', 2.1, true], ['detent', 2.15, false], ['feed_loop', 3.5, false],
    ])
  })

  it('groups the cues of one moment and skips ticks', () => {
    const ev = itemEvents(clip, all, 30)
    expect(momentCues(ev, 2.0, ['detent'])).toEqual(['button', 'grab'])
    expect(momentCues(ev, null, [])).toEqual([])
  })

  it('focuses a clip on its own cue and the replay on the last non-tick cue', () => {
    expect(focusEvent(clip, itemEvents(clip, all, 30), 0, ['detent'])?.name).toBe('button')
    expect(focusEvent(items[0], itemEvents(items[0], all, 30), 3.2, ['detent'])?.name).toBe('grab')
  })

  it('interpolates layer levels and follows the louder hand for fixed routes', () => {
    const layer = sampleLib().layers[0]
    const levels = [[0, 1, 1, 2], [1, 0, 3, 4]]
    expect(levelAt(levels, 10, layer, 0.05, 0)).toEqual([0.5, 2])
    expect(levelAt(levels, 10, layer, 0.0, -1)).toEqual([1, 2])
    expect(levelAt(levels, 10, layer, 5, 0)).toEqual([0, 1])
    expect(familyColor(sampleLib(), 'grab')).toBe('#4ea1ff')
    expect(familyColor(sampleLib(), 'nope')).toBe('#888888')
  })
})
