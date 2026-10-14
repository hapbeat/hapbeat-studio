import { describe, expect, it } from 'vitest'
import { clickTimes, testClick, testHaptic, TEST_FIRST_SEC, TEST_PERIOD_SEC, TEST_PULSES, TEST_RATE } from './pcTimingTest'
import { detectSyncMs } from './syncPoint'

describe('PC timing test pattern (DEC-093)', () => {
  it('pulses start at full scale on their first sample, one per period', () => {
    const h = testHaptic()
    expect(h.length).toBe(Math.ceil((TEST_FIRST_SEC + TEST_PULSES * TEST_PERIOD_SEC) * TEST_RATE))
    const first = Math.round(TEST_FIRST_SEC * TEST_RATE)
    expect(h[first - 1]).toBe(0); expect(h[first]).toBeCloseTo(.9)
    expect(h[first + TEST_RATE]).toBeCloseTo(.9)
    expect(detectSyncMs({ sampleRate: TEST_RATE, numberOfChannels: 1, getChannelData: () => h })).toBe(TEST_FIRST_SEC * 1000)
    expect(detectSyncMs({ sampleRate: 48000, numberOfChannels: 1, getChannelData: () => testClick(48000) })).toBe(0)
  })
  it('puts each click at its pulse minus the offset (+ = the haptic later), up to the window', () => {
    expect(clickTimes(10, 0, 0, 11.6)).toEqual([{ pulse: 0, at: 10.5 }, { pulse: 1, at: 11.5 }])
    expect(clickTimes(10, 40, 1, 11.5)[0].at).toBeCloseTo(11.46)
    expect(clickTimes(10, -40, 0, 10.52)).toEqual([])
    expect(clickTimes(0, 0, TEST_PULSES - 1, 1e9)).toHaveLength(1)
  })
})
