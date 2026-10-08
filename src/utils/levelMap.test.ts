import { describe, expect, it } from 'vitest'
import { isLevelMap, LEVEL_MAP_CURVES, mapLevel, withLevelCurve, withLevelIntercept, withLevelPoint, withoutLevelPoint, withPointEdited, type LevelMap, type LevelMapCurve } from './levelMap'
import { curveAt } from './rampCurve'
import { validateCueTable, type CueTable, type CueTableContext } from './sceneCueTable'
import { addMaterial, setLevelMap, setStarred, updateOwnRoute } from './cueEvents'
import { buildLoopVoices, CHUNK, renderChunk } from './sceneHaptics'
import { renderContextLoops } from './trialContext'
import { loopCueRuns, loopMaterialLevelMap, renderLoopStretch } from './loopStretch'
import { sampleLib, sampleTable } from './sceneTestFixtures'
import type { SceneData } from './sceneData'

const MAP: LevelMap = { points: [[0.2, 0.5], [0.6, 1.5], [1, 1]] }
const FEED = { cue: 'feed_loop', variant: null }

describe('levelMap (DEC-090 revised): input → output through (0, intercept) and the points', () => {
  it('is the input itself without a map, and 0 at input 0 (or below)', () => {
    expect(mapLevel(undefined, 0.7)).toBe(0.7)
    expect(mapLevel(undefined, 0)).toBe(0)
    expect(mapLevel(MAP, 0)).toBe(0)
    expect(mapLevel(MAP, -1)).toBe(0)
    expect(mapLevel({ points: [[1, 2]], intercept: 1 }, 0)).toBe(0) // the loop is off: 0 even with an intercept
  })

  it('one point: a line through the origin (proportional), extended past the point', () => {
    const one: LevelMap = { points: [[1.225, 0.5]] }
    expect(mapLevel(one, 0.08)).toBeCloseTo(0.5 * 0.08 / 1.225) // ≈ 0.0327
    expect(mapLevel(one, 0.08)).toBeCloseTo(0.0327, 4)
    expect(mapLevel(one, 1.225)).toBe(0.5)
    expect(mapLevel(one, 2.45)).toBeCloseTo(1)
  })

  it('two points: piecewise linear from the origin through both', () => {
    const two: LevelMap = { points: [[0.08, 0.08], [1.225, 0.5]] }
    expect(mapLevel(two, 0.04)).toBeCloseTo(0.04) // (0, 0) → (0.08, 0.08)
    expect(mapLevel(two, 0.08)).toBeCloseTo(0.08)
    expect(mapLevel(two, (0.08 + 1.225) / 2)).toBeCloseTo((0.08 + 0.5) / 2)
    expect(mapLevel(two, 1.225)).toBeCloseTo(0.5)
    // Past the last point: the last segment slope.
    expect(mapLevel(two, 2)).toBeCloseTo(0.5 + (0.5 - 0.08) / (1.225 - 0.08) * (2 - 1.225))
  })

  it('intercept: the first segment starts at (0, intercept)', () => {
    const m: LevelMap = { points: [[1, 2]], intercept: 1 }
    expect(mapLevel(m, 1e-6)).toBeCloseTo(1)
    expect(mapLevel(m, 0.5)).toBeCloseTo(1.5)
    expect(mapLevel(m, 2)).toBeCloseTo(3) // one point: the secant from (0, intercept)
    expect(mapLevel({ points: [[1, 0]], intercept: 2 }, 0.5)).toBeCloseTo(1) // falling is fine
  })

  it('each curve shapes every segment (mid-segment values)', () => {
    const at = (curve: LevelMapCurve, x: number) => mapLevel({ ...MAP, curve }, x)
    // Segment (0.2, 0.5) → (0.6, 1.5): t = 0.5 at 0.4, t = 0.25 at 0.3.
    expect(at('linear', 0.3)).toBeCloseTo(0.5 + 1 * 0.25)
    expect(at('easeIn', 0.4)).toBeCloseTo(0.5 + 1 * 0.25)
    expect(at('easeOut', 0.4)).toBeCloseTo(0.5 + 1 * 0.75)
    expect(at('easeInOut', 0.4)).toBeCloseTo(1)
    expect(at('easeInOut', 0.3)).toBeCloseTo(0.5 + 0.15625)
    expect(at('sigmoid', 0.4)).toBeCloseTo(1)
    expect(at('sigmoid', 0.3)).toBeCloseTo(0.5 + curveAt('sigmoid', 0.25))
    expect(at('sigmoid', 0.3)).toBeLessThan(at('easeInOut', 0.3))
    // The first segment from the origin too: (0, 0) → (0.2, 0.5) at t = 0.5.
    expect(at('easeIn', 0.1)).toBeCloseTo(0.5 * 0.25)
    // The points themselves for every shape.
    for (const c of LEVEL_MAP_CURVES) { expect(at(c, 0.6)).toBeCloseTo(1.5); expect(at(c, 1)).toBeCloseTo(1) }
  })

  it('extends past the last point with the last secant, the output kept in 0..4', () => {
    // Last segment (0.6, 1.5) → (1, 1): slope −1.25.
    expect(mapLevel(MAP, 1.4)).toBeCloseTo(0.5)
    expect(mapLevel(MAP, 3)).toBe(0) // −1 clamped to 0
    expect(mapLevel({ points: [[0.5, 3]] }, 1.225)).toBe(4) // 7.35 clamped to 4
    // The secant, not the shaped curve's end slope.
    expect(mapLevel({ ...MAP, curve: 'easeIn' }, 1.4)).toBeCloseTo(0.5)
  })

  it('accepts 1–16 points with increasing inputs > 0, outputs 0..4, intercept 0..4, the 5 curves; nothing else', () => {
    expect(isLevelMap(MAP)).toBe(true)
    expect(isLevelMap({ points: [[0.1, 0]], intercept: 4, curve: 'sigmoid' })).toBe(true)
    for (const c of LEVEL_MAP_CURVES) expect(isLevelMap({ points: [[1, 1]], curve: c })).toBe(true)
    expect(isLevelMap({ points: [] })).toBe(false)
    expect(isLevelMap({ points: Array.from({ length: 17 }, (_, i) => [i + 1, 1]) })).toBe(false)
    expect(isLevelMap({ points: [[0.5, 1], [0.2, 1]] })).toBe(false) // not sorted
    expect(isLevelMap({ points: [[0.5, 1], [0.5, 2]] })).toBe(false) // an input twice
    expect(isLevelMap({ points: [[0, 0]] })).toBe(false) // input 0 is not a point (the intercept is)
    expect(isLevelMap({ points: [[-0.1, 1]] })).toBe(false)
    expect(isLevelMap({ points: [[0.1, 4.5]] })).toBe(false)
    expect(isLevelMap({ points: [[0.1, -0.1]] })).toBe(false)
    expect(isLevelMap({ points: [[0.1, 1]], intercept: 4.5 })).toBe(false)
    expect(isLevelMap({ points: [[0.1, 1]], intercept: -1 })).toBe(false)
    expect(isLevelMap({ points: [[0.1, 1]], curve: 'smooth' })).toBe(false) // removed
    expect(isLevelMap({ points: [[0.1, 1]], curve: 'cubic' })).toBe(false)
    expect(isLevelMap({ points: [[0.1, 1]], extra: 1 })).toBe(false)
  })

  it('edits: a point added in order or replaced at the same input, removed (none left = no map), the curve, the intercept', () => {
    const one = withLevelPoint(undefined, 0.5, 1.2)
    expect(one).toEqual({ points: [[0.5, 1.2]] })
    const two = withLevelPoint(one, 0.25, 9)
    expect(two.points).toEqual([[0.25, 4], [0.5, 1.2]]) // output clamped to 4
    expect(withLevelPoint(two, 0.5, 0.3).points).toEqual([[0.25, 4], [0.5, 0.3]])
    expect(() => withLevelPoint(two, 0.0004, 1)).toThrow() // rounds to input 0
    expect(withoutLevelPoint(two, 0)).toEqual({ points: [[0.5, 1.2]] })
    expect(withoutLevelPoint(one, 0)).toBeUndefined()
    expect(withLevelCurve(two, 'easeInOut').curve).toBe('easeInOut')
    expect('curve' in withLevelCurve({ ...two, curve: 'sigmoid' }, 'linear')).toBe(false)
    expect(withLevelIntercept(two, 0.25).intercept).toBe(0.25)
    expect(withLevelIntercept(two, 9).intercept).toBe(4)
    expect('intercept' in withLevelIntercept({ ...two, intercept: 1 }, 0)).toBe(false)
    const full: LevelMap = { points: Array.from({ length: 16 }, (_, i) => [i + 1, 1]) }
    expect(() => withLevelPoint(full, 20, 1)).toThrow()
    expect(withLevelPoint(full, 3, 2).points[2]).toEqual([3, 2])
  })
})

