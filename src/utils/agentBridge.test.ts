import { describe, expect, it, vi } from 'vitest'
import type { CandidateFile, RatingFile, TrialFile } from './agentProtocol'
import { agentResponsePayload, AGENT_METHODS, handleAgentRequest, MAX_PAYLOAD_BYTES, STUDIO_NOT_READY, type AgentBridgeDeps } from './agentBridge'
import { SEED_DIMENSIONS, type TrialRecord } from './hapticKnowledge'

function record(id: string, receivedAt: string, rated: boolean): TrialRecord {
  const trial: TrialFile = { format: 'hapbeat-trial@1', id, intent: 'create', prompt: 'p', terms: ['ゴワゴワ'], receivedAt, studioVersion: '0.8.0',
    candidates: [{ id: 'A', label: 'A', source: { kind: 'clip', clipId: 'c' }, effects: [] }] }
  const candidates: CandidateFile[] = [{ format: 'hapbeat-candidate@1', trialId: id, id: 'A', label: 'A', spec: { source: { kind: 'clip', clipId: 'c' }, effects: [] }, features: null, renderedAt: receivedAt }]
  const rating: RatingFile | null = rated ? { format: 'hapbeat-rating@1', trialId: id, ratedAt: receivedAt, candidates: { A: { overall: 5, termMatch: { ゴワゴワ: 0 } } }, history: [] } : null
  return { month: '2026-09', trial, candidates, rating }
}
const records = [record('t1', '2026-09-29T10:00:00+09:00', true), record('t2', '2026-09-30T10:00:00+09:00', false), record('t3', '2026-09-28T10:00:00+09:00', false)]

function deps(overrides: Partial<AgentBridgeDeps> = {}): AgentBridgeDeps {
  return {
    studioVersion: '0.9.0-test',
    folderName: () => 'haptics',
    clipCount: () => 2,
    loadTrials: async () => records,
    loadDimensions: async () => SEED_DIMENSIONS,
    readInsights: async () => '# insights\n',
    guide: () => 'GUIDE',
    catalog: () => ({ format: 'hapbeat-catalog@1' }),
    submitTrial: async () => ({ ok: true, trialId: 'n1', month: '2026-10', candidates: [
      { format: 'hapbeat-candidate@1', trialId: 'n1', id: 'A', label: 'A', spec: { source: { kind: 'clip', clipId: 'c' }, effects: [] }, features: null, autoNormalizedDb: -1.5, renderedAt: 'x' },
      { format: 'hapbeat-candidate@1', trialId: 'n1', id: 'B', label: 'B', spec: { source: { kind: 'clip', clipId: 'c' }, effects: [] }, features: null, error: 'boom', renderedAt: 'x' },
    ] }),
    audition: vi.fn(async () => {}),
    adopt: async () => ({ clipId: 'clip-9', name: 'A' }),
    appendInsight: vi.fn(async () => {}),
    ...overrides,
  }
}
const ok = async (method: string, params: unknown, d = deps()) => {
  const response = await handleAgentRequest(method, params, d)
  if (!response.ok) throw new Error(response.error)
  return response.result as Record<string, unknown>
}
const error = async (method: string, params: unknown, d = deps()) => {
  const response = await handleAgentRequest(method, params, d)
  return response.ok ? null : response.error
}

