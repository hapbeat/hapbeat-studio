import { describe, expect, it } from 'vitest'
import { setDistanceFalloff, setVariantScale } from './cueEvents'
import { firingBar, firingGains, firingKey, MIN_BAR_PX, recordingFiringGains } from './sceneFiringGain'
import { sampleData, sampleLib, sampleTable } from './sceneTestFixtures'
import type { SceneEvent } from './sceneData'

const lib = sampleLib()
const ev = (name: string, t = 3, extra: Partial<SceneEvent> = {}): SceneEvent => ({ t, name, hand: 'right', gain: 1, ...extra })

describe('firingGains', () => {
  it('resolves sound and haptic gain like the runtime', () => {
    const table = sampleTable(), events = [ev('button')]
    // sound: intensity 1 × volume 0.6; haptics: click intensity 1 × route 1.0 × recorded gain 1.
    expect(firingGains(table, lib, events, events[0])).toEqual({ sound: 0.6, haptics: 1 })
    // detent: no sound; thump intensity 0.5 × route 0.5 × recorded gain 0.5.
    const d = ev('detent', 1, { gain: 0.5 })
    const g = firingGains(table, lib, [d], d)
    expect(g.sound).toBeNull()
    expect(g.haptics).toBeCloseTo(0.125)
  })
  it('loop cues and unknown events are not one-shot bars', () => {
    const table = sampleTable()
    expect(firingGains(table, lib, [ev('feed_loop')], ev('feed_loop'))).toEqual({ sound: null, haptics: null })
    expect(firingGains(table, lib, [ev('nope')], ev('nope'))).toEqual({ sound: null, haptics: null })
  })
  it('applies variant multipliers and distance falloff, and follows edits', () => {
    let table = sampleTable()
    table.cues.button.variants = { soft: { sfxVolume: 0.5, hapticsGain: 0.5 } }
    const e = ev('button:soft', 3, { dist: 5000 })
    expect(firingGains(table, lib, [e], e).sound).toBeCloseTo(0.3)
    expect(firingGains(table, lib, [e], e).haptics).toBeCloseTo(0.5)
    table = setVariantScale(table, { cue: 'button', variant: 'soft' }, { hapticsGain: 2 })
    expect(firingGains(table, lib, [e], e).haptics).toBeCloseTo(2)
    table = setDistanceFalloff(table, { cue: 'button', variant: null }, { nearCm: 560, farCm: 2000, farGain: 0.15 })
    expect(firingGains(table, lib, [e], e).haptics).toBeCloseTo(0.3)
    expect(firingGains(table, lib, [e], e).sound).toBeCloseTo(0.3 * 0.15)
  })
  it('keys every firing of the recording by replay time', () => {
    const data = sampleData(), map = recordingFiringGains(sampleTable(), lib, data.full.events)
    expect(map.get(firingKey('grab', 3.1))).toEqual({ sound: null, haptics: null })
    // A clip item's event time plus its offset finds the same firing.
    expect(map.get(firingKey('button', 2.0 + 1.0))?.haptics).toBe(1)
  })
})

describe('firingBar', () => {
  const y0 = 10, y1 = 50 // lane height 40
  it('bar height = gain × lane height', () => {
    expect(firingBar(0.5, y0, y1)).toEqual({ top: 30, over: false, stub: false })
    expect(firingBar(1, y0, y1).top).toBe(y0)
  })
  it('clamps above 1 to the lane top with a cap', () => {
    expect(firingBar(1.6, y0, y1)).toEqual({ top: y0, over: true, stub: false })
  })
  it('keeps a minimum height above 0 and a stub at 0', () => {
    expect(y1 - firingBar(0.01, y0, y1).top).toBe(MIN_BAR_PX)
    expect(firingBar(0, y0, y1)).toEqual({ top: y1, over: false, stub: true })
  })
})
