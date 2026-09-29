import { describe, expect, it } from 'vitest'
import { impulseOnsets, RECIPE_PRESETS, renderRecipe, validateRecipe, type Recipe, type RecipeLayer } from './recipe'
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
