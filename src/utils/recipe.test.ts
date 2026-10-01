import { describe, expect, it } from 'vitest'
import { impulseOnsets, loadRecipeSamples, RECIPE_PRESETS, renderRecipe, validateRecipe, type Recipe, type RecipeLayer } from './recipe'
import { mulberry32 } from './textureDsp'

const recipe = (layers: RecipeLayer[], durationSec = 1, seed = 42): Recipe => ({ format: 'hapbeat-recipe@1', sampleRate: 48000, durationSec, seed, layers })
const peak = (data: Float32Array, from = 0, to = data.length) => {
  let max = 0
  for (let i = from; i < to; i++) max = Math.max(max, Math.abs(data[i]))
  return max
}
const risingCrossings = (data: Float32Array, from: number, to: number) => {
  let count = 0
  for (let i = from + 1; i < to; i++) if (data[i - 1] < 0 && data[i] >= 0) count++
  return count
}

describe('validateRecipe', () => {
  it('accepts every preset and the documented example', () => {
    for (const preset of RECIPE_PRESETS) expect(validateRecipe(preset.recipe)).toBeNull()
    expect(validateRecipe({
      format: 'hapbeat-recipe@1', sampleRate: 48000, durationSec: 1.5, seed: 42,
      layers: [{
        source: { type: 'impulse-train', rateHz: 20, jitter: 0.3, amplitudeJitter: 0.2, pulse: { freqHz: 120, decayMs: 15 } },
        gainDb: 0, startSec: 0, durationSec: 1, am: { rateHz: 18, depth: 0.8, shape: 'random', jitter: 0.4 },
        envelope: [{ time: 0, value: 0 }, { time: 0.05, value: 1 }, { time: 1, value: 0 }], fadeMs: 3,
      }],
    })).toBeNull()
  })

  it.each([
    ['not an object', null, 'JSON object'],
    ['wrong format', { ...recipe([{ source: { type: 'sine', freqHz: 60 } }]), format: 'x' }, 'format'],
    ['bad sample rate', { ...recipe([{ source: { type: 'sine', freqHz: 60 } }]), sampleRate: 22050 }, 'sampleRate'],
    ['too long', recipe([{ source: { type: 'sine', freqHz: 60 } }], 31), 'durationSec'],
    ['non-integer seed', recipe([{ source: { type: 'sine', freqHz: 60 } }], 1, 1.5), 'seed'],
    ['no layers', recipe([]), 'layers'],
    ['too many layers', recipe(Array.from({ length: 9 }, () => ({ source: { type: 'sine' as const, freqHz: 60 } }))), 'layers'],
    ['unknown source', recipe([{ source: { type: 'granular' } as never }]), 'source.type'],
    ['frequency out of range', recipe([{ source: { type: 'sine', freqHz: 3000 } }]), 'freqHz'],
    ['unknown field', recipe([{ source: { type: 'sine', freqHz: 60, freqEnd: 40 } as never }]), 'freqEnd'],
    ['inverted noise band', recipe([{ source: { type: 'noise', color: 'white', lowHz: 300, highHz: 200 } }]), 'highHz'],
    ['missing pulse', recipe([{ source: { type: 'impulse-train', rateHz: 10 } as never }]), 'pulse'],
    ['am seed is derived', recipe([{ source: { type: 'sine', freqHz: 60 }, am: { rateHz: 5, depth: 0.5, shape: 'sine', seed: 3 } as never }]), 'seed'],
    ['bad envelope', recipe([{ source: { type: 'sine', freqHz: 60 }, envelope: [{ time: 0, value: 1 }, { time: 0.5, value: 1 }] }]), 'envelope'],
    ['start after end', recipe([{ source: { type: 'sine', freqHz: 60 }, startSec: 1 }]), 'startSec'],
    ['gain out of range', recipe([{ source: { type: 'sine', freqHz: 60 }, gainDb: 20 }]), 'gainDb'],
  ])('rejects %s', (_label, value, fragment) => {
    const error = validateRecipe(value)
    expect(error).toBeTypeOf('string')
    expect(error).toContain(fragment)
  })
})

