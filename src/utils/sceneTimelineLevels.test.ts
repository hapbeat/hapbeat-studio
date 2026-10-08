import { describe, expect, it } from 'vitest'
import { laneY, layerLanes, layerScaleMax, outputCurves, outputScaleMax, outputValues } from './sceneTimelineLevels'
import { loopCueRunAt, loopCueRuns } from './loopStretch'
import { mapLevel, withOutputAt, LEVEL_MAP_MAX_POINTS, type LevelMap } from './levelMap'
import { sampleLib, sampleTable } from './sceneTestFixtures'
import type { CueTable } from './sceneCueTable'

const FPS = 10
/** feed_loop (columns 0 / 1 = L / R) active 4.4–15.4 s and 38.5–43.8 s, level 1.225 on the right hand; 50 s. */
function feedLevels(): number[][] {
  return Array.from({ length: 500 }, (_, i) => {
    const t = i / FPS, on = (t >= 4.4 && t < 15.4) || (t >= 38.5 && t < 43.8)
    return [on ? 0.5 : 0, on ? 1.225 : 0, 1, 1]
  })
}
/** Safety Mill shape: feed_loop haptics only, cut_loop a sound only. */
function millTable(map?: LevelMap): CueTable {
  const tb = sampleTable()
  tb.cues.feed_loop = { sfx: null, haptics: [{ clip: 'hum', at: 'hand', gain: 0.8, ...(map ? { levelMap: map } : {}) }] }
  tb.cues.cut_loop = { sfx: { sound: 'Cut', volume: 1 }, haptics: [] }
  return tb
}

describe('A loop cue row plays its own span (the run its firing starts)', () => {
  const lib = sampleLib(), levels = feedLevels(), runs = loopCueRuns(levels, FPS, lib, 'feed_loop')
  const events = [{ t: 4.4, name: 'feed_loop' }, { t: 38.5, name: 'feed_loop' }, { t: 38.6, name: 'grab' }]
  it('the firing at 4.4 s plays 4.4–15.4, the one at 38.5 s plays 38.5–43.8', () => {
    expect(runs).toHaveLength(2)
    const [a, b] = [loopCueRunAt(runs, events, 'feed_loop', 4.4)!, loopCueRunAt(runs, events, 'feed_loop', 38.5)!]
    expect(a[0]).toBeCloseTo(4.4); expect(a[1]).toBeCloseTo(15.4)
    expect(b[0]).toBeCloseTo(38.5); expect(b[1]).toBeCloseTo(43.8)
  })
  it('a moment marked near the firing (its cue row) finds the same span; a firing just before its run starts too', () => {
    expect(loopCueRunAt(runs, events, 'feed_loop', 38.6)![0]).toBeCloseTo(38.5)
    expect(loopCueRunAt(runs, [{ t: 4.2, name: 'feed_loop' }], 'feed_loop', 4.2)![0]).toBeCloseTo(4.4)
    expect(loopCueRunAt(runs, [{ t: 30, name: 'feed_loop' }], 'feed_loop', 30)).toBeNull()
  })
})

describe('Output at the current input (levelMap, DEC-090)', () => {
  it('sets the point at the current level, so the output there is the value entered', () => {
    const m = withOutputAt(undefined, 1.225, 0.5)!
    expect(m.points).toEqual([[1.225, 0.5]])
    expect(mapLevel(m, 1.225)).toBe(0.5)
    // Again at the same level: replaced; at another level: added in order.
    const m2 = withOutputAt(withOutputAt(m, 1.225, 0.6)!, 0.5, 0.2)!
    expect(m2.points).toEqual([[0.5, 0.2], [1.225, 0.6]])
  })
  it('none at level 0, nor when the map is full without a point there', () => {
    expect(withOutputAt(undefined, 0, 0.5)).toBeNull()
    expect(withOutputAt(undefined, 0.0004, 0.5)).toBeNull() // rounds to 0
    const full: LevelMap = { points: Array.from({ length: LEVEL_MAP_MAX_POINTS }, (_, i) => [i * 0.1 + 0.1, 1] as [number, number]) }
    expect(withOutputAt(full, 5, 1)).toBeNull()
    expect(withOutputAt(full, 0.1, 0.3)!.points[0]).toEqual([0.1, 0.3])
  })
})

describe('Timeline level curves stay in their own lanes', () => {
  const lib = sampleLib(), levels = feedLevels(), layer = lib.layers[0]
  it('haptic loops in the haptics lane, sound loops in the sound lane', () => {
    const tb = millTable()
    expect(layerLanes(tb, 'feed_loop')).toEqual(['haptics'])
    expect(layerLanes(tb, 'cut_loop')).toEqual(['sound'])
    expect(layerLanes(tb, 'unknown')).toEqual(['haptics'])
  })
  it('scaled from 0 at the lane bottom to the recording max (at least 1) at its top, clamped to the lane', () => {
    expect(layerScaleMax(levels, layer)).toBeCloseTo(1.225)
    expect(layerScaleMax(levels.map(r => [r[0] * 0.5, r[1] * 0.5, 1, 1]), layer)).toBe(1)
    expect(laneY(0, 1.225, 60, 100)).toBe(100)
    expect(laneY(1.225, 1.225, 60, 100)).toBe(60)
    expect(laneY(5, 1.225, 60, 100)).toBe(60)
  })
  it('the selected loop cue: its output (levelMap applied) per hand of a hand route, on one scale with its level', () => {
    const tb = millTable({ points: [[1.225, 0.5]] }), curves = outputCurves(tb, 'feed_loop')
    expect(curves.map(c => [c.lane, c.side])).toEqual([['haptics', 0], ['haptics', 1]])
    const right = outputValues(levels, layer, curves[1])
    expect(right[50]).toBe(0.5) // 5 s: level 1.225 → output 0.5
    expect(right[200]).toBe(0) // 20 s: level 0 → 0
    expect(outputScaleMax(levels, layer, curves)).toBeCloseTo(1.225)
    // A larger output widens the scale; a sound's curve follows the louder hand in the sound lane.
    const loud = millTable({ points: [[0.5, 3]] })
    expect(outputScaleMax(levels, layer, outputCurves(loud, 'feed_loop'))).toBe(4) // 1.225 → 7.35 past the point, kept at 4
    const sound = outputCurves(millTable(), 'cut_loop')
    expect(sound).toEqual([{ lane: 'sound', side: -1, map: undefined }])
    expect(outputValues(levels, layer, sound[0])[50]).toBeCloseTo(1.225)
  })
})
