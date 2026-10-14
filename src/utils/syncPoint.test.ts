import { describe, expect, it } from 'vitest'
import { detectSyncMs, savedSyncMs, setSyncMs, soundLeadInSec } from './syncPoint'
import type { CueTable } from './sceneCueTable'

const buffer = (channels: number[][], sampleRate = 1000) => ({ sampleRate, numberOfChannels: channels.length, getChannelData: (c: number) => Float32Array.from(channels[c]) })
const table = (): CueTable => ({ clips: { hit: { intensity: 1, loop: false } }, sounds: { Punch: { intensity: .5 } }, cues: {} })

describe('sync points (DEC-093)', () => {
  it('detects the first sample at 1/10 of the peak on any channel; silence is 0', () => {
    const quiet = Array(30).fill(.05), loud = [...quiet, .5, 1, -.8, .2]
    expect(detectSyncMs(buffer([loud]))).toBe(30)
    // The other channel reaches the level first.
    expect(detectSyncMs(buffer([loud, [...Array(12).fill(0), -.2]]))).toBe(12)
    expect(detectSyncMs(buffer([Array(10).fill(0)]))).toBe(0)
    expect(detectSyncMs(buffer([[...Array(480).fill(0), 1]], 48000))).toBe(10)
  })
  it('saves, reads and removes a sync point per material without touching the rest', () => {
    const t = setSyncMs(setSyncMs(table(), 'haptic', 'hit', 12.4), 'sound', 'Punch', 31)
    expect(savedSyncMs(t, 'haptic', 'hit')).toBe(12)
    expect(t.sounds!.Punch).toEqual({ intensity: .5, syncMs: 31 })
    const back = setSyncMs(t, 'haptic', 'hit', null)
    expect(back.clips.hit).toEqual({ intensity: 1, loop: false })
    expect(savedSyncMs(back, 'haptic', 'hit')).toBeUndefined()
    expect(setSyncMs(table(), 'haptic', 'nope', 5)).toEqual(table())
    expect(setSyncMs(table(), 'sound', 'New', 5).sounds!.New).toEqual({ intensity: 1, syncMs: 5 })
    expect(setSyncMs(table(), 'sound', 'New', null)).toEqual(table())
    expect(savedSyncMs(setSyncMs(table(), 'sound', 'Punch', -3), 'sound', 'Punch')).toBe(0)
  })
  it('leads in only for a sound still sounding at the start, at most maxSec', () => {
    expect(soundLeadInSec([{ atSec: -.12, durSec: 1 }], 0)).toBeCloseTo(.12)
    expect(soundLeadInSec([{ atSec: 1.9, durSec: 1 }, { atSec: 1.5, durSec: .2 }], 2)).toBeCloseTo(.1)
    expect(soundLeadInSec([{ atSec: .3, durSec: 1 }], 0)).toBe(0)
    expect(soundLeadInSec([{ atSec: -5, durSec: 10 }], 0)).toBe(1)
    expect(soundLeadInSec([{ atSec: -.2, durSec: 1, loop: true }], 0)).toBe(0)
  })
})