describe('renderRecipe', () => {
  it('is fully deterministic and depends on the seed', () => {
    const r = RECIPE_PRESETS.find(p => p.id === 'gowagowa')!.recipe
    const a = renderRecipe(r), b = renderRecipe(JSON.parse(JSON.stringify(r)))
    expect(a.data).toEqual(b.data)
    expect(a.sampleRate).toBe(48000)
    expect(a.data.length).toBe(72000)
    expect(renderRecipe({ ...r, seed: 2 }).data).not.toEqual(a.data)
  })

  it('renders the requested sine frequency and exponential sweep', () => {
    const { data } = renderRecipe(recipe([{ source: { type: 'sine', freqHz: 100 } }]))
    expect(risingCrossings(data, 0, 48000)).toBeGreaterThanOrEqual(99)
    expect(risingCrossings(data, 0, 48000)).toBeLessThanOrEqual(101)
    const sweep = renderRecipe(recipe([{ source: { type: 'sine', freqHz: 200, freqEndHz: 50 } }])).data
    const first = risingCrossings(sweep, 0, 4800), last = risingCrossings(sweep, 43200, 48000)
    // 200 → 50 Hz exponentially: ~187 Hz average over the first 100 ms, ~51 Hz over the last.
    expect(first).toBeGreaterThanOrEqual(17)
    expect(last).toBeLessThanOrEqual(6)
  })

  it('decaying sine falls to 1/e after decayMs', () => {
    const { data } = renderRecipe(recipe([{ source: { type: 'decaying-sine', freqHz: 50, decayMs: 100 }, fadeMs: 0 }], 0.5))
    const early = peak(data, 0, 960) // one 20 ms period at t≈5 ms
    const late = peak(data, 4800, 5760) // one period at t≈105 ms
    expect(late / early).toBeGreaterThan(0.33)
    expect(late / early).toBeLessThan(0.41)
  })

  it('impulse train places rateHz × duration pulses without jitter', () => {
    expect(impulseOnsets(48000, 48000, 20, 0, mulberry32(1))).toHaveLength(20)
    const { data } = renderRecipe(recipe([{ source: { type: 'impulse-train', rateHz: 20, pulse: { freqHz: 400, decayMs: 2 } }, fadeMs: 0 }]))
    let pulses = 0, quiet = 0, armed = true
    for (let i = 0; i < data.length; i++) {
      const level = Math.abs(data[i])
      if (level < 0.01) { quiet++; if (quiet > 480) armed = true } else quiet = 0
      if (level > 0.3 && armed) { pulses++; armed = false }
    }
    expect(pulses).toBe(20)
    const jittered = impulseOnsets(48000, 48000, 20, 0.5, mulberry32(1))
    expect(jittered.length).toBeGreaterThan(10)
    expect(jittered).toEqual(impulseOnsets(48000, 48000, 20, 0.5, mulberry32(1)))
  })

  it('honours layer timing and fades', () => {
    const { data } = renderRecipe(recipe([{ source: { type: 'sine', freqHz: 100 }, startSec: 0.5, durationSec: 0.25 }]))
    expect(peak(data, 0, 24000)).toBe(0)
    expect(peak(data, 24000, 36000)).toBeGreaterThan(0.9)
    expect(peak(data, 36000)).toBe(0)
    expect(Math.abs(data[24000])).toBeLessThan(1e-3)
  })

  it('normalises an overloaded mix to 0.98 and reports the change', () => {
    const quiet = renderRecipe(recipe([{ source: { type: 'sine', freqHz: 100 }, gainDb: -6 }]))
    expect(quiet.normalizedDb).toBeUndefined()
    const loud = renderRecipe(recipe([{ source: { type: 'sine', freqHz: 100 } }, { source: { type: 'sine', freqHz: 100 }, gainDb: 6 }]))
    expect(peak(loud.data)).toBeCloseTo(0.98, 3)
    expect(loud.normalizedDb).toBeLessThan(-9)
  })
})

