import { describe, expect, it } from 'vitest'
import { isOutputMap, mapOutput, mapValue, withLevelIntercept, withOutputAt, type LevelMap } from './levelMap'
import { clampRate, routePan, routeRate, validateCueTable, type CueTable, type CueTableContext } from './sceneCueTable'
import { effectiveEvent, fireShot, MaterialPicker, setRouteMap, updateOwnRoute } from './cueEvents'
import { buildLoopVoices, CHUNK, loopedAt, panFactors, renderChunk, resampleClip, shotVoices, type LoopVoice } from './sceneHaptics'
import { SceneKitFire } from './sceneKitFire'
import { sampleLib, sampleTable } from './sceneTestFixtures'
import { CONTRACT_CUE_TABLE } from './sceneContractFixtures'

/** DEC-113: a route's pan (balance) and rate (pitch), fixed or from a loop's input (contracts cue-table §4.4 / §5.6). */

const ctx = (): CueTableContext => ({
  lib: sampleLib(), kit: 'mill-kit', cueNames: ['button', 'grab', 'detent', 'feed_loop'], clipFiles: new Set(['click', 'thump', 'hum']), soundFiles: new Set(['Click']),
})
const FEED = { cue: 'feed_loop', variant: null }
const DETENT = { cue: 'detent', variant: null }

describe('pan / rate maps (cue-table §5.6)', () => {
  it('without a map: the route\'s fixed value (absent = 0 / 1), kept in range', () => {
    expect(mapValue('pan', undefined, 0.5)).toBe(0)
    expect(mapValue('rate', undefined, 0.5)).toBe(1)
    expect(mapValue('pan', undefined, 0.5, -0.4)).toBe(-0.4)
    expect(mapValue('rate', undefined, 0.5, 9)).toBe(4)
  })

  it('the same segments as levelMap, in the kind\'s range; input 0 is the intercept (not forced to 0)', () => {
    const pan: LevelMap = { points: [[1, 1]], intercept: -1 }
    expect(mapValue('pan', pan, 0)).toBe(-1)
    expect(mapValue('pan', pan, 0.5)).toBeCloseTo(0)
    expect(mapValue('pan', pan, 3)).toBe(1) // extended, kept in −1..1
    const rate: LevelMap = { points: [[1, 2]] }
    expect(mapValue('rate', rate, 0)).toBe(1) // intercept left out = 1
    expect(mapValue('rate', rate, 0.5)).toBeCloseTo(1.5)
    expect(mapValue('rate', { points: [[1, 0.25]] }, 4)).toBe(0.25) // falling past the point: kept at 0.25
    expect(mapOutput('level', rate, 0)).toBe(0) // a levelMap stays 0 at input 0
  })

  it('shapes: pan −1..1, rate 0.25..4', () => {
    expect(isOutputMap({ points: [[1, -0.5]] }, 'pan')).toBe(true)
    expect(isOutputMap({ points: [[1, -0.5]] }, 'level')).toBe(false)
    expect(isOutputMap({ points: [[1, 2]] }, 'pan')).toBe(false)
    expect(isOutputMap({ points: [[1, 0.1]] }, 'rate')).toBe(false)
    expect(isOutputMap({ points: [[1, 3]], intercept: 0.2 }, 'rate')).toBe(false)
    expect(isOutputMap({ points: [[0, 1]] }, 'rate')).toBe(false)
  })

  it('edits keep the kind\'s range and leave the default intercept out', () => {
    expect(withOutputAt(undefined, 0.5, -3, 'pan')).toEqual({ points: [[0.5, -1]] })
    expect(withLevelIntercept({ points: [[1, 2]] }, 1, 'rate')).toEqual({ points: [[1, 2]] })
    expect(withLevelIntercept({ points: [[1, 2]] }, 0.1, 'rate')).toEqual({ points: [[1, 2]], intercept: 0.25 })
  })
})

