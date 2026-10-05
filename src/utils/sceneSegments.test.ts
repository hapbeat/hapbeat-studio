import { describe, expect, it } from 'vitest'
import { findRuns, listenOffsets, occurrences, representativeSegment } from './sceneSegments'
import { representativeOption } from './trialScene'
import { sampleData } from './sceneTestFixtures'
import type { SceneEvent } from './sceneData'

/** The footstep firings of the T-Rex encounter recording (viewer-data.json full.events, 2026-10-05). */
const T_REX: SceneEvent[] = [
  ...[1.267, 2.133, 2.967, 3.833, 4.7].map(t => ({ t, name: 'footstep:approach', hand: 'both' })),
  ...[17.367, 19.067, 22.533, 30.567, 48.4, 53.767, 54.6, 55.467, 56.333, 57.2, 58.033, 58.9, 59.767, 60.6, 61.467, 62.333, 63.2, 64.033, 64.9, 65.767, 66.6, 67.467, 68.333, 69.233]
    .map(t => ({ t, name: 'footstep', hand: 'both' })),
  { t: 7.9, name: 'roar', hand: 'both' },
]

describe('representative segment (DEC-085)', () => {
  it('footstep:approach: the run is the 5 approach steps; the editor shows only its first step (one mark, one window)', () => {
    const seg = representativeSegment(T_REX, 'footstep:approach', 0.6)!
    expect(seg.run).toBe(true)
    expect(seg.marks).toEqual([1.267, 2.133, 2.967, 3.833, 4.7])
    expect(seg.start).toBeCloseTo(0.267)
    expect(seg.end).toBeCloseTo(4.7 + 0.6 + 0.5)
    const data = { ...sampleData(), full: { ...sampleData().full, events: T_REX } }
    const option = representativeOption(data, ['footstep:approach'], () => 0.6)!
    expect(option.marks).toEqual([1.267])
    expect(option.end).toBeCloseTo(1.267 + 0.6 + 0.5)
    expect(option.segment?.marks).toHaveLength(5) // kept for ×5
  })

  it('footstep: the exit walk (53.77 s, first run of ≥ 3), not a lone footstep while feeding; at most 6 marks', () => {
    const seg = representativeSegment(T_REX, 'footstep', 0.6)!
    expect(seg.run).toBe(true)
    expect(seg.marks[0]).toBeCloseTo(53.767)
    expect(seg.marks).toHaveLength(6)
    expect(seg.total).toBe(24)
    expect(occurrences(T_REX, 'footstep')).toHaveLength(24)
  })

  it('a one-off event: 1 s before to the sound length + 0.5 s after; absent events have none', () => {
    expect(representativeSegment(T_REX, 'roar', 3)).toEqual({ name: 'roar', start: 6.9, end: 11.4, marks: [7.9], run: false, total: 1 })
    expect(representativeSegment(T_REX, 'bite', 1)).toBeNull()
    expect(findRuns([0, 1, 5, 6, 7, 20])).toEqual([[5, 6, 7]])
    expect(findRuns([0, 1])).toEqual([])
  })

  it('×5: the real gaps of the cue run (first five firings), else 0.9 s apart, no jitter', () => {
    expect(listenOffsets(T_REX, 'footstep:approach').map(x => +x.toFixed(3))).toEqual([0, 0.866, 1.7, 2.566, 3.433])
    expect(listenOffsets(T_REX, 'footstep').map(x => +x.toFixed(3))).toEqual([0, 0.833, 1.7, 2.566, 3.433])
    expect(listenOffsets(T_REX, 'roar').map(x => +x.toFixed(2))).toEqual([0, 0.9, 1.8, 2.7, 3.6]) // one-off
    expect(listenOffsets(null, 'bite').map(x => +x.toFixed(2))).toEqual([0, 0.9, 1.8, 2.7, 3.6]) // no recording
    expect(listenOffsets([0, 1, 2].map(t => ({ t, name: 'x', hand: 'both' })), 'x')).toEqual([0, 1, 2, 3, 4]) // a 3-firing run continues at its gap
  })
})