describe('sample layers', () => {
  const file = { kind: 'file' as const, path: 'sources/tap.wav' }
  const constant = (n: number, v = 0.5) => new Float32Array(n).fill(v)
  const samples = (data: Float32Array, sampleRate = 48000, key = 'file:sources/tap.wav') => new Map([[key, { data, sampleRate }]])
  const fakeBuffer = (channels: Float32Array[], sampleRate: number) => ({ numberOfChannels: channels.length, sampleRate, getChannelData: (ch: number) => channels[ch] }) as unknown as AudioBuffer

  it('validates the documented example and every optional field', () => {
    expect(validateRecipe({ format: 'hapbeat-recipe@1', sampleRate: 48000, durationSec: 0.4, seed: 1, layers: [
      { source: { type: 'sample', ref: file, onsetsSec: [0, 0.15], gainsDb: [0, -3], maxSec: 0.08 } },
      { source: { type: 'sine', freqHz: 60 }, durationSec: 0.25, gainDb: -6, envelope: [{ time: 0, value: 1 }, { time: 1, value: 0 }] },
    ] })).toBeNull()
    expect(validateRecipe(recipe([{ source: { type: 'sample', ref: { kind: 'clip', clipId: 'c1', use: 'working' }, rate: 0.25 } }]))).toBeNull()
    expect(validateRecipe(recipe([{ source: { type: 'sample', ref: { kind: 'clip', clipId: 'c1' }, rate: 4, gainsDb: [-60] } }]))).toBeNull()
  })

  it.each([
    ['unknown sample field', { type: 'sample', ref: file, loop: true }, 'loop'],
    ['missing ref', { type: 'sample' }, 'ref'],
    ['unsafe path', { type: 'sample', ref: { kind: 'file', path: '../x.wav' } }, 'ref.path'],
    ['unknown ref field', { type: 'sample', ref: { ...file, use: 'working' } }, 'use'],
    ['unknown ref kind', { type: 'sample', ref: { kind: 'url', path: 'x' } }, 'ref.kind'],
    ['empty clip id', { type: 'sample', ref: { kind: 'clip', clipId: '' } }, 'clipId'],
    ['bad clip use', { type: 'sample', ref: { kind: 'clip', clipId: 'c1', use: 'rendered' } }, 'use'],
    ['rate out of range', { type: 'sample', ref: file, rate: 5 }, 'rate'],
    ['maxSec out of range', { type: 'sample', ref: file, maxSec: 0 }, 'maxSec'],
    ['empty onsets', { type: 'sample', ref: file, onsetsSec: [] }, 'onsetsSec'],
    ['too many onsets', { type: 'sample', ref: file, onsetsSec: Array.from({ length: 65 }, (_, i) => i / 100) }, 'onsetsSec'],
    ['negative onset', { type: 'sample', ref: file, onsetsSec: [-0.1] }, 'onsetsSec[0]'],
    ['decreasing onsets', { type: 'sample', ref: file, onsetsSec: [0.2, 0.1] }, 'non-decreasing'],
    ['gain count mismatch', { type: 'sample', ref: file, onsetsSec: [0, 0.1], gainsDb: [0] }, 'gainsDb'],
    ['gain count without onsets', { type: 'sample', ref: file, gainsDb: [0, 0] }, 'gainsDb'],
    ['gain out of range', { type: 'sample', ref: file, onsetsSec: [0, 0.1], gainsDb: [0, 13] }, 'gainsDb[1]'],
  ])('rejects %s', (_label, source, fragment) => {
    const error = validateRecipe(recipe([{ source: source as never }]))
    expect(error).toBeTypeOf('string')
    expect(error).toContain(fragment)
  })

  it('places a copy at each onset with its gain and cuts each copy at maxSec', () => {
    const r = recipe([{ source: { type: 'sample', ref: file, onsetsSec: [0, 0.1], gainsDb: [0, -6], maxSec: 0.005 }, fadeMs: 0 }])
    const { data } = renderRecipe(r, samples(constant(480)))
    expect(peak(data, 0, 240)).toBeCloseTo(0.5, 6)
    expect(Math.abs(data[0])).toBeCloseTo(0.5, 6)
    expect(peak(data, 240, 4800)).toBe(0)
    expect(data[4800]).toBeCloseTo(0.5 * 10 ** (-6 / 20), 6)
    expect(data[5039]).toBeCloseTo(0.5 * 10 ** (-6 / 20), 6)
    expect(peak(data, 5040)).toBe(0)
    expect(renderRecipe(r, samples(constant(480))).data).toEqual(data)
  })

  it('fades out at the cut, sums overlapping copies and clips copies at the layer end', () => {
    const cut = renderRecipe(recipe([{ source: { type: 'sample', ref: file, onsetsSec: [0.1], maxSec: 0.005 }, fadeMs: 1 }]), samples(constant(480))).data
    expect(cut[4800 + 239]).toBe(0)
    expect(cut[4800 + 239 - 24]).toBeCloseTo(0.25, 6)
    const overlap = renderRecipe(recipe([{ source: { type: 'sample', ref: file, onsetsSec: [0.1, 0.1] }, fadeMs: 0 }]), samples(constant(480))).data
    expect(overlap[4900]).toBeCloseTo(1, 6)
    const late = renderRecipe(recipe([{ source: { type: 'sample', ref: file, onsetsSec: [0.98] }, durationSec: 0.985, fadeMs: 0 }]), samples(constant(960))).data
    expect(late).toHaveLength(48000)
    expect(peak(late, 47040, 47280)).toBeCloseTo(0.5, 6)
    expect(peak(late, 47280)).toBe(0)
  })

  it('resamples to the recipe rate including the playback rate', () => {
    const nonZero = (data: Float32Array) => data.reduce((n, v) => n + (v !== 0 ? 1 : 0), 0)
    const at = (rate: number) => renderRecipe(recipe([{ source: { type: 'sample', ref: file, rate }, fadeMs: 0 }]), samples(constant(1600), 16000)).data
    // Linear interpolation ends at the last source sample, so the length may fall short by under one source sample.
    expect(Math.abs(nonZero(at(1)) - 4800)).toBeLessThanOrEqual(3)
    expect(Math.abs(nonZero(at(2)) - 2400)).toBeLessThanOrEqual(3)
    expect(Math.abs(nonZero(at(0.5)) - 9600)).toBeLessThanOrEqual(6)
  })

  it('throws when a sample ref was not loaded', () => {
    expect(() => renderRecipe(recipe([{ source: { type: 'sample', ref: file } }]))).toThrow(/sources\/tap\.wav/)
    expect(() => renderRecipe(recipe([{ source: { type: 'sample', ref: { kind: 'clip', clipId: 'c1' } } }]), samples(constant(10)))).toThrow(/clip:c1:original/)
  })

  it('loads each ref once, mixed to mono', async () => {
    const reads: string[] = []
    const loaded = await loadRecipeSamples(recipe([
      { source: { type: 'sample', ref: file } },
      { source: { type: 'sample', ref: file, rate: 2 } },
      { source: { type: 'sample', ref: { kind: 'clip', clipId: 'c1', use: 'working' } } },
      { source: { type: 'sine', freqHz: 60 } },
    ]), {
      readAgentFile: async path => { reads.push(path); return new ArrayBuffer(4) },
      decodeAudio: async () => fakeBuffer([Float32Array.from([1, 0]), Float32Array.from([0, 1])], 16000),
      getClip: (id, use) => id === 'c1' && use === 'working' ? fakeBuffer([Float32Array.from([0.25])], 48000) : null,
    })
    expect(reads).toEqual(['sources/tap.wav'])
    expect([...loaded.keys()]).toEqual(['file:sources/tap.wav', 'clip:c1:working'])
    expect(Array.from(loaded.get('file:sources/tap.wav')!.data)).toEqual([0.5, 0.5])
    expect(loaded.get('file:sources/tap.wav')!.sampleRate).toBe(16000)
    await expect(loadRecipeSamples(recipe([{ source: { type: 'sample', ref: { kind: 'clip', clipId: 'gone' } } }]), {
      readAgentFile: async () => new ArrayBuffer(0), decodeAudio: async () => fakeBuffer([new Float32Array(1)], 48000), getClip: () => null,
    })).rejects.toThrow(/"gone" is not in the editor/)
  })
})
