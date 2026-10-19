import { describe, expect, it } from 'vitest'
import { sceneStopSec } from './sceneStop'

describe('sceneStopSec', () => {
  it('stops at the end of the sound (post-roll 0)', () => {
    expect(sceneStopSec({ postRollSec: 0, sounds: [{ atSec: 0, durSec: 0.3 }], haptics: [{ atSec: 0, durSec: 0.16 }] })).toBe(0.3)
  })
  it('counts the post-roll from the end of the sound', () => {
    expect(sceneStopSec({ postRollSec: 1, sounds: [{ atSec: 0, durSec: 2.4 }], haptics: [{ atSec: 0, durSec: 0.16 }] })).toBe(3.4)
  })
  it('waits for a haptic longer than the sound + post-roll', () => {
    expect(sceneStopSec({ postRollSec: 0.2, sounds: [{ atSec: 0, durSec: 0.8 }], haptics: [{ atSec: 0, durSec: 1.2 }] })).toBe(1.2)
  })
  it('with no sound, counts the post-roll from the end of the haptic', () => {
    expect(sceneStopSec({ postRollSec: 0, sounds: [], haptics: [{ atSec: 0, durSec: 0.16 }] })).toBe(0.16)
    expect(sceneStopSec({ postRollSec: 1, sounds: [], haptics: [{ atSec: 0, durSec: 0.16 }] })).toBeCloseTo(1.16)
  })
  it('counts a sound at its playback rate', () => {
    expect(sceneStopSec({ postRollSec: 0, sounds: [{ atSec: 0, durSec: 2, rate: 0.5 }], haptics: [] })).toBe(4)
    expect(sceneStopSec({ postRollSec: 0, sounds: [{ atSec: 0, durSec: 2, rate: 2 }], haptics: [] })).toBe(1)
  })
  it('takes the last sound end of a repeat / group', () => {
    expect(sceneStopSec({ postRollSec: 1, sounds: [{ atSec: 0, durSec: 0.3 }, { atSec: 1.6, durSec: 0.3 }], haptics: [{ atSec: 1.6, durSec: 0.2 }] })).toBeCloseTo(2.9)
    expect(sceneStopSec({ postRollSec: 0, sounds: [{ atSec: 0.8, durSec: 3 }, { atSec: 1.6, durSec: 0.3 }], haptics: [] })).toBeCloseTo(3.8)
  })
  it('with context, runs to the end of the representative stretch', () => {
    expect(sceneStopSec({ postRollSec: 0.5, sounds: [{ atSec: 0, durSec: 0.3 }], haptics: [], untilSec: 2.4 })).toBe(2.4)
    expect(sceneStopSec({ postRollSec: 0.5, sounds: [{ atSec: 0, durSec: 3 }], haptics: [], untilSec: 2.4 })).toBe(3.5)
  })
})