describe('levelMap in the cue table', () => {
  const ctx = (): CueTableContext => ({
    lib: sampleLib(), kit: 'mill-kit', cueNames: ['button', 'grab', 'detent', 'feed_loop'], clipFiles: new Set(['click', 'thump', 'hum']), soundFiles: new Set(['Click']),
  })

  it('validates it on a loop cue route, refuses it on a pulse cue or out of shape', () => {
    const ok = setLevelMap(sampleTable(), 'feed_loop', 0, MAP)
    expect(ok.cues.feed_loop.haptics![0].levelMap).toEqual(MAP)
    expect(validateCueTable(ok, ctx())).toEqual([])
    const bad = setLevelMap(sampleTable(), 'feed_loop', 0, { points: [[0.5, 1], [0.2, 1]] })
    expect(validateCueTable(bad, ctx())).toEqual([expect.stringMatching(/^feed_loop: route levelMap must be \{points:/)])
    const zero = setLevelMap(sampleTable(), 'feed_loop', 0, { points: [[0, 1]] })
    expect(validateCueTable(zero, ctx())).toEqual([expect.stringMatching(/^feed_loop: route levelMap must be \{points: \[\[input > 0/)])
    const smooth = setLevelMap(sampleTable(), 'feed_loop', 0, { points: [[1, 1]], curve: 'smooth' } as unknown as LevelMap)
    expect(validateCueTable(smooth, ctx())).toEqual(['feed_loop: route levelMap curve "smooth" was removed (DEC-090 revision): use easeInOut'])
    const withIntercept = setLevelMap(sampleTable(), 'feed_loop', 0, { points: [[1, 1]], intercept: 0.2, curve: 'easeOut' })
    expect(validateCueTable(withIntercept, ctx())).toEqual([])
    const pulse = structuredClone(sampleTable())
    pulse.cues.detent.haptics![0].levelMap = MAP
    expect(validateCueTable(pulse, ctx())).toEqual(['detent: route levelMap is for loop cues'])
  })

  it('is kept through other edits and removed with undefined', () => {
    const table = structuredClone(setLevelMap(sampleTable(), 'feed_loop', 0, MAP))
    table.clips.hum2 = { intensity: 1, loop: true }
    let next: CueTable = addMaterial(table, FEED, 'haptic', 0, 'hum2')!
    next = setStarred(next, FEED, 'haptic', 0, 'hum2', true)!
    next = updateOwnRoute(next, FEED, 0, { gain: 0.4 })
    expect(next.cues.feed_loop.haptics![0]).toMatchObject({ clips: ['hum', 'hum2'], gain: 0.4, levelMap: MAP })
    expect('levelMap' in setLevelMap(next, 'feed_loop', 0, undefined).cues.feed_loop.haptics![0]).toBe(false)
  })

  it('picks the levelMap a loop material plays with: the sfx for a sound, the route keeping the clip, else the first', () => {
    const table = structuredClone(sampleTable())
    table.cues.feed_loop.sfx = { sound: 'Motor', volume: 1, levelMap: { points: [[1, 2]] } }
    table.cues.feed_loop.haptics = [{ clip: 'hum', at: 'hand', gain: 1, levelMap: MAP }, { clip: 'hum', alternates: ['hum2'], at: 'pos_neck', gain: 1, levelMap: { points: [[1, 3]] } }]
    expect(loopMaterialLevelMap(table, 'feed_loop', 'sound', 'Motor')).toEqual({ points: [[1, 2]] })
    expect(loopMaterialLevelMap(table, 'feed_loop', 'haptic', 'hum2')).toEqual({ points: [[1, 3]] })
    expect(loopMaterialLevelMap(table, 'feed_loop', 'haptic', null)).toEqual(MAP)
  })
})

describe('levelMap in loop playback', () => {
  const pcm = { hum: new Float32Array(CHUNK).fill(0.5) }

  it('Scene tab haptics: the loop voice gain follows levelMap(level), not the level', () => {
    const table = setLevelMap(sampleTable(), 'feed_loop', 0, { points: [[0.5, 2]] })
    const loopVoices = buildLoopVoices(table, sampleLib())
    const out = renderChunk({ ip: 'a', address: 'p1/pos_r_wrist', wall: 0, voices: [], loopVoices, clock: { t: 0, rate: 1, wall: 0 }, pcm, level: () => [0.25, 1] })
    expect(out[0]).toBe(Math.round(0.5 * 1 * 0.8 * 32767)) // input 0.25 → ×1 (half of (0.5, 2) from the origin), route gain 0.8
    const silent = renderChunk({ ip: 'b', address: 'p1/pos_r_wrist', wall: 0, voices: [], loopVoices, clock: { t: 0, rate: 1, wall: 0 }, pcm, level: () => [0, 1] })
    expect(silent.every(s => s === 0)).toBe(true) // level 0 → 0
  })

  it('editor context loops: rendered through the route levelMap', () => {
    const lib = sampleLib(), data = { fps: 30, full: { file: 'f.mp4', events: [], levels: Array.from({ length: 60 }, () => [0.5, 0, 1, 1]) } } as unknown as SceneData
    const plain = renderContextLoops(sampleTable(), lib, data, { layers: [0], mark: 0 }, pcm, 0.5)!
    expect(plain[100]).toBeCloseTo(0.5 * 0.5) // intensity 1 × level 0.5
    const mapped = renderContextLoops(setLevelMap(sampleTable(), 'feed_loop', 0, { points: [[0.5, 1.5]] }), lib, data, { layers: [0], mark: 0 }, pcm, 0.5)!
    expect(mapped[100]).toBeCloseTo(0.5 * 1.5)
  })

  it('editor loop view: renderLoopStretch applies the stretch levelMap', () => {
    const stretch = { segments: [{ start: 0, end: 1 }], level: () => ({ gain: 0.5, rate: 1 }) }
    expect(renderLoopStretch([new Float32Array(4).fill(0.5)], 10, stretch, 1)[0][3]).toBeCloseTo(0.25)
    expect(renderLoopStretch([new Float32Array(4).fill(0.5)], 10, { ...stretch, levelMap: { points: [[1, 3]] } }, 1)[0][3]).toBeCloseTo(0.75) // input 0.5 → 1.5
  })
})

describe('loop cue spans on the Scene timeline', () => {
  it('are the layer runs where the louder hand level is above 0 (cue or cue:variant); none for other cues', () => {
    const levels = [[0, 0], [0.3, 0], [0, 0.2], [0, 0], [0, 0], [0.5, 0.5], [0.1, 0]].map(r => [...r, 1, 1])
    expect(loopCueRuns(levels, 10, sampleLib(), 'feed_loop')).toEqual([[0.1, 0.3], [0.5, 0.7]])
    expect(loopCueRuns(levels, 10, sampleLib(), 'feed_loop:slow')).toEqual([[0.1, 0.3], [0.5, 0.7]])
    expect(loopCueRuns(levels, 10, sampleLib(), 'button')).toEqual([])
  })
})

describe('levelMap point edited in place (Scene point cards)', () => {
  const map: LevelMap = { points: [[0.08, 0.08], [1.225, 0.3]], curve: 'easeIn' }
  it('changes input / output, re-sorts by input and keeps the rest', () => {
    expect(withPointEdited(map, 1, 1.225, 0.5)).toEqual({ points: [[0.08, 0.08], [1.225, 0.5]], curve: 'easeIn' })
    expect(withPointEdited(map, 1, 0.04, 9)).toEqual({ points: [[0.04, 4], [0.08, 0.08]], curve: 'easeIn' })
    expect(withPointEdited(map, 0, 0.08, 0.1234)).toEqual({ points: [[0.08, 0.123], [1.225, 0.3]], curve: 'easeIn' })
  })
  it('rejects an input of 0 or less and an input another point has', () => {
    expect(withPointEdited(map, 0, 0, 0.1)).toBe('input')
    expect(withPointEdited(map, 0, -1, 0.1)).toBe('input')
    expect(withPointEdited(map, 0, 1.2251, 0.1)).toBe('duplicate')
  })
})
