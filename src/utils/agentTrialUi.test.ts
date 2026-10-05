import { describe, expect, it } from 'vitest'
import type { EffectParams } from '@/types/waveform'
import { ratingError, type RatingBody, type TrialRequest } from './agentProtocol'
import { autoRatingContext, derivedEffectChain, parseWiper, formToRating, ratingFormIssue, ratingToForm, trialKind } from './agentTrialUi'
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
  it('saves with any score or comment; a candidate without stars is saved as "no score"', () => {
    const form = ratingToForm(trial, null)
    expect(ratingFormIssue(form)).toEqual({ kind: 'none-rated' })
    form.candidates.B.comment = 'too light'
    expect(ratingFormIssue(form)).toBeNull()
    const body = formToRating(form, trial, '2026-10-05T10:00:00+09:00')
    expect(body.candidates).toEqual({ B: { comment: 'too light' } })
    expect(ratingError(body, trial, [])).toBeNull()
    expect(ratingToForm(trial, body).candidates.B.overall).toBeNull()
    // The trial-level comment alone is enough, and is saved / restored.
    const only = ratingToForm(trial, null)
    only.comment = '  B is closest, heavier '
    expect(ratingFormIssue(only)).toBeNull()
    const trialBody = formToRating(only, trial, '2026-10-05T10:00:00+09:00')
    expect(trialBody.comment).toBe('B is closest, heavier')
    expect(trialBody.candidates).toEqual({})
    expect(ratingToForm(trial, trialBody).comment).toBe('B is closest, heavier')
    expect(ratingError({ ...trialBody, candidates: { A: {} } }, trial, [])).toMatch(/overall score or a comment/)
    expect(ratingError({ ...trialBody, comment: 'x'.repeat(4001) }, trial, [])).toMatch(/comment/)
  })

  it('omits unrated candidates and unset fields, and passes protocol validation', () => {
    const form = ratingToForm(trial, null, { device: 'Band 1', position: '', deviceWiper: '96', volumeLabel: '', note: '' })
    form.candidates.A = { overall: 4, termMatch: { ごわごわ: -1 }, directions: { roughness: 1 }, comment: '  ok  ', useRange: [], verdict: 'use', useFor: '' }
    form.context.position = ' neck '
    const body = formToRating(form, trial, '2026-09-29T15:42:00+09:00')
    expect(body).toEqual({
      format: 'hapbeat-rating@1', trialId: 't1', ratedAt: '2026-09-29T15:42:00+09:00',
      context: { device: 'Band 1', position: 'neck', deviceWiper: 96 }, best: 'A',
      candidates: { A: { overall: 4, termMatch: { ごわごわ: -1 }, directions: { roughness: 1 }, comment: 'ok', verdict: 'use' } },
    })
    expect(ratingError(body, trial, ['roughness'])).toBeNull()
  })

  it('round-trips a saved rating and prefers its context over the remembered one', () => {
    const saved: RatingBody = { format: 'hapbeat-rating@1', trialId: 't1', ratedAt: '2026-09-29T15:42:00+09:00', context: { position: 'wrist' }, best: 'B',
      candidates: { B: { overall: 5, termMatch: { ざらざら: 1 }, comment: 'harsh', verdict: 'use' } } }
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
    expect(trialKind({ scene: { project: 'p', cues: ['hold:slow'] } }, [3], ['hold', 'rub'])).toBe('loop')
    expect(trialKind({}, [0.4, 1.2])).toBe('oneshot')
    expect(trialKind({}, [0.4, 3])).toBeNull()
    expect(trialKind({}, [null, undefined])).toBeNull()
  })


  it('fills device names and the volume wiper from the helper, empty when unknown', () => {
    const dev = (ip: string, name: string, wiper: number | null, level: number | null, steps: number | null) => ({ ipAddress: ip, name, volumeWiper: wiper, volumeLevel: level, volumeSteps: steps }) as DeviceInfo
    expect(autoRatingContext([dev('a', 'neck', 64, 5, 10), dev('b', 'wrist', 64, 5, 10)], ['a', 'b'])).toEqual({ device: 'neck, wrist', deviceWiper: 64, volumeLabel: '5/10' })
    expect(autoRatingContext([dev('a', 'neck', 64, null, null)], ['a'])).toEqual({ device: 'neck', deviceWiper: 64, volumeLabel: '' })
    expect(autoRatingContext([dev('a', 'neck', 64, 5, 10), dev('b', 'wrist', 80, 6, 10)], ['a', 'b']).deviceWiper).toBeNull()
    expect(autoRatingContext([], [])).toEqual({ device: '', deviceWiper: null, volumeLabel: '' })
  })

  it('derives best from a unique top "use" candidate, and checks the wiper', async () => {
    const { autoBest } = await import('./agentTrialUi')
    const form = ratingToForm(trial, null)
    // The verdict follows the overall score (4–5 use, 3 maybe, 1–2 no); best = the unique top "use".
    form.candidates.A = { ...form.candidates.A, overall: 4 }
    form.candidates.B = { ...form.candidates.B, overall: 3 }
    expect(autoBest(form, ['A', 'B'])).toBe('A')
    const body = formToRating(form, trial, '2026-09-29T15:42:00+09:00')
    expect(body.best).toBe('A')
    expect([body.candidates.A.verdict, body.candidates.B.verdict]).toEqual(['use', 'maybe'])
    form.candidates.B.overall = 5
    expect(autoBest(form, ['A', 'B'])).toBe('B')
    form.candidates.B.overall = 4
    expect(autoBest(form, ['A', 'B'])).toBeNull() // tie
    expect(formToRating(form, trial, '2026-09-29T15:42:00+09:00').best).toBeUndefined()
    form.context.deviceWiper = '128'
    expect(ratingFormIssue(form)).toEqual({ kind: 'bad-wiper' })
    expect(parseWiper(' 100 ')).toBe(100)
  })
})

