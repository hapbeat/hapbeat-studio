import { describe, expect, it } from 'vitest'
import { applyEmits, emitRun, emitSignature, emittedEvents, emitWait, EMIT_MIN_WAIT, layerRuns } from './sceneEmit'
import { parseCueTable, serializeCueTable, validateCueTable, type CueEmit, type CueTable, type CueTableContext } from './sceneCueTable'
import { setEmit } from './cueEvents'
import { mulberry32 } from './textureDsp'
import { sampleData, sampleLib, sampleTable } from './sceneTestFixtures'

const ctx = (patch: Partial<CueTableContext> = {}): CueTableContext => ({
  lib: sampleLib(), kit: 'mill-kit', cueNames: ['button', 'grab', 'detent', 'feed_loop'],
  clipFiles: new Set(['click', 'thump', 'hum']), soundFiles: new Set(['Click']), ...patch,
})
const emitting = (emit: unknown): CueTable => { const t = sampleTable(); t.cues.grab.emit = emit as CueEmit; return t }
const MESSAGE = 'emit must be {during: <loop cue>, intervalSec: 0.05..30, jitterPct?: 0..100} on a pulse cue'

describe('cue table emit (DEC-088) validation', () => {
  it('accepts an emit on a pulse cue (jitterPct optional)', () => {
    expect(validateCueTable(emitting({ during: 'feed_loop', intervalSec: 0.9, jitterPct: 70 }), ctx())).toEqual([])
    expect(validateCueTable(emitting({ during: 'feed_loop', intervalSec: 0.05 }), ctx())).toEqual([])
    expect(validateCueTable(emitting({ during: 'feed_loop', intervalSec: 30, jitterPct: 100 }), ctx())).toEqual([])
  })

  it.each([
    ['a pulse cue as during', { during: 'button', intervalSec: 1 }],
    ['an unknown during', { during: 'nope', intervalSec: 1 }],
    ['interval below range', { during: 'feed_loop', intervalSec: 0.04 }],
    ['interval above range', { during: 'feed_loop', intervalSec: 31 }],
    ['interval missing', { during: 'feed_loop' }],
    ['jitter out of range', { during: 'feed_loop', intervalSec: 1, jitterPct: 101 }],
    ['an unknown key', { during: 'feed_loop', intervalSec: 1, rate: 2 }],
    ['not an object', 3],
  ])('rejects %s', (_, emit) => {
    expect(validateCueTable(emitting(emit), ctx())).toContain(`grab: ${MESSAGE}`)
  })

  it('rejects an emit on a loop cue', () => {
    const t = sampleTable()
    t.cues.feed_loop.emit = { during: 'feed_loop', intervalSec: 1 }
    expect(validateCueTable(t, ctx())).toContain(`feed_loop: ${MESSAGE}`)
  })

  it('round-trips unchanged and edits keep the key in place', () => {
    const text = '{\n  "kit": "mill-kit",\n  "clips": {},\n  "cues": {\n    "grab": {\n      "sfx": null,\n      "emit": {\n        "during": "feed_loop",\n        "intervalSec": 0.9,\n        "jitterPct": 70\n      },\n      "review": {\n        "sfx": "tentative"\n      }\n    }\n  }\n}\n'
    const table = parseCueTable(text)
    expect(serializeCueTable(table)).toBe(text)
    const next = setEmit(table, 'grab', { intervalSec: 0.01, jitterPct: 150 })
    expect(Object.keys(next.cues.grab)).toEqual(['sfx', 'emit', 'review'])
    expect(next.cues.grab.emit).toEqual({ during: 'feed_loop', intervalSec: 0.05, jitterPct: 100 })
    expect(setEmit(table, 'grab', { during: 'other' }).cues.grab.emit?.during).toBe('other')
    // A cue without emit is not given one.
    expect(setEmit(sampleTable(), 'grab', { intervalSec: 1 }).cues.grab.emit).toBeUndefined()
  })
})

