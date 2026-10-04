import { describe, expect, it } from 'vitest'
import { amplitudeEnvelope, bandSplit, detectOnsets } from './textureDsp'
import { loadRecipeSamples, renderRecipe, validateRecipe, type Recipe, type RecipeLayer } from './recipe'
import { parseTrialRequest } from './agentProtocol'
import { aggregateTerm, SEED_DIMENSIONS, type TrialRecord } from './hapticKnowledge'
import { validateEffectParams } from './editorFolder'
import { guideMarkdown } from './agentGuide'
import { RECIPE_RANGES } from './effectRanges'

/** Ways to make a haptic from a sound (method envelope / onset / bandsplit): DSP, recipe fields, method in trials and knowledge. */

const RATE = 48000
const sine = (freq: number, seconds: number, amplitude = 1) => Float32Array.from({ length: Math.round(seconds * RATE) }, (_, i) => amplitude * Math.sin((2 * Math.PI * freq * i) / RATE))
const rms = (d: Float32Array, from = 0, to = d.length) => { let s = 0; for (let i = from; i < to; i++) s += d[i] * d[i]; return Math.sqrt(s / Math.max(1, to - from)) }
/** Three 30 ms bursts of 1 kHz at 0.1 / 0.4 / 0.7 s (the middle one at half level) in 1 s of silence. */
function bursts(): Float32Array {
  const out = new Float32Array(RATE)
  for (const [t, a] of [[0.1, 1], [0.4, 0.5], [0.7, 1]] as const) {
    const start = Math.round(t * RATE), b = sine(1000, 0.03, a)
    out.set(b, start)
  }
  return out
}

describe('sound → haptic DSP', () => {
  it('amplitude envelope reads 1 for a full-scale sine and follows level changes', () => {
    const env = amplitudeEnvelope(Float32Array.from([...sine(200, 0.2), ...sine(200, 0.2, 0.25)]), RATE, 10)
    expect(env[Math.round(0.1 * RATE)]).toBeCloseTo(1, 1)
    expect(env[Math.round(0.3 * RATE)]).toBeCloseTo(0.25, 1)
  })

  it('detects the attacks of separate hits, with their relative level and a minimum gap', () => {
    const found = detectOnsets(bursts(), RATE, { thresholdDb: -30, minGapMs: 100, riseDb: 6 })
    expect(found.map(o => Math.round(o.index / RATE * 100) / 100)).toEqual([0.1, 0.4, 0.7])
    expect(found[1].level).toBeCloseTo(0.5, 1)
    expect(detectOnsets(bursts(), RATE, { thresholdDb: -3, minGapMs: 100, riseDb: 6 })).toHaveLength(2) // the half-level hit is below −3 dB
    expect(detectOnsets(bursts(), RATE, { thresholdDb: -30, minGapMs: 400, riseDb: 6 })).toHaveLength(2) // 0.1 s, then 0.7 s
    expect(detectOnsets(new Float32Array(1000), RATE, { thresholdDb: -30, minGapMs: 100, riseDb: 6 })).toEqual([])
  })

  it('band split keeps the low band and turns the high band into its envelope on the carrier', () => {
    const low = sine(60, 0.5, 0.5), high = sine(2000, 0.5, 0.5)
    const [lowOut] = bandSplit([low], RATE, { crossoverHz: 150, carrierHz: 80, carrierShape: 'sine', highGainDb: 0, smoothMs: 10 })
    expect(rms(lowOut, RATE * 0.1, RATE * 0.4)).toBeCloseTo(rms(low), 1)
    const [highOut] = bandSplit([high], RATE, { crossoverHz: 150, carrierHz: 80, carrierShape: 'sine', highGainDb: 0, smoothMs: 10 })
    // 0.5 amplitude envelope × full-scale 80 Hz carrier: RMS ≈ 0.5 / √2, and no 2 kHz left (zero crossings ≈ 2 × 80 per second).
    expect(rms(highOut, RATE * 0.1, RATE * 0.4)).toBeCloseTo(0.5 / Math.SQRT2, 1)
    let crossings = 0
    for (let i = RATE * 0.1 + 1; i < RATE * 0.4; i++) if (Math.sign(highOut[i]) !== Math.sign(highOut[i - 1])) crossings++
    expect(crossings).toBeGreaterThan(40)
    expect(crossings).toBeLessThan(56)
    const [quiet] = bandSplit([high], RATE, { crossoverHz: 150, carrierHz: 80, carrierShape: 'sine', highGainDb: -20, smoothMs: 10 })
    expect(rms(quiet, RATE * 0.1, RATE * 0.4)).toBeCloseTo(0.5 / Math.SQRT2 / 10, 2)
    expect(validateEffectParams({ type: 'band-split', crossoverHz: 150, carrierHz: 80, carrierShape: 'sine', highGainDb: 0, smoothMs: 10 })).toBe(true)
    expect(validateEffectParams({ type: 'band-split', crossoverHz: 1000, carrierHz: 80, carrierShape: 'sine', highGainDb: 0, smoothMs: 10 })).toBe(false)
  })
})

