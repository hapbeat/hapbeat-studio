import { describe, expect, it } from 'vitest'
import { FiringScheduler, type AudioContextLike } from './firingScheduler'
import { CompanionSound, type SoundSource } from './companionSound'
import { laneLine, lanePxPerSec, laneX, leadFirings, mixLane, soundLaneParts, type LaneBuffer } from './soundLane'

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
  it('a sound peak and a haptic peak at the same time land at the same x', () => {
    // Haptic peaks 2/121/241/360 ms; the sound placed 3 ms earlier is drawn 3 ms earlier at any zoom / scroll.
    const width = 800, duration = 0.5, zoom = 4000, viewStart = 0.1
    const px = lanePxPerSec(zoom, width, duration)
    expect(px).toBe(4000)
    expect(laneX(0.121, viewStart, px)).toBeCloseTo(84, 6)
    const lane = mixLane([{ atSec: 0, buffer: click(0.5, 0.121), gain: 1 }], duration)
    const peak = laneLine(lane, 48000, viewStart, px, width).find(p => p.value > 0.5)!
    expect(peak.x).toBeCloseTo(laneX(0.121, viewStart, px), 6)
    // Zoomed out (many samples per pixel) the peak is still drawn, at its own x; the line starts at the view's start.
    const wide = laneLine(lane, 48000, 0, lanePxPerSec(1, 800, duration), 800)
    expect(wide.find(p => p.value > 0.5)!.x).toBeCloseTo(laneX(0.121, 0, 1600), 6)
    expect(wide[0]).toEqual({ x: 0, value: 0 })
    expect(laneLine(lane, 48000, 1, px, width)).toEqual([])
    // A short buffer is stretched to the width, like WaveSurfer.
    expect(lanePxPerSec(1, 800, 0.5)).toBe(1600)
  })
})

describe('sync shift of the own sound (DEC-093)', () => {
  it('moves only the own firings by the sync shift, all by the lead', () => {
    const b = { duration: 1, sampleRate: 1000, numberOfChannels: 1, getChannelData: () => new Float32Array(1000) }
    const moved = leadFirings([{ atSec: 1, own: true }, { atSec: 2 }], .05, -.02)
    expect(moved[0].atSec).toBeCloseTo(1.03); expect(moved[1].atSec).toBeCloseTo(2.05)
    expect(soundLaneParts({ picked: { buffer: b, volume: 1 }, firings: null }, 0, -.02)[0].atSec).toBeCloseTo(-.02)
    expect(soundLaneParts({ picked: null, firings: [{ atSec: 1, buffer: b, gain: 1, own: true }] }, 0, .01)[0].atSec).toBeCloseTo(1.01)
  })
})
