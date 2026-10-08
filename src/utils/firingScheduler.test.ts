import { describe, expect, it } from 'vitest'
import { FiringScheduler, type AudioContextLike } from './firingScheduler'
import { sceneSegment } from './sceneSegments'

/** AudioContext stand-in that records every source start (when, offset, buffer, gain). */
function mockContext() {
  const starts: { when: number; offset: number; buffer: unknown; gain: number }[] = []
  let stops = 0
  const gains: { gain: { value: number } }[] = []
  const ctx: AudioContextLike = {
    currentTime: 10, destination: {},
    createGain: () => { const g = { gain: { value: 1 }, connect: () => {} }; gains.push(g); return g },
    createBufferSource: () => {
      const node = { buffer: null as unknown, gainNode: null as null | { gain: { value: number } },
        connect(target: unknown) { this.gainNode = target as { gain: { value: number } } },
        start(when: number, offset = 0) { starts.push({ when, offset, buffer: node.buffer, gain: node.gainNode?.gain.value ?? 1 }) },
        stop() { stops++ } }
      return node
    },
  }
  return { ctx, starts, gains, stops: () => stops }
}

/** The T37 scene: bite:tear rated (red), bite (grey) — the meal of the T-Rex recording. */
const MEAL = [21.367, 21.967, 23.4, 24.0, 25.4, 26.0].map((t, i) => ({ t, name: i % 2 ? 'bite:tear' : 'bite', hand: 'right' }))
const biteSound = { duration: 0.9 }, tearSound = { duration: 0.7 }

describe('scene firings (each its own source)', () => {
  it('bite:tear rated: 3 grey bite firings and 3 red firings start at their times, none cut by another', () => {
    const seg = sceneSegment(MEAL, ['bite:tear'], 0.7)!
    const mark = seg.marks[0].t
    const red = seg.marks.filter(m => m.target).map(m => ({ atSec: m.t - mark, buffer: tearSound, gain: 0.8 }))
    const grey = seg.marks.filter(m => !m.target).map(m => ({ atSec: m.t - mark, buffer: biteSound, gain: 1 }))
    const { ctx, starts, stops } = mockContext()
    const scheduler = new FiringScheduler<{ duration: number }>(() => ctx)
    scheduler.setFirings([...grey, ...red])
    scheduler.play(0)
    const at = (b: unknown) => starts.filter(s => s.buffer === b).map(s => +(s.when - 10).toFixed(3))
    expect(at(biteSound)).toEqual([0, 2.033, 4.033])
    expect(at(tearSound)).toEqual([0.6, 2.633, 4.633])
    expect(stops()).toBe(0)
    // The same list again (a store refresh every 2 s) keeps them playing.
    scheduler.setFirings(grey.map(f => ({ ...f })).concat(red.map(f => ({ ...f }))))
    expect(stops()).toBe(0)
  })

  it('from a seek position: past firings are skipped, one sounding starts part way, later ones are scheduled', () => {
    const { ctx, starts } = mockContext()
    const scheduler = new FiringScheduler<{ duration: number }>(() => ctx)
    scheduler.setFirings([0, 2, 4].map(atSec => ({ atSec, buffer: biteSound, gain: 1 })))
    scheduler.play(2.5)
    expect(starts.map(s => [+(s.when - 10).toFixed(2), +s.offset.toFixed(2)])).toEqual([[0, 0.5], [1.5, 0]])
  })

  it('a different list or stop() stops what is playing', () => {
    const { ctx, stops } = mockContext()
    const scheduler = new FiringScheduler<{ duration: number }>(() => ctx)
    scheduler.setFirings([{ atSec: 0, buffer: biteSound, gain: 1 }, { atSec: 2, buffer: biteSound, gain: 1 }])
    scheduler.play(0)
    scheduler.setFirings([{ atSec: 0, buffer: tearSound, gain: 1 }])
    expect(stops()).toBe(2)
    scheduler.play(0); scheduler.stop()
    expect(stops()).toBe(3)
  })

  it('only the gains changed while it plays: nothing stops, a firing not started yet gets its new gain, one sounding keeps its own', () => {
    const { ctx, gains, stops } = mockContext()
    const scheduler = new FiringScheduler<{ duration: number }>(() => ctx)
    scheduler.setFirings([{ atSec: 0, buffer: biteSound, gain: 1 }, { atSec: 2, buffer: biteSound, gain: 1 }])
    scheduler.play(0)
    ctx.currentTime = 10.5 // the first firing sounds, the second starts at 12
    scheduler.setFirings([{ atSec: 0, buffer: biteSound, gain: 0.5 }, { atSec: 2, buffer: biteSound, gain: 0.5 }])
    expect(stops()).toBe(0)
    expect(gains.map(g => g.gain.value)).toEqual([1, 0.5])
    // The next play (a loop repeat) starts every firing at the new gain.
    scheduler.play(0)
    expect(gains.slice(2).map(g => g.gain.value)).toEqual([0.5, 0.5])
  })
})
