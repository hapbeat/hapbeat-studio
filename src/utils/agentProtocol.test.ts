import { describe, expect, it } from 'vitest'
import { normalizeTerm, parseTrialRequest, ratingError, termSlug, type RatingBody, type TrialRequest } from './agentProtocol'
import { isSafeAgentPath } from './recipe'

const request = (patch: Record<string, unknown> = {}, candidate: Record<string, unknown> = {}) => JSON.stringify({
  format: 'hapbeat-trial@1', id: 't-01', intent: 'modify', prompt: 'もっとゴワゴワに', terms: ['ごわごわ'],
  candidates: [{ id: 'A', label: 'LPF', source: { kind: 'clip', clipId: 'c1' }, effects: [{ type: 'lpf', frequency: 200, Q: 0.7 }], ...candidate }],
  ...patch,
})

describe('agentProtocol', () => {
  it('accepts a valid request', () => {
    const result = parseTrialRequest(request(), 't-01')
    expect(result.ok).toBe(true)
  })

  it('rejects with readable reasons', () => {
    const error = (text: string, id = 't-01') => { const r = parseTrialRequest(text, id); return r.ok ? null : r.error }
    expect(error('{')).toMatch(/Invalid JSON/)
    expect(error(request(), 'other')).toMatch(/file name/)
    expect(error(request({ format: 'x' }))).toMatch(/format/)
    expect(error(request({ terms: [] }))).toMatch(/terms/)
    expect(error(request({ candidates: [] }))).toMatch(/1-6/)
    expect(error(request({}, { effects: [{ type: 'lpf', frequency: 5, Q: 0.7 }] }))).toMatch(/effects\[0\]/)
    expect(error(request({}, { effects: [{ type: 'explode' }] }))).toMatch(/effects\[0\]/)
    expect(error(request({}, { source: { kind: 'file', path: '../secret.wav' } }))).toMatch(/relative path/)
    expect(error(request({}, { source: { kind: 'recipe', recipe: { format: 'nope' } } }))).toMatch(/recipe/)
    expect(error(request({ candidates: [JSON.parse(request()).candidates[0], JSON.parse(request()).candidates[0]] }))).toMatch(/duplicated/)
  })

  it('accepts an optional kind', () => {
    const ok = parseTrialRequest(request({ kind: 'loop' }), 't-01')
    expect(ok.ok && ok.trial.kind).toBe('loop')
    const bad = parseTrialRequest(request({ kind: 'burst' }), 't-01')
    expect(bad.ok ? null : bad.error).toMatch(/kind/)
  })

  it('accepts an optional game scene and rejects malformed ones', () => {
    const result = parseTrialRequest(request({ scene: { project: 'trex-encounter', cues: ['roar', 'roar_impact'] } }), 't-01')
    expect(result.ok && result.trial.scene).toEqual({ project: 'trex-encounter', cues: ['roar', 'roar_impact'] })
    for (const bad of [{}, { project: 'x', cues: [] }, { project: '', cues: ['a'] }, { project: 'x', cues: ['a b'] }, { project: 'x', cues: 'roar' }, 'roar']) {
      const r = parseTrialRequest(request({ scene: bad }), 't-01')
      expect(r.ok ? null : r.error).toMatch(/scene/)
    }
  })

  it('accepts an optional project label and rejects malformed ones', () => {
    const result = parseTrialRequest(request({ project: 'Cloth textures' }), 't-01')
    expect(result.ok && result.trial.project).toBe('Cloth textures')
    for (const bad of ['', ' x', 'x'.repeat(81), 1]) {
      const r = parseTrialRequest(request({ project: bad }), 't-01')
      expect(r.ok ? null : r.error).toMatch(/project/)
    }
  })

  it('validates file paths', () => {
    expect(isSafeAgentPath('sources/rain.wav')).toBe(true)
    for (const bad of ['/abs.wav', 'C:/x.wav', 'a\\b.wav', 'sources/../x.wav', './x.wav', 'a//b.wav', '']) expect(isSafeAgentPath(bad)).toBe(false)
  })

  it('normalizes vocabulary', () => {
    expect(normalizeTerm(' ゴワゴワ ')).toBe('ごわごわ')
    expect(normalizeTerm('ｺﾞﾜｺﾞﾜ')).toBe('ごわごわ')
    expect(termSlug('a/b:c')).toBe('a_b_c')
    expect(termSlug('...')).toBe('_')
  })

  it('validates ratings against the trial', () => {
    const trial = JSON.parse(request()) as TrialRequest
    const rating: RatingBody = { format: 'hapbeat-rating@1', trialId: 't-01', ratedAt: '2026-09-29T15:42:00+09:00', best: 'A', candidates: { A: { overall: 4, termMatch: { ごわごわ: 0 }, directions: { roughness: 1 } } } }
    expect(ratingError(rating, trial, ['roughness'])).toBeNull()
    expect(ratingError({ ...rating, best: 'Z' }, trial, ['roughness'])).toMatch(/best/)
    expect(ratingError({ ...rating, candidates: { A: { overall: 6 } } }, trial, [])).toMatch(/overall/)
    expect(ratingError({ ...rating, candidates: { A: { overall: 3, directions: { weight: 1 } } } }, trial, ['roughness'])).toMatch(/direction/)
    expect(ratingError({ ...rating, context: { volumeWiper: 128, volumeLabel: '5/10' } }, trial, ['roughness'])).toBeNull()
    expect(ratingError({ ...rating, context: { volumeWiper: 300 } }, trial, [])).toMatch(/volumeWiper/)
    expect(ratingError({ ...rating, context: { volumeWiper: 1.5 } }, trial, [])).toMatch(/volumeWiper/)
    expect(ratingError({ ...rating, context: { volume: '5' } as never }, trial, [])).toMatch(/volume/)
    expect(ratingError({ ...rating, othersSimilar: true }, trial, ['roughness'])).toBeNull()
    expect(ratingError({ ...rating, best: undefined, othersSimilar: true }, trial, ['roughness'])).toMatch(/othersSimilar/)
  })
})
