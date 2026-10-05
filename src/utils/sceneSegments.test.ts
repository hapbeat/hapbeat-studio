import { describe, expect, it } from 'vitest'
import { isRepeating, occurrences, sceneSegment, toFirstPlay } from './sceneSegments'
import type { SceneEvent } from './sceneData'

/** The footstep firings of the T-Rex encounter recording (viewer-data.json full.events, 2026-10-05). */
const T_REX: SceneEvent[] = [
  ...[1.267, 2.133, 2.967, 3.833, 4.7].map(t => ({ t, name: 'footstep:approach', hand: 'both' })),
  ...[17.367, 19.067, 22.533, 30.567, 48.4, 53.767, 54.6, 55.467, 56.333, 57.2, 58.033, 58.9, 59.767, 60.6, 61.467, 62.333, 63.2, 64.033, 64.9, 65.767, 66.6, 67.467, 68.333, 69.233]
    .map(t => ({ t, name: 'footstep', hand: 'both' })),
  { t: 7.9, name: 'roar', hand: 'both' },
]
/** The other cues of the same recording. */
const T_REX_ALL: SceneEvent[] = [
  ...T_REX,
  ...Object.entries({
    keeper_cue: [11.433, 12.933], grab: [16.6], hold: [16.633], bone_taken: [26.8], rub: [31.633],
    breath: [12.733, 17.767, 22.767, 27.767, 31.933, 36.967, 41.967, 46.967],
    bite: [21.367, 23.4, 25.4], 'bite:tear': [21.967, 24.0, 26.0],
    'breath:stroke': [31.9, 33.833, 36.033, 37.933, 40.0, 42.067, 43.967, 46.167],
  }).flatMap(([name, times]) => times.map(t => ({ t, name, hand: 'both' }))),
]

describe('representative scene (DEC-085)', () => {
  const marksOf = (seg: ReturnType<typeof sceneSegment>) => seg!.marks.map(m => `${m.target ? 'R' : 'G'} ${m.name} ${m.t}`)

  it('bite: the meal from 1.5 s before the first bite, 3 bite marks (red) and 3 bite:tear marks (grey)', () => {
    const seg = sceneSegment(T_REX_ALL, ['bite'], 0.8)!
    expect(seg.repeating).toBe(true)
    expect(seg.start).toBeCloseTo(21.367 - 1.5)
    expect(seg.end).toBeCloseTo(26.0 + 0.8 + 1)
    expect(marksOf(seg)).toEqual(['R bite 21.367', 'G bite:tear 21.967', 'R bite 23.4', 'G bite:tear 24', 'R bite 25.4', 'G bite:tear 26'])
  })

  it('footstep:approach: 5 marks; footstep: the exit walk, cut after its 6th step; a trial naming both cues', () => {
    const approach = sceneSegment(T_REX_ALL, ['footstep:approach'], 0.3)!
    expect(approach.marks.filter(m => m.target).map(m => m.t)).toEqual([1.267, 2.133, 2.967, 3.833, 4.7])
    expect(approach.marks.every(m => m.target)).toBe(true)
    expect(approach.start).toBe(0) // 1.5 s before 1.267 s, clamped to the recording's start
    const exit = sceneSegment(T_REX_ALL, ['footstep'], 0.3)!
    expect(exit.marks.map(m => m.t)).toEqual([53.767, 54.6, 55.467, 56.333, 57.2, 58.033])
    expect(exit.total).toBe(24)
    // T19 (scene.cues footstep + footstep:approach): both are targets; the first chain with 3 of them is the approach.
    expect(sceneSegment(T_REX_ALL, ['footstep', 'footstep:approach'], 0.3)!.marks.length).toBe(5)
  })

  it('a one-off cue: one mark, from 1 s before to the sound + 0.5 s; a cue that never fires: none', () => {
    expect(sceneSegment(T_REX_ALL, ['roar'], 3)).toEqual({ names: ['roar'], start: 6.9, end: 11.4, marks: [{ t: 7.9, name: 'roar', target: true }], repeating: false, total: 1 })
    expect(sceneSegment(T_REX_ALL, ['breath'], 1)!.marks).toHaveLength(1) // every 5 s: not repeating
    expect(sceneSegment(T_REX_ALL, ['growl'], 1)).toBeNull()
    for (const name of ['footstep:approach', 'footstep', 'bite', 'bite:tear', 'breath:stroke']) expect(isRepeating(T_REX_ALL, [name]), name).toBe(true)
    for (const name of ['roar', 'breath', 'keeper_cue', 'grab', 'bone_taken', 'growl']) expect(isRepeating(T_REX_ALL, [name]), name).toBe(false)
    expect(occurrences(T_REX_ALL, 'footstep')).toHaveLength(24)
  })

  it('a selection on a scene audition maps to seconds of one play', () => {
    expect(toFirstPlay({ start: 1.0, end: 1.2 }, [0, 0.9, 1.8], 0.5)).toEqual({ start: expect.closeTo(0.1), end: expect.closeTo(0.3) })
    expect(toFirstPlay({ start: 0.6, end: 0.8 }, [0, 0.9], 0.5)).toBeNull()
    expect(toFirstPlay({ start: 0.1, end: 0.3 }, null, 0.5)).toEqual({ start: 0.1, end: 0.3 })
  })
})
