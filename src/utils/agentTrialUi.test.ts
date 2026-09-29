import { describe, expect, it } from 'vitest'
import type { EffectParams } from '@/types/waveform'
import { ratingError, type RatingBody, type TrialRequest } from './agentProtocol'
import { derivedEffectChain, formToRating, ratingFormIssue, ratingToForm } from './agentTrialUi'

const trial: TrialRequest = {
  format: 'hapbeat-trial@1', id: 't1', intent: 'modify', prompt: 'p', terms: ['ごわごわ', 'ざらざら'],
  candidates: [
    { id: 'A', label: 'a', source: { kind: 'clip', clipId: 'c' }, effects: [] },
    { id: 'B', label: 'b', source: { kind: 'clip', clipId: 'c' }, effects: [] },
  ],
}

describe('derived clip effect chain', () => {
  it('creates enabled, unapplied entries with fresh ids and copied params', () => {
    const effects: EffectParams[] = [{ type: 'lpf', frequency: 200, Q: 0.7 }, { type: 'gain', gainDb: -3 }]
    let n = 0
    const chain = derivedEffectChain(effects, () => `id${n++}`)
    expect(chain).toEqual([
      { id: 'id0', params: { type: 'lpf', frequency: 200, Q: 0.7 }, enabled: true, applied: false },
      { id: 'id1', params: { type: 'gain', gainDb: -3 }, enabled: true, applied: false },
    ])
    expect(chain[0].params).not.toBe(effects[0])
  })
})

describe('rating form', () => {
  it('requires at least one overall score and an overall for every touched candidate', () => {
    const form = ratingToForm(trial, null)
    expect(ratingFormIssue(form)).toEqual({ kind: 'none-rated' })
    form.candidates.B.comment = 'too light'
    expect(ratingFormIssue(form)).toEqual({ kind: 'missing-overall', candidateId: 'B' })
    form.candidates.B.overall = 3
    expect(ratingFormIssue(form)).toBeNull()
  })

  it('omits unrated candidates and unset fields, and passes protocol validation', () => {
    const form = ratingToForm(trial, null, { device: 'Band 1', position: '', volume: '', note: '' })
    form.candidates.A = { overall: 4, termMatch: { ごわごわ: -1 }, directions: { roughness: 1 }, comment: '  ok  ' }
    form.best = 'A'
    form.context.position = ' neck '
    const body = formToRating(form, trial, '2026-09-29T15:42:00+09:00')
    expect(body).toEqual({
      format: 'hapbeat-rating@1', trialId: 't1', ratedAt: '2026-09-29T15:42:00+09:00',
      context: { device: 'Band 1', position: 'neck' }, best: 'A',
      candidates: { A: { overall: 4, termMatch: { ごわごわ: -1 }, directions: { roughness: 1 }, comment: 'ok' } },
    })
    expect(ratingError(body, trial, ['roughness'])).toBeNull()
  })

  it('round-trips a saved rating and prefers its context over the remembered one', () => {
    const saved: RatingBody = { format: 'hapbeat-rating@1', trialId: 't1', ratedAt: '2026-09-29T15:42:00+09:00', context: { position: 'wrist' }, best: 'B',
      candidates: { B: { overall: 2, termMatch: { ざらざら: 1 }, comment: 'harsh' } } }
    const form = ratingToForm(trial, saved, { device: 'other', position: 'neck', volume: '', note: '' })
    expect(form.context).toEqual({ device: '', position: 'wrist', volume: '', note: '' })
    expect(form.candidates.A.overall).toBeNull()
    expect(formToRating(form, trial, saved.ratedAt)).toEqual(saved)
  })
})