describe('recipe sample follow / onsets', () => {
  const file = { kind: 'file' as const, path: 'sources/steps.wav' }
  const recipe = (layers: RecipeLayer[]): Recipe => ({ format: 'hapbeat-recipe@1', sampleRate: 48000, durationSec: 1, seed: 1, layers })
  const samples = new Map([['file:sources/steps.wav', { data: bursts(), sampleRate: RATE }]])

  it('validates follow and onsets', () => {
    const ok = recipe([
      { source: { type: 'sample', ref: file, follow: { mode: 'envelope', smoothMs: 15, carrier: { type: 'sine', freqHz: 70 } } } },
      { source: { type: 'sample', ref: file, onsets: { auto: { thresholdDb: -30, minGapMs: 100 }, hit: { type: 'decaying-sine', freqHz: 60, decayMs: 40 }, hitSec: 0.1 } } },
      { source: { type: 'sample', ref: file, onsets: { auto: { thresholdDb: -30, minGapMs: 100, riseDb: 10 }, hit: { kind: 'clip', clipId: 'tap' } } } },
    ])
    expect(validateRecipe(ok)).toBeNull()
    const bad = (source: Record<string, unknown>) => validateRecipe(recipe([{ source: { type: 'sample', ref: file, ...source } as never }]))
    expect(bad({ follow: { mode: 'envelope', carrier: { type: 'impulse-train', rateHz: 5, pulse: { freqHz: 60, decayMs: 10 } } } })).toMatch(/carrier.type/)
    expect(bad({ follow: { mode: 'rms', carrier: { type: 'sine', freqHz: 70 } } })).toMatch(/follow.mode/)
    expect(bad({ follow: { mode: 'envelope' } })).toMatch(/carrier is required/)
    expect(bad({ onsets: { auto: { thresholdDb: -30 }, hit: { type: 'sine', freqHz: 60 } } })).toMatch(/minGapMs is required/)
    expect(bad({ onsets: { auto: { thresholdDb: -30, minGapMs: 100 } } })).toMatch(/hit is required/)
    expect(bad({ onsets: { auto: { thresholdDb: -30, minGapMs: 100 }, hit: { type: 'sine', freqHz: 60 } }, onsetsSec: [0] })).toMatch(/cannot be combined/)
    expect(bad({ onsets: { auto: { thresholdDb: -30, minGapMs: 100 }, hit: { type: 'sine', freqHz: 60 } }, follow: { mode: 'envelope', carrier: { type: 'sine', freqHz: 60 } } })).toMatch(/either follow or onsets/)
    expect(RECIPE_RANGES.sampleFollow.smoothMs.max).toBe(200)
  })

  it('follow: the sound\'s envelope on the carrier (silent between hits, carrier frequency inside)', () => {
    const { data } = renderRecipe(recipe([{ source: { type: 'sample', ref: file, follow: { mode: 'envelope', smoothMs: 10, carrier: { type: 'sine', freqHz: 70 } } } }]), samples)
    expect(rms(data, RATE * 0.105, RATE * 0.125)).toBeGreaterThan(0.4)
    expect(rms(data, RATE * 0.25, RATE * 0.35)).toBeLessThan(1e-3)
  })

  it('onsets: one hit per detected attack, scaled by its level; the material itself is not played', async () => {
    const r = recipe([{ source: { type: 'sample', ref: file, onsets: { auto: { thresholdDb: -30, minGapMs: 100 }, hit: { type: 'decaying-sine', freqHz: 60, decayMs: 30 }, hitSec: 0.15 } }, fadeMs: 0 }])
    const { data } = renderRecipe(r, samples)
    const near = (t: number) => rms(data, Math.round(t * RATE), Math.round((t + 0.05) * RATE))
    expect(near(0.1)).toBeGreaterThan(0.1)
    expect(near(0.4) / near(0.1)).toBeCloseTo(0.5, 1)
    expect(near(0.25)).toBeLessThan(1e-3)
    // A sample-ref hit is loaded with the material.
    const withClip = recipe([{ source: { type: 'sample', ref: file, onsets: { auto: { thresholdDb: -30, minGapMs: 100 }, hit: { kind: 'clip', clipId: 'tap' } } } }])
    const tap = { numberOfChannels: 1, sampleRate: RATE, getChannelData: () => sine(60, 0.05) } as unknown as AudioBuffer
    const loaded = await loadRecipeSamples(withClip, { readAgentFile: async () => new ArrayBuffer(0), decodeAudio: async () => ({ numberOfChannels: 1, sampleRate: RATE, getChannelData: () => bursts() }) as unknown as AudioBuffer, getClip: () => tap })
    expect([...loaded.keys()].sort()).toEqual(['clip:tap:original', 'file:sources/steps.wav'])
  })
})

