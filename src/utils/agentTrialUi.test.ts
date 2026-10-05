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
  it('saves verdict and useFor and validates them', async () => {
    const form = ratingToForm(trial, null)
    form.candidates.A = { ...form.candidates.A, overall: 4, verdict: 'use', useFor: '  idle growl ' }
    form.candidates.B = { ...form.candidates.B, overall: 5, verdict: 'no' } // the stored verdict is ignored: 5 → use
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

describe('material pool on save', () => {
  it('adds every ★4+ candidate, best first, except free-plan output', async () => {
    const { poolCandidates, isFreePlanCandidate } = await import('./agentTrialUi')
    const src = (path: string) => ({ kind: 'file' as const, path })
    const t = { candidates: [
      { id: 'A', label: 'growl low', source: src('sources/a.wav'), effects: [] },
      { id: 'B', label: 'growl (free)', source: src('sources/b.wav'), effects: [] },
      { id: 'C', label: 'growl mid', source: src('sources/eleven-free plan/c.wav'), effects: [] },
      { id: 'D', label: 'growl high', source: src('sources/d.wav'), effects: [] },
      { id: 'E', label: 'growl', source: src('sources/e.wav'), effects: [] },
    ] }
    const rating = { candidates: { A: { overall: 4 }, B: { overall: 5 }, C: { overall: 5 }, D: { overall: 5 }, E: { overall: 3 } } }
    expect(poolCandidates(t, rating)).toEqual(['D', 'A'])
    expect(t.candidates.map(isFreePlanCandidate)).toEqual([false, true, true, false, false])
    expect(poolCandidates(t, { candidates: { E: { comment: 'x' } } })).toEqual([])
  })
})

describe('reserves (★3)', () => {
  it('keeps ★3 candidates aside (free plan excluded), by reference, without duplicates', async () => {
    const { reserveCandidates, addReserves, removeReserve } = await import('./agentTrialUi')
    const src = (path: string) => ({ kind: 'file' as const, path })
    const t = { candidates: [
      { id: 'A', label: 'a', source: src('sources/a.wav'), effects: [] },
      { id: 'B', label: 'b (free)', source: src('sources/b.wav'), effects: [] },
      { id: 'C', label: 'c', source: src('sources/c.wav'), effects: [] },
      { id: 'D', label: 'd', source: src('sources/d.wav'), effects: [] },
    ] }
    expect(reserveCandidates(t, { candidates: { A: { overall: 3 }, B: { overall: 3 }, C: { overall: 4 }, D: { overall: 2 } } })).toEqual(['A'])
    const ref = { trialId: 't1', candidateId: 'A', target: 'sound' as const }
    let map = addReserves({}, 'bite:tear', [ref])
    expect(addReserves(map, 'bite:tear', [{ ...ref }])).toBe(map)
    map = addReserves(map, 'bite:tear', [{ ...ref, candidateId: 'C' }])
    expect(map['bite:tear'].map(r => r.candidateId)).toEqual(['A', 'C'])
    expect(removeReserve(removeReserve(map, 'bite:tear', ref), 'bite:tear', { trialId: 't1', candidateId: 'C' })).toEqual({})
  })
})

describe('remake requests', () => {
  it('stay pending until a trial for the cue arrives after them', async () => {
    const { reviseAnswered } = await import('./agentTrialUi')
    const req = { cue: 'bite:tear', at: '2026-10-05T10:00:00.000Z' }
    const trial = (cues: string[], receivedAt: string) => ({ trial: { receivedAt, scene: { cues } } })
    expect(reviseAnswered(req, [trial(['bite:tear'], '2026-10-05T09:00:00.000Z'), trial(['bite'], '2026-10-05T11:00:00.000Z')])).toBe(false)
    expect(reviseAnswered(req, [trial(['bite:tear'], '2026-10-05T11:00:00.000Z')])).toBe(true)
  })
})

describe('haptic requests', () => {
  it('stay pending until a trial of the target for the cue arrives after them', async () => {
    const { requestAnswered } = await import('./agentTrialUi')
    const req = { cue: 'grab', at: '2026-10-05T10:00:00.000Z' }
    const trial = (target: 'sound' | 'haptic' | undefined, cues: string[], receivedAt: string) => ({ trial: { receivedAt, target, scene: { cues } } })
    expect(requestAnswered(req, 'haptic', [trial('sound', ['grab'], '2026-10-05T11:00:00.000Z'), trial('haptic', ['grab'], '2026-10-05T09:00:00.000Z')])).toBe(false)
    expect(requestAnswered(req, 'sound', [trial('sound', ['grab'], '2026-10-05T11:00:00.000Z')])).toBe(true)
    expect(requestAnswered(req, 'haptic', [trial(undefined, ['grab'], '2026-10-05T11:00:00.000Z')])).toBe(true)
  })
})
