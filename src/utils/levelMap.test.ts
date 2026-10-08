import { describe, expect, it } from 'vitest'
import { isLevelMap, mapLevel, withLevelCurve, withLevelPoint, withoutLevelPoint, type LevelMap } from './levelMap'
import { validateCueTable, type CueTable, type CueTableContext } from './sceneCueTable'
import { addMaterial, setLevelMap, setStarred, updateOwnRoute } from './cueEvents'
import { buildLoopVoices, CHUNK, renderChunk } from './sceneHaptics'
import { renderContextLoops } from './trialContext'
import { loopCueRuns, loopMaterialLevelMap, renderLoopStretch } from './loopStretch'
import { sampleLib, sampleTable } from './sceneTestFixtures'
import type { SceneData } from './sceneData'

const MAP: LevelMap = { points: [[0.2, 0.5], [0.6, 1.5], [1, 1]] }
const FEED = { cue: 'feed_loop', variant: null }

describe('levelMap (DEC-090): recorded level → multiplier', () => {
  it('is the level itself without a map, and 0 at level 0 (or below)', () => {
    expect(mapLevel(undefined, 0.7)).toBe(0.7)
    expect(mapLevel(undefined, 0)).toBe(0)
    expect(mapLevel(MAP, 0)).toBe(0)
    expect(mapLevel(MAP, -1)).toBe(0)
  })

  it('takes the end values beyond the points', () => {
    expect(mapLevel(MAP, 0.05)).toBe(0.5) // below the first point (but above 0): its value
    expect(mapLevel(MAP, 0.2)).toBe(0.5)
    expect(mapLevel(MAP, 1)).toBe(1)
    expect(mapLevel(MAP, 3)).toBe(1)
  })

  it('interpolates linearly between points', () => {
    expect(mapLevel(MAP, 0.4)).toBeCloseTo(1)
    expect(mapLevel(MAP, 0.3)).toBeCloseTo(0.75)
    expect(mapLevel(MAP, 0.8)).toBeCloseTo(1.25)
  })

  it('smooth: smoothstep between two points (same at the points and the midpoint, eased near them)', () => {
    const smooth = { ...MAP, curve: 'smooth' as const }
    expect(mapLevel(smooth, 0.4)).toBeCloseTo(1) // f = 0.5 → 0.5
    expect(mapLevel(smooth, 0.6)).toBeCloseTo(1.5)
    // f = 0.25 → 0.25² × (3 − 0.5) = 0.15625
    expect(mapLevel(smooth, 0.3)).toBeCloseTo(0.5 + 1 * 0.15625)
    expect(mapLevel(smooth, 0.3)).toBeLessThan(mapLevel(MAP, 0.3))
  })

  it('accepts 1–16 points with increasing levels ≥ 0, gains 0..4, curve linear / smooth', () => {
    expect(isLevelMap(MAP)).toBe(true)
    expect(isLevelMap({ points: [[0, 0]], curve: 'smooth' })).toBe(true)
    expect(isLevelMap({ points: [] })).toBe(false)
    expect(isLevelMap({ points: Array.from({ length: 17 }, (_, i) => [i, 1]) })).toBe(false)
    expect(isLevelMap({ points: [[0.5, 1], [0.2, 1]] })).toBe(false) // not sorted
    expect(isLevelMap({ points: [[0.5, 1], [0.5, 2]] })).toBe(false) // a level twice
    expect(isLevelMap({ points: [[-0.1, 1]] })).toBe(false)
    expect(isLevelMap({ points: [[0.1, 4.5]] })).toBe(false)
    expect(isLevelMap({ points: [[0.1, 1]], curve: 'cubic' })).toBe(false)
    expect(isLevelMap({ points: [[0.1, 1]], extra: 1 })).toBe(false)
  })

  it('edits: a point added in order or replaced at the same level, removed (none left = no map), the curve', () => {
    const one = withLevelPoint(undefined, 0.5, 1.2)
    expect(one).toEqual({ points: [[0.5, 1.2]] })
    const two = withLevelPoint(one, 0.25, 9)
    expect(two.points).toEqual([[0.25, 4], [0.5, 1.2]]) // gain clamped to 4
    expect(withLevelPoint(two, 0.5, 0.3).points).toEqual([[0.25, 4], [0.5, 0.3]])
    expect(withoutLevelPoint(two, 0)).toEqual({ points: [[0.5, 1.2]] })
    expect(withoutLevelPoint(one, 0)).toBeUndefined()
    expect(withLevelCurve(two, 'smooth').curve).toBe('smooth')
    expect('curve' in withLevelCurve({ ...two, curve: 'smooth' }, 'linear')).toBe(false)
    const full: LevelMap = { points: Array.from({ length: 16 }, (_, i) => [i, 1]) }
    expect(() => withLevelPoint(full, 20, 1)).toThrow()
    expect(withLevelPoint(full, 3, 2).points[3]).toEqual([3, 2])
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
    expect(out[0]).toBe(Math.round(0.5 * 2 * 0.8 * 32767)) // level 0.25 → ×2 (the end value), route gain 0.8
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
    expect(renderLoopStretch([new Float32Array(4).fill(0.5)], 10, { ...stretch, levelMap: { points: [[1, 3]] } }, 1)[0][3]).toBeCloseTo(1.5)
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