describe('candidate method', () => {
  const request = (method: unknown) => JSON.stringify({
    format: 'hapbeat-trial@1', id: 't-1', intent: 'create', prompt: 'p', terms: ['どしん'],
    candidates: [{ id: 'A', label: 'a', method, source: { kind: 'clip', clipId: 'c' }, effects: [] }],
  })
  it('is optional and limited to the six ways', () => {
    expect(parseTrialRequest(request('onset'), 't-1').ok).toBe(true)
    expect(parseTrialRequest(request(undefined), 't-1').ok).toBe(true)
    const bad = parseTrialRequest(request('recorded'), 't-1')
    expect(bad.ok ? null : bad.error).toMatch(/method/)
  })

  it('knowledge counts good / too weak / too strong and the best example per method', () => {
    const at = '2026-10-05T10:00:00+09:00'
    const record: TrialRecord = {
      month: '2026-10',
      trial: { format: 'hapbeat-trial@1', id: 't1', intent: 'create', prompt: 'p', terms: ['どしん'], receivedAt: at, studioVersion: '0.8.1',
        candidates: [
          { id: 'A', label: 'a', method: 'onset', source: { kind: 'clip', clipId: 'c' }, effects: [] },
          { id: 'B', label: 'b', method: 'onset', source: { kind: 'clip', clipId: 'c' }, effects: [] },
          { id: 'C', label: 'c', method: 'synth', source: { kind: 'clip', clipId: 'c' }, effects: [] },
          { id: 'D', label: 'd', source: { kind: 'clip', clipId: 'c' }, effects: [] },
        ] },
      candidates: [],
      rating: { format: 'hapbeat-rating@1', trialId: 't1', ratedAt: at, history: [], candidates: {
        A: { overall: 5, termMatch: { 'どしん': 0 } }, B: { overall: 3, termMatch: { 'どしん': -2 } },
        C: { overall: 2, termMatch: { 'どしん': 2 } }, D: { overall: 3 },
      } },
    }
    const doc = aggregateTerm('どしん', SEED_DIMENSIONS, [record])
    expect(doc.byMethod.onset).toMatchObject({ rated: 2, good: 1, tooWeak: 1, tooStrong: 0 })
    expect(doc.byMethod.onset.best?.candidateId).toBe('A')
    expect(doc.byMethod.onset.best?.method).toBe('onset')
    expect(doc.byMethod.synth).toMatchObject({ rated: 1, good: 0, tooWeak: 0, tooStrong: 1 })
    expect(doc.byMethod.unspecified.rated).toBe(1)
  })

  it('the guide documents the six ways, the order of work and the new DSP', () => {
    const guide = guideMarkdown('test')
    for (const m of ['synth', 'sfx', 'envelope', 'layered', 'onset', 'bandsplit']) expect(guide).toContain(`\`${m}\``)
    expect(guide).toContain('Decide the event\'s sound first')
    expect(guide).toContain('DIFFERENT methods')
    expect(guide).toContain('"band-split"')
    expect(guide).toContain('`follow`')
    expect(guide).toContain('`onsets`')
  })
})