describe('emit rule (as the game)', () => {
  const emit: CueEmit = { during: 'feed_loop', intervalSec: 0.9, jitterPct: 70 }

  it('waits within interval × (1 ± jitter), floored at 0.02 s', () => {
    const random = mulberry32(7)
    for (let i = 0; i < 2000; i++) {
      const w = emitWait(emit, random)
      expect(w).toBeGreaterThanOrEqual(0.9 * 0.3 - 1e-9)
      expect(w).toBeLessThanOrEqual(0.9 * 1.7 + 1e-9)
    }
    const short: CueEmit = { during: 'feed_loop', intervalSec: 0.05, jitterPct: 100 }
    const waits = Array.from({ length: 2000 }, () => emitWait(short, random))
    expect(Math.min(...waits)).toBe(EMIT_MIN_WAIT)
    expect(waits.every(w => w >= EMIT_MIN_WAIT)).toBe(true)
    expect(emitWait({ during: 'feed_loop', intervalSec: 2 }, random)).toBe(2)
  })

  it('fires first within one wait of the start, then a wait apart, only inside the run', () => {
    for (let seed = 1; seed < 200; seed++) {
      const times = emitRun(emit, 10, 20, mulberry32(seed))
      expect(times[0]).toBeGreaterThanOrEqual(10)
      expect(times[0]).toBeLessThan(10 + 0.9 * 1.7)
      for (let i = 1; i < times.length; i++) {
        const gap = times[i] - times[i - 1]
        expect(gap).toBeGreaterThanOrEqual(0.9 * 0.3 - 1e-9)
        expect(gap).toBeLessThanOrEqual(0.9 * 1.7 + 1e-9)
      }
      expect(times.every(t => t < 20)).toBe(true)
    }
  })

  it('finds the active runs from the louder hand and starts over after each', () => {
    const lib = sampleLib(), layer = lib.layers[0]
    // 30 fps: on 1–2 s (left), off, on 3–4 s (right only), on to the end 5–6 s.
    const levels = Array.from({ length: 180 }, (_, i) => i >= 30 && i < 60 ? [0.5, 0, 1, 1] : i >= 90 && i < 120 ? [0, 0.3, 1, 1] : i >= 150 ? [1, 1, 1, 1] : [0, 0, 0, 0])
    expect(layerRuns(levels, 30, layer)).toEqual([[1, 2], [3, 4], [5, 6]])
    const table = emitting({ during: 'feed_loop', intervalSec: 0.2, jitterPct: 50 })
    const fired = emittedEvents(table, lib, levels, 30, 42)
    expect(fired.length).toBeGreaterThan(9)
    expect(fired.every(e => e.name === 'grab' && e.hand === 'both' && e.emitted)).toBe(true)
    for (const [start, end] of [[1, 2], [3, 4], [5, 6]]) {
      const run = fired.filter(e => e.t >= start && e.t < end)
      expect(run.length).toBeGreaterThan(0)
      expect(run[0].t - start).toBeLessThan(0.2 * 1.5)
    }
    expect(fired.every(e => (e.t >= 1 && e.t < 2) || (e.t >= 3 && e.t < 4) || (e.t >= 5 && e.t < 6))).toBe(true)
  })

  it('is the same for a seed and different for another', () => {
    const lib = sampleLib(), levels = Array.from({ length: 300 }, () => [1, 0, 1, 1])
    const table = emitting({ during: 'feed_loop', intervalSec: 0.5, jitterPct: 70 })
    const a = emittedEvents(table, lib, levels, 30, 5), b = emittedEvents(table, lib, levels, 30, 5), c = emittedEvents(table, lib, levels, 30, 6)
    expect(a).toEqual(b)
    expect(a.map(e => e.t)).not.toEqual(c.map(e => e.t))
  })
})

describe('Scene tab playback of emitted cues', () => {
  it('replaces the recorded firings of an emitting cue with generated ones', () => {
    const data = sampleData(), lib = sampleLib()
    const table = emitting({ during: 'feed_loop', intervalSec: 0.5, jitterPct: 30 })
    const out = applyEmits(data, table, lib, 1)
    // The recorded grab at 3.1 s is gone; the others stay.
    expect(out.full.events.some(e => e.name === 'grab' && e.t === 3.1)).toBe(false)
    expect(out.full.events.filter(e => e.name !== 'grab')).toEqual(data.full.events.filter(e => e.name !== 'grab'))
    expect(out.full.events.filter(e => e.name === 'grab').every(e => (e as { emitted?: boolean }).emitted)).toBe(true)
    expect(out.full.events.filter(e => e.name === 'grab').length).toBeGreaterThan(0)
    expect(out.full.events.map(e => e.t)).toEqual([...out.full.events.map(e => e.t)].sort((x, y) => x - y))
    // Same seed (a seek, a replay): the same firings.
    expect(applyEmits(data, table, lib, 1)).toEqual(out)
  })

  it('leaves the recording alone without a usable emit', () => {
    const data = sampleData(), lib = sampleLib()
    expect(applyEmits(data, sampleTable(), lib, 1)).toBe(data)
    // during without a recorded layer: nothing generated, recorded firings kept.
    expect(applyEmits(data, emitting({ during: 'other_loop', intervalSec: 1 }), lib, 1)).toBe(data)
  })

  it('emitSignature changes only with an emit', () => {
    const table = emitting({ during: 'feed_loop', intervalSec: 1 })
    const louder = structuredClone(table); louder.cues.button.sfx!.volume = 1
    expect(emitSignature(louder)).toBe(emitSignature(table))
    expect(emitSignature(setEmit(table, 'grab', { jitterPct: 10 }))).not.toBe(emitSignature(table))
  })
})