describe('use only this part (useRange)', () => {
  it('records sorted, rounded ranges, ignores duplicates / empty ones, and saves them', async () => {
    const { addUseRange } = await import('./agentTrialUi')
    let ranges = addUseRange([], 0.52345, 0.1)
    ranges = addUseRange(ranges, 0.1, 0.52345)
    ranges = addUseRange(ranges, 0.6, 0.6)
    ranges = addUseRange(ranges, 0.01, 0.05)
    expect(ranges).toEqual([[0.01, 0.05], [0.1, 0.523]])
    const form = ratingToForm(trial, null)
    form.candidates.A.useRange = ranges
    expect(ratingFormIssue(form)).toBeNull()
    form.candidates.A.overall = 4
    const body = formToRating(form, trial, '2026-10-05T10:00:00+09:00')
    expect(body.candidates.A.useRange).toEqual([[0.01, 0.05], [0.1, 0.523]])
    expect(ratingError(body, trial, [])).toBeNull()
    expect(ratingToForm(trial, body).candidates.A.useRange).toEqual([[0.01, 0.05], [0.1, 0.523]])
    expect(ratingError({ ...body, candidates: { A: { overall: 4, useRange: [[0.5, 0.2]] } } }, trial, [])).toMatch(/useRange/)
  })
})

describe('verdict / useFor (several usable candidates, best optional)', () => {
  it('saves verdict and useFor, validates them, and lists the usable candidates', async () => {
    const { usableCandidates } = await import('./agentTrialUi')
    const form = ratingToForm(trial, null)
    form.candidates.A = { ...form.candidates.A, overall: 4, verdict: 'use', useFor: '  idle growl ' }
    form.candidates.B = { ...form.candidates.B, overall: 5, verdict: 'no' } // the stored verdict is ignored: 5 → use
    expect(usableCandidates(form)).toEqual(['A', 'B'])
    const body = formToRating(form, trial, '2026-10-05T10:00:00+09:00')
    expect(body.best).toBe('B') // the unique top "use" (5 > 4)
    expect(body.candidates.A).toMatchObject({ verdict: 'use', useFor: 'idle growl' })
    expect(ratingError(body, trial, [])).toBeNull()
    expect(ratingToForm(trial, body).candidates.A).toMatchObject({ verdict: 'use', useFor: 'idle growl' })
    expect(ratingError({ ...body, candidates: { A: { overall: 4, verdict: 'great' as never } } }, trial, [])).toMatch(/verdict/)
    expect(ratingError({ ...body, candidates: { A: { overall: 4, useFor: 'x'.repeat(201) } } }, trial, [])).toMatch(/useFor/)
    // A verdict alone (it is derived from the stars) is not an input.
    const only = ratingToForm(trial, null)
    only.candidates.A.verdict = 'no'
    expect(ratingFormIssue(only)).toEqual({ kind: 'none-rated' })
  })
})

describe('sound trial axes', () => {
  it('rates weight / roughness / sharpness / strength / length / regularity, validated against the sound axes', async () => {
    const { SOUND_DIMENSIONS } = await import('./agentTrialUi')
    expect(SOUND_DIMENSIONS.map(d => d.id)).toEqual(['weight', 'roughness', 'sharpness', 'intensity', 'length', 'regularity'])
    const form = ratingToForm(trial, null)
    form.candidates.A = { ...form.candidates.A, overall: 4, directions: { length: -1 } }
    const body = formToRating(form, trial, '2026-10-05T10:00:00+09:00')
    expect(ratingError(body, trial, SOUND_DIMENSIONS.map(d => d.id))).toBeNull()
    expect(ratingError(body, trial, ['weight'])).toMatch(/direction/)
  })
})
