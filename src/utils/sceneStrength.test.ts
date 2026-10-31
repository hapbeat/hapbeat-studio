import { describe, expect, it } from 'vitest'
import { effectiveEvent, setDistanceFalloff, setVariantScale } from './cueEvents'
import { firingGains, firingStrength, recordingFiringStrength, firingKey } from './sceneFiringGain'
import {
  eventRoutes, faderValue, gainsAtFader, hapticAllowed, jitterDbToPct, jitterPctToDb, median, ratioDb, recordedIndexMap, recordedName,
  scaleFiringGain, scaleRouteGain, setRouteGains, strengthStep,
} from './sceneStrength'
import { sampleData, sampleTable } from './sceneTestFixtures'
import type { SceneEvent } from './sceneData'

const ev = (name: string, t = 3, extra: Partial<SceneEvent> = {}): SceneEvent => ({ t, name, hand: 'right', ...extra })

describe('firingStrength (software / material / sent, never mixed)', () => {
  it('splits a firing into material × software, sent matching the runtime gain', () => {
    const table = sampleTable(), d = ev('detent', 1, { gain: 0.4 })
    // detent: thump intensity 0.5 (material) × route 0.5 × firing 0.4 (software 0.2) = 0.1 sent.
    const s = firingStrength(table, [d], d)!
    expect(s.material).toBe(0.5)
    expect(s.software).toBeCloseTo(0.2)
    expect(s.route).toBe(0.5)
    expect(s.firing).toBe(0.4)
    expect(s.scale).toBe(1)
    expect(s.sent).toBeCloseTo(0.1)
    expect(s.sent).toBeCloseTo(firingGains(table, [d], d).haptics!)
  })
  it('an omitted firing gain is 1; loops, events without routes and unknown ones are not one-shots', () => {
    const table = sampleTable()
    expect(firingStrength(table, [ev('button')], ev('button'))).toMatchObject({ software: 1, material: 1, sent: 1, firing: 1 })
    expect(firingStrength(table, [ev('feed_loop')], ev('feed_loop'))).toBeNull()
    expect(firingStrength(table, [ev('grab')], ev('grab'))).toBeNull()
    expect(firingStrength(table, [ev('nope')], ev('nope'))).toBeNull()
  })
  it('the variant multiplier and the falloff are software, the loudest route is the one shown', () => {
    let table = sampleTable()
    table.cues.button.variants = { soft: { hapticsGain: 0.5 } }
    table.cues.button.haptics!.push({ clip: 'thump', at: 'pos_chest', gain: 2 })
    table = setDistanceFalloff(table, { cue: 'button', variant: null }, { nearCm: 560, farCm: 2000, farGain: 0.5 })
    const e = ev('button:soft', 3, { dist: 5000 })
    const s = firingStrength(table, [e], e)!
    // click: 1 × (1 × 0.25) = 0.25 sent; thump: 0.5 × (2 × 0.25) = 0.25 — equal, the first wins.
    expect(s.scale).toBeCloseTo(0.25)
    expect(s.material).toBe(1)
    table = setVariantScale(table, { cue: 'button', variant: 'soft' }, { hapticsGain: 1 })
    expect(firingStrength(table, [e], e)!.software).toBeCloseTo(0.5)
  })
  it('keys every firing of the recording', () => {
    const data = sampleData(), map = recordingFiringStrength(sampleTable(), data.full.events)
    expect(map.get(firingKey('button', 3))?.software).toBe(1)
    expect(map.get(firingKey('feed_loop', 4.5))).toBeNull()
  })
})

describe('scaling a selection', () => {
  it('firing gains: same ratio, never below 0, 3 decimals, no upper limit', () => {
    expect(scaleFiringGain(0.2, 1.5)).toBe(0.3)
    expect(scaleFiringGain(0.2, -1)).toBe(0)
    expect(scaleFiringGain(3, 2)).toBe(6)
    expect(scaleFiringGain(0.123456, 1)).toBe(0.123)
  })
  it('route gains: same ratio, clamped 0..2', () => {
    expect(scaleRouteGain(0.5, 2)).toBe(1)
    expect(scaleRouteGain(1.5, 2)).toBe(2)
    expect(scaleRouteGain(0.5, -1)).toBe(0)
  })
  it('an event fader shows the largest route and scales all of them by one ratio', () => {
    expect(faderValue([0.5, 1])).toBe(1)
    expect(gainsAtFader([0.5, 1], 1.5)).toEqual([0.75, 1.5])
    expect(gainsAtFader([0.5, 1], 4)).toEqual([2, 2])
    expect(gainsAtFader([0, 0], 0.7)).toEqual([0.7, 0.7])
  })
  it('steps and ratios', () => {
    expect(ratioDb(strengthStep(false))).toBeCloseTo(1)
    expect(ratioDb(strengthStep(true))).toBeCloseTo(3.01, 2)
    expect(median([0.3, 0.1, 0.2])).toBe(0.2)
    expect(median([0.1, 0.2, 0.3, 0.4])).toBeCloseTo(0.25)
    expect(median([])).toBe(1)
  })
})

describe('event routes', () => {
  it('a variant sharing its cue edits the cue; one with its own haptics edits itself', () => {
    let table = sampleTable()
    table.cues.detent.variants = { soft: { hapticsGain: 0.5 }, own: { haptics: [{ clip: 'thump', at: 'hand', gain: 0.3 }] } }
    expect(eventRoutes(table, 'detent:soft')).toEqual({ owner: { cue: 'detent', variant: null }, gains: [0.5] })
    expect(eventRoutes(table, 'detent:own')).toEqual({ owner: { cue: 'detent', variant: 'own' }, gains: [0.3] })
    expect(eventRoutes(table, 'feed_loop')).toBeNull()
    table = setRouteGains(table, { cue: 'detent', variant: null }, [0.8])
    expect(effectiveEvent(table, { cue: 'detent', variant: 'soft' })!.haptics[0].gain).toBe(0.8)
    expect(setRouteGains(table, { cue: 'detent', variant: null }, [5]).cues.detent.haptics![0].gain).toBe(2)
  })
})

describe('jitter dB ↔ %', () => {
  it('converts both ways', () => {
    expect(jitterDbToPct(0)).toBe(0)
    expect(jitterDbToPct(20 * Math.log10(2))).toBeCloseTo(100)
    expect(jitterDbToPct(3)).toBeCloseTo(41.25, 1)
    expect(jitterPctToDb(0)).toBe(0)
    expect(jitterPctToDb(100)).toBeCloseTo(6.0206, 3)
    expect(jitterPctToDb(jitterDbToPct(2.5))).toBeCloseTo(2.5)
    expect(jitterPctToDb(500)).toBeCloseTo(6.0206, 3)
  })
})

describe('recorded firings and mute / solo', () => {
  it('maps a shown firing back to its recorded index (overrides keep the recorded name)', () => {
    const events = sampleData().full.events, map = recordedIndexMap(events)
    expect(map.get(firingKey('grab', 3.1))).toBe(2)
    expect(recordedName({ t: 3.1, name: 'button', hand: '', from: 'grab' })).toBe('grab')
  })
  it('solo wins over mute', () => {
    expect(hapticAllowed('a', new Set(['a']), new Set())).toBe(false)
    expect(hapticAllowed('a', new Set(), new Set(['b']))).toBe(false)
    expect(hapticAllowed('b', new Set(['b']), new Set(['b']))).toBe(true)
    expect(hapticAllowed('a', new Set(), new Set())).toBe(true)
  })
})
