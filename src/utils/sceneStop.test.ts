import { describe, expect, it } from 'vitest'
import { sceneStopSec } from './sceneStop'

describe('sceneStopSec', () => {
  it('runs the post-roll past a short haptic and no sound', () => {
    expect(sceneStopSec({ firings: [0], postRollSec: 1, sounds: [], haptics: [{ atSec: 0, durSec: 0.16 }] })).toBe(1)
  })
  it('waits for a sound longer than the post-roll (reverb tail)', () => {
    expect(sceneStopSec({ firings: [0], postRollSec: 1, sounds: [{ atSec: 0, durSec: 2.4 }], haptics: [{ atSec: 0, durSec: 0.16 }] })).toBe(2.4)
  })
  it('waits for a haptic longer than the post-roll and the sound', () => {
    expect(sceneStopSec({ firings: [0], postRollSec: 0.5, sounds: [{ atSec: 0, durSec: 0.8 }], haptics: [{ atSec: 0, durSec: 1.2 }] })).toBe(1.2)
  })
  it('counts a sound at its playback rate', () => {
    expect(sceneStopSec({ firings: [0], postRollSec: 0, sounds: [{ atSec: 0, durSec: 2, rate: 0.5 }], haptics: [] })).toBe(4)
    expect(sceneStopSec({ firings: [0], postRollSec: 0, sounds: [{ atSec: 0, durSec: 2, rate: 2 }], haptics: [] })).toBe(1)
  })
  it('takes the last firing of a repeat / group', () => {
    expect(sceneStopSec({ firings: [0, 0.8, 1.6], postRollSec: 1, sounds: [{ atSec: 1.6, durSec: 0.3 }], haptics: [{ atSec: 1.6, durSec: 0.2 }] })).toBeCloseTo(2.6)
    expect(sceneStopSec({ firings: [0, 0.8, 1.6], postRollSec: 1, sounds: [{ atSec: 0.8, durSec: 3 }], haptics: [] })).toBeCloseTo(3.8)
  })
  it('with context, runs to the end of the representative stretch', () => {
    expect(sceneStopSec({ firings: [0], postRollSec: 0.5, sounds: [{ atSec: 0, durSec: 0.3 }], haptics: [], untilSec: 2.4 })).toBe(2.4)
    expect(sceneStopSec({ firings: [0], postRollSec: 0.5, sounds: [{ atSec: 0, durSec: 3 }], haptics: [], untilSec: 2.4 })).toBe(3)
  })
  it('a post-roll of 0 stops with the longest material', () => {
    expect(sceneStopSec({ firings: [0], postRollSec: 0, sounds: [{ atSec: 0, durSec: 0.3 }], haptics: [{ atSec: 0, durSec: 0.16 }] })).toBe(0.3)
  })
})
