import { describe, expect, it } from 'vitest'
import { FiringScheduler, type AudioContextLike } from './firingScheduler'
import { CompanionSound, type SoundSource } from './companionSound'
import { laneColumns, lanePxPerSec, laneX, leadFirings, mixLane, soundLaneParts, type LaneBuffer } from './soundLane'

/** A mono buffer with one full-scale sample at `peakSec`. */
function click(durationSec: number, peakSec: number, sampleRate = 48000): LaneBuffer & { duration: number } {
  const data = new Float32Array(Math.round(durationSec * sampleRate))
  data[Math.round(peakSec * sampleRate)] = 1
  return { duration: durationSec, sampleRate, numberOfChannels: 1, getChannelData: () => data }
}

function mockContext() {
  const starts: { when: number; offset: number }[] = []
  const ctx: AudioContextLike = {
    currentTime: 10, destination: {},
    createGain: () => ({ gain: { value: 1 }, connect: () => {} }),
    createBufferSource: () => ({ buffer: null, connect: () => {}, start: (when: number, offset = 0) => { starts.push({ when, offset }) }, stop: () => {} }),
  }
  return { ctx, starts }
}

describe('haptic lead on the PC sounds (scene hapticLeadMs in the editor audition)', () => {
  it('firings play lead later (FiringScheduler); 0 keeps them', () => {
    const b = { duration: 0.5 }, firings = [{ atSec: 0, buffer: b, gain: 1 }, { atSec: 0.12, buffer: b, gain: 1 }]
    expect(leadFirings(firings, 0)).toEqual(firings)
    const { ctx, starts } = mockContext()
    const scheduler = new FiringScheduler<{ duration: number }>(() => ctx)
    scheduler.setFirings(leadFirings(firings, 0.03))
    scheduler.play(0)
    expect(starts.map(s => +(s.when - 10).toFixed(3))).toEqual([0.03, 0.15])
  })
  it('a negative lead starts the sound part way (its start cut)', () => {
    const b = { duration: 0.5 }
    const { ctx, starts } = mockContext()
    const scheduler = new FiringScheduler<{ duration: number }>(() => ctx)
    scheduler.setFirings(leadFirings([{ atSec: 0, buffer: b, gain: 1 }], -0.02))
    scheduler.play(0)
    expect(starts).toEqual([{ when: 10, offset: 0.02 }])
  })
  it('the companion sound waits for the lead, or starts part way when negative', () => {
    const calls: number[][] = []
    const c = new CompanionSound((_s: SoundSource, offset, delay) => { calls.push([offset, delay]); return { stop: () => {} } })
    c.setSource({ buffer: { duration: 1 } as AudioBuffer, volume: 1 })
    c.play(0, 0.04); c.play(0.5, 0.04); c.play(0, -0.02); c.play(0)
    expect(calls.map(([o, d]) => [+o.toFixed(3), +d.toFixed(3)])).toEqual([[0, 0.04], [0.46, 0], [0.02, 0], [0, 0]])
  })
})

describe('sound lane (stacked above the haptic, same time axis)', () => {
  it('draws the sound where it is played: firing time + lead', () => {
    const sound = click(0.4, 0.005)
    const parts = soundLaneParts({ picked: null, firings: [{ atSec: 0.12, buffer: sound, gain: 1 }] }, 0.02)
    expect(parts[0].atSec).toBeCloseTo(0.14, 9)
    const lane = mixLane(parts, 1, 8000)
    const peak = lane.findIndex(v => v > 0.5)
    expect(peak / 8000).toBeCloseTo(0.145, 3)
  })
  it('without a plan the picked sound sits at the lead; nothing = no lane', () => {
    const sound = click(0.2, 0)
    expect(soundLaneParts({ picked: { buffer: sound, volume: 0.5 }, firings: null }, -0.01)).toEqual([{ atSec: -0.01, buffer: sound, gain: 0.5, loop: false }])
    expect(soundLaneParts({ picked: null, firings: null }, 0.02)).toEqual([])
  })
  it('a sound peak and a haptic peak at the same time land in the same pixel column', () => {
    // Haptic peaks 2/121/241/360 ms; the sound placed 3 ms earlier is drawn 3 ms earlier at any zoom / scroll.
    const width = 800, duration = 0.5, zoom = 4000, viewStart = 0.1
    const px = lanePxPerSec(zoom, width, duration)
    expect(px).toBe(4000)
    expect(laneX(0.121, viewStart, px)).toBeCloseTo(84, 6)
    const lane = mixLane([{ atSec: 0, buffer: click(0.5, 0.121), gain: 1 }], duration, 8000)
    const cols = laneColumns(lane, 8000, viewStart, px, width)
    expect(cols.findIndex(([, hi]) => hi > 0.5)).toBe(Math.round(laneX(0.121, viewStart, px)))
    // A short buffer is stretched to the width, like WaveSurfer.
    expect(lanePxPerSec(1, 800, 0.5)).toBe(1600)
  })
})