describe('the cue table (types, read / write, checks)', () => {
  it('the contracts sample (pan / rate on a one-shot route, panMap / rateMap on a loop route) is valid', () => {
    const table = CONTRACT_CUE_TABLE as unknown as CueTable
    expect(table.cues.grab.haptics![0]).toMatchObject({ pan: -0.5, rate: 1.25 })
    expect(table.cues.rub.haptics![0].rateMap).toEqual({ points: [[1, 1.5]], intercept: 0.8, curve: 'easeOut' })
  })

  it('validates the ranges, maps only on loop cues, and a fixed value and its map not together', () => {
    const base = sampleTable()
    expect(validateCueTable(updateOwnRoute(base, DETENT, 0, { pan: 0.5, rate: 2 }), ctx())).toEqual([])
    const bad = structuredClone(base)
    Object.assign(bad.cues.detent.haptics![0], { pan: 2, rate: 0.1 })
    expect(validateCueTable(bad, ctx())).toEqual(['detent: pan must be -1..1', 'detent: rate must be 0.25..4'])
    const pulseMap = structuredClone(base)
    pulseMap.cues.detent.haptics![0].panMap = { points: [[1, 0]] }
    expect(validateCueTable(pulseMap, ctx())).toEqual(['detent: route panMap is for loop cues'])
    const loop = setRouteMap(base, 'feed_loop', 0, 'rate', { points: [[1, 2]] })
    expect(validateCueTable(loop, ctx())).toEqual([])
    const both = structuredClone(loop)
    both.cues.feed_loop.haptics![0].rate = 1.5
    expect(validateCueTable(both, ctx())).toEqual(['feed_loop: a route has rate or rateMap, not both'])
    const shape = setRouteMap(base, 'feed_loop', 0, 'pan', { points: [[1, 3]] })
    expect(validateCueTable(shape, ctx())).toEqual([expect.stringMatching(/^feed_loop: route panMap must be \{points: \[\[input > 0, output -1\.\.1\]/)])
  })

  it('updateOwnRoute: the fixed value kept in range, the default leaves the key out, a mapped one is left alone', () => {
    const t1 = updateOwnRoute(sampleTable(), DETENT, 0, { pan: -7, rate: 9 })
    expect(t1.cues.detent.haptics![0]).toMatchObject({ pan: -1, rate: 4 })
    const t2 = updateOwnRoute(t1, DETENT, 0, { pan: 0, rate: 1 })
    expect(t2.cues.detent.haptics![0]).not.toHaveProperty('pan')
    expect(t2.cues.detent.haptics![0]).not.toHaveProperty('rate')
    const mapped = setRouteMap(sampleTable(), 'feed_loop', 0, 'pan', { points: [[1, 0.5]] })
    expect(updateOwnRoute(mapped, FEED, 0, { pan: -1 }).cues.feed_loop.haptics![0]).not.toHaveProperty('pan')
  })

  it('setRouteMap: the map replaces the fixed value; removing it goes back to the default', () => {
    const fixed = updateOwnRoute(sampleTable(), FEED, 0, { rate: 2 })
    const mapped = setRouteMap(fixed, 'feed_loop', 0, 'rate', { points: [[1, 3]], intercept: 2 })
    expect(mapped.cues.feed_loop.haptics![0]).toMatchObject({ rateMap: { points: [[1, 3]], intercept: 2 } })
    expect(mapped.cues.feed_loop.haptics![0]).not.toHaveProperty('rate')
    expect(setRouteMap(mapped, 'feed_loop', 0, 'rate', undefined).cues.feed_loop.haptics![0]).not.toHaveProperty('rateMap')
  })

  it('unknown fields of a route are kept by the edits', () => {
    const t = structuredClone(sampleTable())
    t.cues.detent.haptics![0].futureField = 7
    expect(updateOwnRoute(t, DETENT, 0, { pan: 0.3 }).cues.detent.haptics![0].futureField).toBe(7)
  })
})

describe('playback (sdk-multi-stream §5 items 4 and 11, the SDKs\' formulas)', () => {
  it('linear balance factors', () => {
    expect(panFactors(0)).toEqual([1, 1])
    expect(panFactors(-1)).toEqual([1, 0])
    expect(panFactors(0.25)).toEqual([0.75, 1])
    expect(panFactors(5)).toEqual([0, 1])
  })

  it('a one-shot voice: pan on the gain as sent; a one-motor device gets no pan', () => {
    const voice = { pcm: new Float32Array(CHUNK).fill(0.5), targets: [''], gain: 1, start: 0, pan: -0.5 }
    const out = renderChunk({ ip: 'a', address: 'p/pos_neck', wall: 0, voices: [voice], loopVoices: [], clock: null, pcm: {}, level: () => [0, 1] })
    expect([out[0], out[1]]).toEqual([Math.round(0.5 * 32767), Math.round(0.25 * 32767)])
    const mono = renderChunk({ ip: 'a', address: 'p/pos_neck', wall: 0, voices: [voice], loopVoices: [], clock: null, pcm: {}, level: () => [0, 1], mono: true })
    expect(mono[0]).toBe(mono[1])
    expect(mono[0]).toBe(Math.round(0.5 * 32767))
  })

  it('resampleClip: rate 1 is the clip itself, 2 halves the length, 0.5 doubles it (linear, never past the last frame)', () => {
    const clip = Float32Array.from({ length: 101 }, (_, i) => i / 100)
    expect(resampleClip(clip, 1)).toBe(clip)
    expect(resampleClip(clip, 2).length).toBe(51)
    expect(resampleClip(clip, 0.5).length).toBe(201)
    expect(resampleClip(clip, 0.5)[1]).toBeCloseTo(0.005)
    expect(resampleClip(clip, 0.5)[200]).toBeCloseTo(1)
  })

  it('a firing: the route\'s rate × the firing\'s jitter kept in 0.25..4, with its pan', () => {
    const t = updateOwnRoute(sampleTable(), DETENT, 0, { pan: 0.4, rate: 3 })
    const table = structuredClone(t)
    table.cues.detent.variation = { rateJitterPct: 50 }
    const e = effectiveEvent(table, DETENT)!
    const shot = fireShot(e, false, new MaterialPicker(), () => 1) // jitter +50 %
    expect(shot.rate).toBeCloseTo(1.5)
    expect(shot.routes[0]).toMatchObject({ pan: 0.4, rate: 4 }) // 3 × 1.5 = 4.5 → 4
    const pcm = { thump: new Float32Array(400).fill(0.1) }
    const [voice] = shotVoices(table, pcm, shot, 'right', 1, 0)
    expect(voice.pcm.length).toBe(100)
    expect(voice.pan).toBe(0.4)
    expect(clampRate(0.1)).toBe(0.25)
    expect(routePan({ pan: 3 })).toBe(1)
    expect(routeRate({})).toBe(1)
  })

  const ramp = Float32Array.from({ length: 64 }, (_, i) => Math.sin(i / 64 * 2 * Math.PI) * 0.5)
  const loopRender = (voice: LoopVoice, level: [number, number], chunks: number, mono = false) => {
    const out: number[][] = [[], []]
    for (let c = 0; c < chunks; c++) {
      const pcm16 = renderChunk({ ip: 'a', address: 'p/pos_r_wrist', wall: c * CHUNK / 16, voices: [], loopVoices: [voice], clock: { t: 0, rate: 1, wall: 0 }, pcm: { hum: ramp }, level: () => level, mono })
      for (let k = 0; k < CHUNK; k++) { out[0].push(pcm16[2 * k]); out[1].push(pcm16[2 * k + 1]) }
    }
    return out
  }
  const feedVoice = (table: CueTable) => buildLoopVoices(table, sampleLib()).find(v => v.side === 1)!

  it('a loop at rate 1: the clip\'s own samples (as before), L = R without pan', () => {
    const [l, r] = loopRender(feedVoice(sampleTable()), [1, 1], 2)
    for (let k = 0; k < 2 * CHUNK; k++) expect(l[k]).toBe(Math.max(-32768, Math.min(32767, Math.round(ramp[k % 64] * 0.8 * 32767))))
    expect(r).toEqual(l)
  })

  it('a loop at rate 2 (fixed, or the recorded rate) reads every other frame; at 0.5 it interpolates between frames', () => {
    const fast = feedVoice(updateOwnRoute(sampleTable(), FEED, 0, { rate: 2 }))
    const [l2] = loopRender(fast, [1, 1], 1)
    for (let k = 0; k < 32; k++) expect(l2[k]).toBe(Math.round(ramp[(2 * k) % 64] * 0.8 * 32767))
    const [recorded] = loopRender(feedVoice(sampleTable()), [1, 2], 1)
    expect(recorded).toEqual(l2)
    const [half] = loopRender(feedVoice(updateOwnRoute(sampleTable(), FEED, 0, { rate: 0.5 })), [1, 1], 1)
    expect(half[1]).toBe(Math.round((ramp[0] + ramp[1]) / 2 * 0.8 * 32767))
    // The loop wraps: the last frame is joined to the first.
    const looped = loopedAt(ramp, 0.5, 130)
    expect(looped[127]).toBeCloseTo((ramp[63] + ramp[0]) / 2)
  })

  it('a loop\'s rate from rateMap × the recorded rate, kept to 4; pan from panMap at the level', () => {
    const t = setRouteMap(setRouteMap(sampleTable(), 'feed_loop', 0, 'rate', { points: [[1, 3]] }), 'feed_loop', 0, 'pan', { points: [[1, -1]] })
    const v = feedVoice(t)
    const [l, r] = loopRender(v, [1, 2], 1) // 3 × 2 = 6 → 4
    expect(l[1]).toBe(Math.round(ramp[4] * 0.8 * 32767))
    expect(r.every(x => x === 0)).toBe(true) // pan −1: left only
    const [ml, mr] = loopRender(feedVoice(t), [1, 2], 1, true) // one motor: no pan
    expect(mr).toEqual(ml)
  })

  it('a rate change while the loop plays keeps the read position (no jump at the chunk boundary)', () => {
    const v = feedVoice(sampleTable())
    loopRender(v, [1, 1], 1) // one chunk at rate 1: the position is CHUNK
    const before = v.phase.a
    expect(before).toBe(CHUNK % 64)
    v.rate = 1.5
    const [l] = loopRender(v, [1, 1], 1)
    expect(l[0]).toBe(Math.round(ramp[before] * 0.8 * 32767)) // the next chunk starts where the last ended
    expect(v.phase.a).toBeCloseTo((before + 1.5 * CHUNK) % 64)
  })
})

describe('FIRE (the Kit on the device): pan goes in PLAY, the rate is not applied', () => {
  it('a firing sends the route\'s pan', () => {
    const sent: { type: string; payload: Record<string, unknown> }[] = []
    let timer: (() => void) | null = null
    const fire = new SceneKitFire({ send: (type, payload) => sent.push({ type, payload }), now: () => 0, setTimer: fn => { timer = fn; return 1 }, clearTimer: () => {} })
    const table = updateOwnRoute(sampleTable(), DETENT, 0, { pan: -0.6 })
    const shot = fireShot(effectiveEvent(table, DETENT)!, false, new MaterialPicker())
    fire.shot({ table, shot, hand: 'right', cueGain: 1, delayMs: 0, offsetMs: 0, devices: [{ ipAddress: '10.0.0.2', address: 'p/pos_chest' }], all: false })
    timer!()
    expect(sent[0]).toMatchObject({ type: 'play_event', payload: { pan: -0.6, targets: ['10.0.0.2'] } })
    // No pan: the payload is as before.
    sent.length = 0
    fire.shot({ table: sampleTable(), shot: fireShot(effectiveEvent(sampleTable(), DETENT)!, false, new MaterialPicker()), hand: 'right', cueGain: 1, delayMs: 0, offsetMs: 0, devices: [{ ipAddress: '10.0.0.2', address: 'p/pos_chest' }], all: false })
    timer!()
    expect(sent[0].payload).not.toHaveProperty('pan')
  })
})
