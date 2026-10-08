import { describe, expect, it } from 'vitest'
import type { TrialRecord } from './hapticKnowledge'
import { materialTrialByIds, materialTrialSummary, materialTrialTooltip, resolveMaterialTrial } from './materialTrial'

const record = (id: string, shortId: string | undefined, candidates: { id: string; label: string; hypothesis?: string }[], extra: { prompt?: string; rationale?: string } = {}) => ({
  month: '2026-10', candidates: [], rating: null, shortId,
  trial: { id, prompt: extra.prompt ?? 'prompt', rationale: extra.rationale, receivedAt: '2026-10-01T00:00:00Z', candidates: candidates.map(c => ({ ...c, source: { kind: 'file', path: 'x.wav' }, effects: [] })) },
}) as unknown as TrialRecord

const trials = [
  record('t-roar', 'T90', [{ id: 'A', label: 'roar low' }, { id: 'B', label: 'ダメージ 1 周期＋残響', hypothesis: '50 Hz・減衰 12 ms' }], { rationale: 'why', prompt: 'make it hit' }),
  record('t-bite', 'T7', [{ id: 'cand-2', label: 'bite' }]),
]

describe('material → AI trial candidate', () => {
  it('resolves <cue>_<shortId>_<candidate> names (sounds as written, clips in lower case, numbered on a clash)', () => {
    expect(resolveMaterialTrial('Roar_T90_B', trials)?.candidate.label).toBe('ダメージ 1 周期＋残響')
    expect(resolveMaterialTrial('roar_t90_b', trials)?.record.trial.id).toBe('t-roar')
    expect(resolveMaterialTrial('roar_t90_b_2', trials)?.candidate.id).toBe('B')
    expect(resolveMaterialTrial('bite_tear_t7_cand-2', trials)?.candidate.id).toBe('cand-2')
    expect(resolveMaterialTrial('Bite_T7_cand_2', trials)?.shortId).toBe('T7')
    expect(resolveMaterialTrial('T90_A', trials)?.candidate.id).toBe('A')
  })
  it('leaves other materials alone', () => {
    expect(resolveMaterialTrial('roar', trials)).toBeNull()
    expect(resolveMaterialTrial('roar_t90_c', trials)).toBeNull()
    expect(resolveMaterialTrial('roar_t91_a', trials)).toBeNull()
    expect(resolveMaterialTrial('roar_t90_b_1', trials)).toBeNull()
    expect(resolveMaterialTrial('roar_t90_b', [record('t-x', undefined, [{ id: 'B', label: 'x' }])])).toBeNull()
  })
  it('finds a reserve by ids', () => {
    expect(materialTrialByIds('t-roar', 'A', trials)?.candidate.label).toBe('roar low')
    expect(materialTrialByIds('t-gone', 'A', trials)).toBeNull()
  })
  it('composes the tooltip and the one-line summary', () => {
    const m = resolveMaterialTrial('roar_t90_b', trials)!
    expect(materialTrialTooltip(m, 'AI 提案 T90・候補 B')).toBe('ダメージ 1 周期＋残響\n50 Hz・減衰 12 ms\nwhy\nmake it hit\nAI 提案 T90・候補 B')
    expect(materialTrialSummary(m)).toBe('ダメージ 1 周期＋残響 — 50 Hz・減衰 12 ms')
    const long = resolveMaterialTrial('x_t1_a', [record('t1', 'T1', [{ id: 'A', label: 'L' }], { prompt: 'p'.repeat(300) })])!
    expect(materialTrialTooltip(long, 'H')).toBe(`L\n${'p'.repeat(200)}…\nH`)
  })
})
