import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { CandidateFile, RatingBody, TrialFile } from '@/utils/agentProtocol'
import { KnowledgeFolder, SEED_DIMENSIONS, TRIAL_CACHE_FILE, TRIAL_CACHE_PENDING_FILE, type TrialCache } from '@/utils/hapticKnowledge'
import { MemoryDirectory } from '@/utils/memoryDirectory.testutil'
import { useAgentTrialStore } from './agentTrialStore'
import { useWaveformStore } from './waveformStore'

const MONTH = '2026-09'
const clock = { now: 1_000 }
const store = () => useAgentTrialStore.getState()
const trialFile = (id: string, day: number): TrialFile => ({
  format: 'hapbeat-trial@1', id, intent: 'create', prompt: 'p', terms: ['ごわごわ'], receivedAt: `2026-09-${String(day).padStart(2, '0')}T10:00:00+09:00`, studioVersion: '0.8.0',
  candidates: ['A', 'B', 'C'].map(cid => ({ id: cid, label: cid, source: { kind: 'clip' as const, clipId: 'c' }, effects: [] })),
})
const candidate = (trialId: string, id: string): CandidateFile => ({ format: 'hapbeat-candidate@1', trialId, id, label: id, spec: { source: { kind: 'clip', clipId: 'c' }, effects: [] }, audio: `audio/${id}.wav`, features: null, renderedAt: '2026-09-01T10:00:00+09:00' })
const rating = (trialId: string, overall: Record<string, number>): RatingBody => ({
  format: 'hapbeat-rating@1', trialId, ratedAt: '2026-10-13T12:00:00+09:00', candidates: Object.fromEntries(Object.entries(overall).map(([cid, o]) => [cid, { overall: o }])),
})

/** An editor folder written by an earlier Studio: trials and index.json, no trial cache. */
async function seed(ids: string[]) {
  const root = new MemoryDirectory('root', clock)
  const folder = await KnowledgeFolder.open(root.asHandle())
  for (const [i, id] of ids.entries()) {
    await folder.writeTrial(MONTH, trialFile(id, i + 1))
    for (const cid of ['A', 'B', 'C']) await folder.writeCandidate(MONTH, candidate(id, cid), new Blob([`wav ${id}${cid}`]))
  }
  await folder.regenerate(await folder.listTrials(), SEED_DIMENSIONS)
  return { root, folder }
}
/** Runs after every background write queued so far (the poll is queued behind them). */
const settle = () => store().refresh()
async function open(root: MemoryDirectory) {
  useWaveformStore.setState({ folder: { root: root.asHandle() } as never })
  await store().refresh()
  await settle()
}
const ids = () => store().trials.map(r => r.trial.id)
const find = (id: string) => store().trials.find(r => r.trial.id === id)

