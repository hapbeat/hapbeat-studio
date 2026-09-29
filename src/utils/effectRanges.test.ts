import { describe, expect, it } from 'vitest'
import { EFFECT_LABELS, getDefaultParams, type EffectType } from '@/types/waveform'
import { EFFECT_RANGES, inRange } from './effectRanges'
import { parseEditorIndex, validateEffectParams, validateEffects } from './editorFolder'
import { RECIPE_PRESETS } from './recipe'

const types = Object.keys(EFFECT_LABELS) as EffectType[]

describe('EFFECT_RANGES', () => {
  it('covers every scalar parameter of every effect default, and defaults validate', () => {
    for (const type of types) {
      const defaults = getDefaultParams(type)
      for (const [key, value] of Object.entries(defaults)) {
        if (key === 'type' || typeof value === 'object') continue
        expect(EFFECT_RANGES[type][key], `${type}.${key}`).toBeDefined()
      }
      expect(validateEffectParams(defaults), type).toBe(true)
    }
  })

  it('inRange handles numbers, integers, enums, booleans and value lists', () => {
    expect(inRange(5, { min: 0, max: 10 })).toBe(true)
    expect(inRange(11, { min: 0, max: 10 })).toBe(false)
    expect(inRange(Number.NaN, {})).toBe(false)
    expect(inRange(1.5, { kind: 'integer' })).toBe(false)
    expect(inRange('pink', { enum: ['white', 'pink'] })).toBe(true)
    expect(inRange('blue', { enum: ['white', 'pink'] })).toBe(false)
    expect(inRange(false, { kind: 'boolean' })).toBe(true)
    expect(inRange(0, { kind: 'boolean' })).toBe(false)
    expect(inRange(48000, { values: [16000, 48000] })).toBe(true)
    expect(inRange(22050, { values: [16000, 48000] })).toBe(false)
  })
})

describe('validateEffectParams', () => {
  it.each([
    [{ type: 'am', rateHz: 200, depth: 0.5, shape: 'sine', jitter: 0, seed: 1 }],
    [{ type: 'am', rateHz: 20, depth: 0.5, shape: 'saw', jitter: 0, seed: 1 }],
    [{ type: 'am', rateHz: 20, depth: 0.5, shape: 'sine', jitter: 0, seed: 1.5 }],
    [{ type: 'noise-mix', levelDb: -12, lowHz: 400, highHz: 300, color: 'white', follow: true, seed: 1 }],
    [{ type: 'noise-mix', levelDb: -12, lowHz: 40, highHz: 300, color: 'white', follow: 'yes', seed: 1 }],
    [{ type: 'freq-shift', shiftHz: 2000 }],
    [{ type: 'compressor', thresholdDb: -24, ratio: 0.5, attackMs: 5, releaseMs: 100, kneeDb: 6, makeupDb: 0 }],
    [{ type: 'saturate', driveDb: 6, mode: 'crush', mix: 1, outputDb: 0 }],
    [{ type: 'lpf', frequency: 10, Q: 1 }],
    [{ type: 'normalize', targetPeak: 0 }],
    [{ type: 'trim', start: 1, end: 1 }],
    [{ type: 'envelope', points: [{ time: 0, value: 1 }, { time: 0.5, value: 1 }] }],
    [{ type: 'eq', bands: [{ frequency: 1000, gain: 30, Q: 1 }] }],
    [{ type: 'granular' }],
    [null],
  ])('rejects %j', params => {
    expect(validateEffectParams(params)).toBe(false)
  })

  it('accepts in-range texture effects and entries wrap params', () => {
    expect(validateEffectParams({ type: 'am', rateHz: 18, depth: 0.8, shape: 'random', jitter: 0.4, seed: 2147483647 })).toBe(true)
    expect(validateEffectParams({ type: 'freq-shift', shiftHz: -1000 })).toBe(true)
    expect(validateEffects([{ id: 'a', enabled: true, params: getDefaultParams('compressor') }])).toBe(true)
    expect(validateEffects([{ id: 'a', enabled: 'yes', params: getDefaultParams('compressor') }])).toBe(false)
  })
})

describe('parseEditorIndex recipe field', () => {
  const clip = { id: 'c1', name: 'n', original: 'a.f32', working: 'b.f32', effects: [], exportSampleRate: 48000, exportAsMono: false }
  it('loads projects without and with a valid recipe', () => {
    expect(parseEditorIndex(JSON.stringify({ version: 1, revision: 'r', clips: [clip] })).clips[0].recipe).toBeUndefined()
    const recipe = RECIPE_PRESETS[0].recipe
    expect(parseEditorIndex(JSON.stringify({ version: 1, revision: 'r', clips: [{ ...clip, recipe }] })).clips[0].recipe).toEqual(recipe)
  })
  it('rejects an invalid recipe', () => {
    expect(() => parseEditorIndex(JSON.stringify({ version: 1, revision: 'r', clips: [{ ...clip, recipe: { format: 'x' } }] }))).toThrow()
  })
})
