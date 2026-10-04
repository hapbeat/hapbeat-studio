import { describe, expect, it } from 'vitest'
import type { EffectParams } from '@/types/waveform'
import { ratingError, type RatingBody, type TrialRequest } from './agentProtocol'
import { autoRatingContext, derivedEffectChain, parseWiper, formToRating, jaPolePhrase, ratingFormIssue, ratingToForm, trialKind, visibleDimensions } from './agentTrialUi'
import type { DeviceInfo } from '@/types/manager'

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
    const form = ratingToForm(trial, null, { device: 'Band 1', position: '', deviceWiper: '96', volumeLabel: '', note: '' })
    form.candidates.A = { overall: 4, termMatch: { ごわごわ: -1 }, directions: { roughness: 1 }, comment: '  ok  ' }
    form.best = 'A'
    form.context.position = ' neck '
    const body = formToRating(form, trial, '2026-09-29T15:42:00+09:00')
    expect(body).toEqual({
      format: 'hapbeat-rating@1', trialId: 't1', ratedAt: '2026-09-29T15:42:00+09:00',
      context: { device: 'Band 1', position: 'neck', deviceWiper: 96 }, best: 'A',
      candidates: { A: { overall: 4, termMatch: { ごわごわ: -1 }, directions: { roughness: 1 }, comment: 'ok' } },
    })
    expect(ratingError(body, trial, ['roughness'])).toBeNull()
  })

  it('round-trips a saved rating and prefers its context over the remembered one', () => {
    const saved: RatingBody = { format: 'hapbeat-rating@1', trialId: 't1', ratedAt: '2026-09-29T15:42:00+09:00', context: { position: 'wrist' }, best: 'B',
      candidates: { B: { overall: 2, termMatch: { ざらざら: 1 }, comment: 'harsh' } } }
    const form = ratingToForm(trial, saved, { device: 'other', position: 'neck', deviceWiper: '', volumeLabel: '', note: '' })
    expect(form.context).toEqual({ device: '', position: 'wrist', deviceWiper: '', volumeLabel: '', note: '' })
    expect(form.candidates.A.overall).toBeNull()
    expect(formToRating(form, trial, saved.ratedAt)).toEqual(saved)
  })
})

describe('trial kind and rating wording', () => {
  it('uses the explicit kind, else a loop scene cue, else the candidate lengths', () => {
    expect(trialKind({ kind: 'sequence' }, [0.2])).toBe('sequence')
    expect(trialKind({ scene: { project: 'p', cues: ['hold'] } }, [3], ['hold', 'rub'])).toBe('loop')
    expect(trialKind({}, [0.4, 1.2])).toBe('oneshot')
    expect(trialKind({}, [0.4, 3])).toBeNull()
    expect(trialKind({}, [null, undefined])).toBeNull()
  })

  it('hides the repetition dimensions for one-shots only', () => {
    const dims = [{ id: 'weight' }, { id: 'regularity' }, { id: 'continuity' }]
    expect(visibleDimensions(dims, 'oneshot').map(d => d.id)).toEqual(['weight'])
    expect(visibleDimensions(dims, 'loop')).toHaveLength(3)
    expect(visibleDimensions(dims, null)).toHaveLength(3)
  })

  it('turns pole words into natural 「もっと…」 phrases', () => {
    expect(['粗い', '重い', '滑らか', '不快', '快', '規則的', '断続', '連続'].map(jaPolePhrase))
      .toEqual(['粗く', '重く', '滑らかに', '不快に', '心地よく', '規則的に', '途切れがちに', '途切れなく'])
  })

  it('fills device names and the volume wiper from the helper, empty when unknown', () => {
    const dev = (ip: string, name: string, wiper: number | null, level: number | null, steps: number | null) => ({ ipAddress: ip, name, volumeWiper: wiper, volumeLevel: level, volumeSteps: steps }) as DeviceInfo
    expect(autoRatingContext([dev('a', 'neck', 64, 5, 10), dev('b', 'wrist', 64, 5, 10)], ['a', 'b'])).toEqual({ device: 'neck, wrist', deviceWiper: 64, volumeLabel: '5/10' })
    expect(autoRatingContext([dev('a', 'neck', 64, null, null)], ['a'])).toEqual({ device: 'neck', deviceWiper: 64, volumeLabel: '' })
    expect(autoRatingContext([dev('a', 'neck', 64, 5, 10), dev('b', 'wrist', 80, 6, 10)], ['a', 'b']).deviceWiper).toBeNull()
    expect(autoRatingContext([], [])).toEqual({ device: '', deviceWiper: null, volumeLabel: '' })
  })

  it('lets "others similar" save with only the best rated, and checks the wiper', () => {
    const form = ratingToForm(trial, null)
    form.othersSimilar = true
    expect(ratingFormIssue(form)).toEqual({ kind: 'similar-needs-best' })
    form.best = 'A'; form.candidates.A.overall = 4
    expect(ratingFormIssue(form)).toBeNull()
    const body = formToRating(form, trial, '2026-09-29T15:42:00+09:00')
    expect(body.othersSimilar).toBe(true)
    expect(Object.keys(body.candidates)).toEqual(['A'])
    expect(ratingError(body, trial, [])).toBeNull()
    form.context.deviceWiper = '128'
    expect(ratingFormIssue(form)).toEqual({ kind: 'bad-wiper' })
    expect(parseWiper(' 100 ')).toBe(100)
  })
})