describe('AI trial store: no full reread on poll, save or dismissal', () => {
  let listTrials: MockInstance<KnowledgeFolder['listTrials']>, readTrial: MockInstance<KnowledgeFolder['readTrial']>
  beforeEach(async () => {
    useWaveformStore.setState({ folder: null })
    await store().refresh()
    clock.now += 1_000
    listTrials = vi.spyOn(KnowledgeFolder.prototype, 'listTrials')
    readTrial = vi.spyOn(KnowledgeFolder.prototype, 'readTrial')
  })
  afterEach(() => vi.restoreAllMocks())

  it('reads every trial once, then opens from the trial cache and polls without reading trials', async () => {
    const { root } = await seed(['t1', 't2', 't3'])
    listTrials.mockClear()
    await open(root)
    expect(ids()).toEqual(['t3', 't2', 't1'])
    expect(store().trials.map(r => r.shortId)).toEqual(['T3', 'T2', 'T1'])
    expect(listTrials).toHaveBeenCalledTimes(1)
    const cache = await root.json<TrialCache>(`.hapbeat-editor/${TRIAL_CACHE_FILE}`)
    expect(cache.trials.map(r => r.trial.id).sort()).toEqual(['t1', 't2', 't3'])
    expect(cache.indexStamp).toBe(await (await KnowledgeFolder.open(root.asHandle())).indexStamp())
    listTrials.mockClear(); readTrial.mockClear()
    const before = store().trials
    await settle(); await settle()
    expect(listTrials).not.toHaveBeenCalled()
    expect(readTrial).not.toHaveBeenCalled()
    expect(store().trials).toBe(before)
    // Opening again: the cache plus a directory listing.
    useWaveformStore.setState({ folder: null }); await store().refresh()
    await open(root)
    expect(ids()).toEqual(['t3', 't2', 't1'])
    expect(listTrials).not.toHaveBeenCalled()
    expect(readTrial).not.toHaveBeenCalled()
  })

  it('saves a rating into the list at once; index.json, terms and the cache follow in the background', async () => {
    const { root } = await seed(['t1', 't2'])
    await open(root)
    listTrials.mockClear(); readTrial.mockClear()
    await store().saveRating('t1', rating('t1', { A: 5, B: 2 }))
    expect(find('t1')?.rating?.candidates.A.overall).toBe(5)
    expect((await root.json<{ trials: string[] }>(`.hapbeat-editor/${TRIAL_CACHE_PENDING_FILE}`)).trials).toEqual(['t1'])
    await settle()
    expect((await root.json<{ trials: { id: string; rated: boolean }[] }>('haptic-knowledge/index.json')).trials.find(t => t.id === 't1')?.rated).toBe(true)
    expect((await root.json<{ exemplars: unknown[]; counterExamples: unknown[] }>('haptic-knowledge/terms/ごわごわ.json')).counterExamples).toHaveLength(1)
    expect((await root.json<TrialCache>(`.hapbeat-editor/${TRIAL_CACHE_FILE}`)).trials.find(r => r.trial.id === 't1')?.rating?.candidates.A.overall).toBe(5)
    expect((await root.json<{ trials: string[] }>(`.hapbeat-editor/${TRIAL_CACHE_PENDING_FILE}`)).trials).toEqual([])
    await store().setDismissed('t2', true)
    expect(find('t2')?.dismissed).toBeTruthy()
    await settle()
    expect((await root.json<{ trials: { id: string; dismissed?: true }[] }>('haptic-knowledge/index.json')).trials.find(t => t.id === 't2')?.dismissed).toBe(true)
    await store().setDismissed('t2', false)
    expect(find('t2')?.dismissed).toBeUndefined()
    await store().dismissMany(['t2'])
    expect(find('t2')?.dismissed).toBeTruthy()
    await settle()
    expect(listTrials).not.toHaveBeenCalled()
    expect(readTrial).not.toHaveBeenCalled()
  })

  it('a reload before the cache caught up reads the trials marked pending again', async () => {
    const { root, folder } = await seed(['t1', 't2'])
    await open(root)
    // As if the page closed right after writing rating.json (marked pending, cache not yet written).
    await folder.writePendingTrials(['t2'])
    await folder.saveRating(MONTH, rating('t2', { A: 3 }))
    useWaveformStore.setState({ folder: null }); await store().refresh()
    readTrial.mockClear(); listTrials.mockClear()
    await open(root)
    expect(find('t2')?.rating?.candidates.A.overall).toBe(3)
    expect(readTrial).toHaveBeenCalledTimes(1)
    expect(listTrials).not.toHaveBeenCalled()
    expect((await root.json<{ trials: string[] }>(`.hapbeat-editor/${TRIAL_CACHE_PENDING_FILE}`)).trials).toEqual([])
  })

  it('takes trials another Studio wrote: its cache when it left one, else every trial again', async () => {
    const { root, folder } = await seed(['t1', 't2', 't3'])
    await open(root)
    // Another tab of this Studio: rating.json, index.json and the cache stamped with it.
    clock.now += 1_000
    await folder.saveRating(MONTH, rating('t2', { A: 4 }))
    const records = await folder.listTrials()
    await folder.regenerate(records, SEED_DIMENSIONS)
    await folder.writeTrialCache(records, await folder.indexStamp())
    listTrials.mockClear(); readTrial.mockClear()
    await settle()
    expect(find('t2')?.rating?.candidates.A.overall).toBe(4)
    expect(listTrials).not.toHaveBeenCalled()
    // An older Studio: rating.json and index.json only.
    clock.now += 1_000
    await folder.saveRating(MONTH, rating('t3', { B: 1 }))
    await folder.regenerate(await folder.listTrials(), SEED_DIMENSIONS)
    listTrials.mockClear()
    await settle()
    expect(find('t3')?.rating?.candidates.B.overall).toBe(1)
    expect(listTrials).toHaveBeenCalledTimes(1)
    // The new trials of a folder copied in by hand show up on the next open (directory listing).
    clock.now += 1_000
    await folder.writeTrial(MONTH, trialFile('t4', 20))
    useWaveformStore.setState({ folder: null }); await store().refresh()
    await open(root)
    expect(ids()[0]).toBe('t4')
  })

  it('archives the audio of ★1–2 candidates (JSON and rating stay), never one an event uses', async () => {
    const { root } = await seed(['t1'])
    await open(root)
    await store().saveRating('t1', rating('t1', { A: 1, B: 4, C: 2 }))
    const result = await store().archiveLowRatedAudio(new Set(['t1/C']))
    expect(result).toMatchObject({ moved: ['t1/A'], failures: [] })
    expect(result.bytes).toBe('wav t1A'.length)
    expect(root.has(`haptic-knowledge/_archive/trials/${MONTH}/t1/audio/A.wav`)).toBe(true)
    expect(root.has(`haptic-knowledge/trials/${MONTH}/t1/audio/A.wav`)).toBe(false)
    expect(root.has(`haptic-knowledge/trials/${MONTH}/t1/candidates/A.json`)).toBe(true)
    expect(find('t1')?.archivedAudio).toEqual(['A'])
    await expect(store().loadCandidateAudio('t1', 'A')).rejects.toThrow(/_archive/)
    expect((await store().archiveLowRatedAudio(new Set())).moved).toEqual(['t1/C'])
    await settle()
    useWaveformStore.setState({ folder: null }); await store().refresh()
    await open(root)
    expect(find('t1')?.archivedAudio).toEqual(['A', 'C'])
    await store().rebuild()
    expect(find('t1')?.archivedAudio).toEqual(['A', 'C'])
  })
})
