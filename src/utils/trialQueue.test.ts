import { describe, expect, it } from 'vitest'
import { nextAfter, stepQueue, trialQueue } from './trialQueue'
import { aggregateTerm, buildIndex, knownSlugs, SEED_DIMENSIONS, type TrialRecord } from './hapticKnowledge'

const rec = (id: string, receivedAt: string, rated = false, dismissed?: string) => ({ trial: { id, receivedAt }, rating: rated ? {} : null, ...(dismissed ? { dismissed } : {}) })

describe('trial queue (top-down)', () => {
  const records = [rec('c', '2026-10-03'), rec('a', '2026-10-01'), rec('r', '2026-09-30', true), rec('d', '2026-10-02', false, 'x'), rec('b', '2026-10-02')]
  it('is the unrated, not dismissed trials, oldest first', () => {
    expect(trialQueue(records).map(r => r.trial.id)).toEqual(['a', 'b', 'c'])
  })
  it('steps and moves on after a save / dismissal', () => {
    const q = trialQueue(records)
    expect(stepQueue(q, 'b', 1)?.trial.id).toBe('c')
    expect(stepQueue(q, 'b', -1)?.trial.id).toBe('a')
    expect(stepQueue(q, 'a', -1)).toBeNull()
    expect(stepQueue(q, 'r', 1)?.trial.id).toBe('a') // from the history: the first
    expect(nextAfter(q, 'b')?.trial.id).toBe('c')
    expect(nextAfter(q, 'c')?.trial.id).toBe('a') // the last one done: back to the first remaining
    expect(nextAfter([q[0]], 'a')).toBeNull()
  })
  it('dismissed trials stay out of the knowledge and are flagged in the index', () => {
    const at = '2026-10-05T10:00:00+09:00'
    const trial = (id: string): TrialRecord => ({ month: '2026-10', candidates: [], dismissed: id === 't2' ? at : undefined,
      trial: { format: 'hapbeat-trial@1', id, intent: 'create', prompt: 'p', terms: [id === 't2' ? 'ぽよぽよ' : 'どしん'], receivedAt: at, studioVersion: 'x', candidates: [{ id: 'A', label: 'a', source: { kind: 'clip', clipId: 'c' }, effects: [] }] },
      rating: { format: 'hapbeat-rating@1', trialId: id, ratedAt: at, history: [], candidates: { A: { overall: 4 } } } })
    const records = [trial('t1'), trial('t2')]
    expect(knownSlugs(SEED_DIMENSIONS, records)).not.toContain('ぽよぽよ')
    expect(aggregateTerm('ぽよぽよ', SEED_DIMENSIONS, records).counts.trials).toBe(0)
    expect(buildIndex(records, []).trials.find(r => r.id === 't2')?.dismissed).toBe(true)
  })
})

describe('trial filters (project / target) and the tab count', () => {
  it('filters by project and target; a trial without target is haptic', async () => {
    const { filterTrials } = await import('./trialQueue')
    const recs = [
      { trial: { id: 'a', receivedAt: '1', project: 'trex', target: 'sound' as const }, rating: null },
      { trial: { id: 'b', receivedAt: '2', project: 'trex' }, rating: null },
      { trial: { id: 'c', receivedAt: '3' }, rating: null, dismissed: 'x' },
    ]
    expect(filterTrials(recs, 'trex', 'haptic').map(r => r.trial.id)).toEqual(['b'])
    expect(filterTrials(recs, '', 'sound').map(r => r.trial.id)).toEqual(['a'])
    expect(filterTrials(recs, ' ', '').map(r => r.trial.id)).toEqual(['c'])
    // The tab count = the queue: dismissed trials are not counted.
    expect(trialQueue(filterTrials(recs, '', '')).length).toBe(2)
  })

  it('good no longer needs a term match (Studio does not ask it)', () => {
    const at = '2026-10-05T10:00:00+09:00'
    const r: TrialRecord = { month: '2026-10', candidates: [],
      trial: { format: 'hapbeat-trial@1', id: 't', intent: 'create', prompt: 'p', terms: ['どしん'], receivedAt: at, studioVersion: 'x', candidates: [{ id: 'A', label: 'a', source: { kind: 'clip', clipId: 'c' }, effects: [] }] },
      rating: { format: 'hapbeat-rating@1', trialId: 't', ratedAt: at, history: [], candidates: { A: { overall: 5, verdict: 'use' } } } }
    expect(aggregateTerm('どしん', SEED_DIMENSIONS, [r]).good.n).toBe(1)
  })
})