describe('handleAgentRequest', () => {
  it('answers STUDIO_NOT_READY for every method while no folder is open', async () => {
    for (const method of AGENT_METHODS) expect(await error(method, {}, deps({ folderName: () => null }))).toBe(STUDIO_NOT_READY)
  })

  it('rejects unknown methods and non-object params', async () => {
    expect(await error('rate', {})).toMatch(/Unknown method "rate"/)
    expect(await error('toString', {})).toMatch(/Unknown method/)
    expect(await error('status', [1])).toBe('params must be an object')
  })

  it('status, guide and catalog', async () => {
    expect(await ok('status', undefined)).toEqual({ studioVersion: '0.9.0-test', folderName: 'haptics', clipCount: 2, trialCount: 3, unratedCount: 2, dimensions: SEED_DIMENSIONS.dimensions.map(d => d.id) })
    expect(await ok('get_guide', {})).toEqual({ markdown: 'GUIDE' })
    expect(await ok('get_catalog', {})).toEqual({ format: 'hapbeat-catalog@1' })
  })

  it('get_knowledge returns the index or one alias-resolved term', async () => {
    const all = await ok('get_knowledge', {})
    expect(all.insights).toBe('# insights\n')
    expect(all.dimensions).toBe(SEED_DIMENSIONS)
    expect((all.index as { trials: unknown[] }).trials).toHaveLength(3)
    const term = await ok('get_knowledge', { term: 'gowa-gowa' })
    expect(term.term).toMatchObject({ term: 'ごわごわ', counts: { trials: 3, ratedCandidates: 1 } })
    expect((await ok('get_knowledge', { term: 'unknown-word' })).term).toBeNull()
    expect(await error('get_knowledge', { term: '' })).toMatch(/term must be/)
  })

  it('submit_trial shapes the result and passes validation errors through', async () => {
    expect(await ok('submit_trial', { trial: { id: 'n1' } })).toEqual({ trialId: 'n1', month: '2026-10', candidates: [{ id: 'A', features: null, autoNormalizedDb: -1.5 }, { id: 'B', features: null, error: 'boom' }] })
    expect(await error('submit_trial', { trial: { id: 'n1' } }, deps({ submitTrial: async () => ({ ok: false, error: 'format must be "hapbeat-trial@1"' }) }))).toBe('format must be "hapbeat-trial@1"')
    expect(await error('submit_trial', { trial: '{}' })).toMatch(/trial must be/)
  })

  it('get_trial and list_trials', async () => {
    expect(await ok('get_trial', { trialId: 't1' })).toEqual({ shortId: 'T2', trial: records[0].trial, candidates: records[0].candidates, rating: records[0].rating })
    expect(await error('get_trial', { trialId: 'nope' })).toBe('Trial "nope" not found')
    expect(await error('get_trial', { trialId: '../x' })).toMatch(/trialId must match/)
    expect((await ok('list_trials', {})).trials).toEqual([
      { id: 't2', shortId: 'T3', month: '2026-09', intent: 'create', terms: ['ゴワゴワ'], rated: false, receivedAt: '2026-09-30T10:00:00+09:00' },
      { id: 't1', shortId: 'T2', month: '2026-09', intent: 'create', terms: ['ゴワゴワ'], rated: true, receivedAt: '2026-09-29T10:00:00+09:00' },
      { id: 't3', shortId: 'T1', month: '2026-09', intent: 'create', terms: ['ゴワゴワ'], rated: false, receivedAt: '2026-09-28T10:00:00+09:00' },
    ])
    expect((await ok('list_trials', { limit: 1, unratedOnly: true })).trials).toMatchObject([{ id: 't2' }])
    expect((await ok('list_trials', { unratedOnly: true })).trials).toMatchObject([{ id: 't2' }, { id: 't3' }])
    for (const limit of [0, 101, 1.5, '5']) expect(await error('list_trials', { limit })).toMatch(/limit/)
    expect(await error('list_trials', { unratedOnly: 'yes' })).toMatch(/unratedOnly/)
  })

  it('audition and adopt', async () => {
    const d = deps()
    expect(await ok('audition', { trialId: 't1', candidateId: 'A' }, d)).toEqual({ auditioning: true, played: false })
    expect(await ok('audition', { trialId: 't1', candidateId: 'A', play: true }, d)).toEqual({ auditioning: true, played: true })
    expect(d.audition).toHaveBeenLastCalledWith('t1', 'A', true)
    expect(await error('audition', { trialId: 't1', candidateId: 'A', play: 1 })).toMatch(/play must be a boolean/)
    expect(await error('audition', { trialId: 't1', candidateId: 'A' }, deps({ audition: async () => { throw new Error('Candidate "A" has no rendered audio') } }))).toBe('Candidate "A" has no rendered audio')
    expect(await ok('adopt', { trialId: 't1', candidateId: 'A' })).toEqual({ clipId: 'clip-9', name: 'A' })
    expect(await error('adopt', { trialId: 't1', candidateId: 'way-too-long-candidate' })).toMatch(/candidateId must match/)
  })

  it('propose_insight validates statement and evidence', async () => {
    const d = deps()
    expect(await ok('propose_insight', { statement: 'AM depth matters', evidence: ['t1/A', 't2/A'] }, d)).toEqual({ appended: true })
    expect(d.appendInsight).toHaveBeenCalledWith('AM depth matters', ['t1/A', 't2/A'])
    expect(await error('propose_insight', { statement: 'x'.repeat(1001), evidence: ['t1/A'] })).toMatch(/statement/)
    expect(await error('propose_insight', { statement: ' ', evidence: ['t1/A'] })).toMatch(/statement/)
    for (const evidence of [[], ['t1'], ['t1/A/B'], Array(21).fill('t1/A'), 't1/A']) expect(await error('propose_insight', { statement: 's', evidence })).toMatch(/evidence/)
  })
})

describe('agentResponsePayload', () => {
  it('passes normal responses and replaces oversized ones', () => {
    expect(agentResponsePayload('r1', { ok: true, result: { a: 1 } })).toEqual({ requestId: 'r1', ok: true, result: { a: 1 } })
    expect(agentResponsePayload('r1', { ok: false, error: 'e' })).toEqual({ requestId: 'r1', ok: false, error: 'e' })
    const big = agentResponsePayload('r2', { ok: true, result: 'x'.repeat(MAX_PAYLOAD_BYTES) })
    expect(big).toMatchObject({ requestId: 'r2', ok: false })
    expect(big.error).toMatch(/^RESPONSE_TOO_LARGE/)
  })
})
