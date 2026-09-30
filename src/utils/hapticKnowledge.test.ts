import { describe, expect, it } from 'vitest'
import type { CandidateFile, RatingFile, TrialFile } from './agentProtocol'
import type { HapticFeatures } from './hapticFeatures'
import { aggregateTerm, appendProposedInsight, buildIndex, canonicalTerm, KnowledgeFolder, knownSlugs, parseDimensions, SEED_DIMENSIONS, type TrialRecord } from './hapticKnowledge'
import { MemoryDirectory } from './memoryDirectory.testutil'
import { insightsTemplate } from './agentGuide'

const features = (centroidHz: number): HapticFeatures => ({
  durationSec: 1, peakDb: -1, rmsDb: -10, crestDb: 9,
  bandEnergy: { '<40': 0, '40-80': 0.5, '80-160': 0.5, '160-320': 0, '320-640': 0, '640-1000': 0, '>1000': 0 },
  centroidHz, dominantHz: centroidHz, flatness: 0.2, attackMs: 2, decayMs: null, amRateHz: 18, amDepth: 0.5, irregularity: 0.3,
})
function record(id: string, terms: string[], ratings: Record<string, { overall: number; tm?: number; dir?: Record<string, -1 | 0 | 1> }> | null, receivedAt = '2026-09-29T10:00:00+09:00'): TrialRecord {
  const cids = ['A', 'B', 'C']
  const trial: TrialFile = {
    format: 'hapbeat-trial@1', id, intent: 'create', prompt: 'p', terms, receivedAt, studioVersion: '0.8.0',
    candidates: cids.map(cid => ({ id: cid, label: cid, source: { kind: 'clip', clipId: 'c' }, effects: [] })),
  }
  const candidates: CandidateFile[] = cids.map((cid, i) => ({ format: 'hapbeat-candidate@1', trialId: id, id: cid, label: cid, spec: { source: { kind: 'clip', clipId: 'c' }, effects: [] }, features: features(100 + i * 50), renderedAt: receivedAt }))
  const rating: RatingFile | null = ratings && {
    format: 'hapbeat-rating@1', trialId: id, ratedAt: receivedAt.replace('10:00', '11:00'), history: [],
    candidates: Object.fromEntries(Object.entries(ratings).map(([cid, r]) => [cid, { overall: r.overall, termMatch: r.tm === undefined ? undefined : { [terms[0]]: r.tm }, directions: r.dir }])),
  }
  return { month: '2026-09', trial, candidates, rating }
}

describe('knowledge aggregation', () => {
  const records = [
    record('t1', ['ゴワゴワ'], { A: { overall: 5, tm: 0, dir: { roughness: 1 } }, B: { overall: 2, tm: -2, dir: { roughness: 1, weight: -1 } }, C: { overall: 3, tm: 1 } }),
    record('t2', ['gowa-gowa'], { A: { overall: 4, tm: 0.5 } }, '2026-09-30T10:00:00+09:00'),
    record('t3', ['ざらざら'], null),
  ]

  it('resolves aliases and katakana to the canonical term', () => {
    expect(canonicalTerm('ゴワゴワ', SEED_DIMENSIONS)).toMatchObject({ term: 'ごわごわ', slug: 'ごわごわ' })
    expect(canonicalTerm('gowa-gowa', SEED_DIMENSIONS).slug).toBe('ごわごわ')
    expect(canonicalTerm('ぬるぬる', SEED_DIMENSIONS).slug).toBe('ぬるぬる')
  })

  it('aggregates term groups, votes and examples', () => {
    const doc = aggregateTerm('ごわごわ', SEED_DIMENSIONS, records)
    expect(doc.term).toBe('ごわごわ')
    expect(doc.dimensions).toEqual({ roughness: 2, weight: 1, pleasantness: -1 })
    expect(doc.counts).toEqual({ trials: 2, ratedCandidates: 4 })
    expect(doc.good.n).toBe(2)
    expect(doc.good.features.centroidHz).toEqual({ median: 100, p25: 100, p75: 100 })
    expect(doc.tooWeak.n).toBe(1)
    expect(doc.tooWeak.features.centroidHz.median).toBe(150)
    expect(doc.tooStrong.n).toBe(1)
    expect(doc.directionVotes).toEqual({ roughness: { '+': 2, '-': 0 }, weight: { '+': 0, '-': 1 } })
    expect(doc.exemplars.map(e => `${e.trialId}/${e.candidateId}`)).toEqual(['t1/A', 't2/A'])
    expect(doc.counterExamples.map(e => e.candidateId)).toEqual(['B'])
    expect(doc.updatedAt).toBe('2026-09-30T11:00:00+09:00')
  })

  it('is deterministic regardless of record order', () => {
    expect(aggregateTerm('ごわごわ', SEED_DIMENSIONS, [...records].reverse())).toEqual(aggregateTerm('ごわごわ', SEED_DIMENSIONS, records))
  })

  it('builds the index', () => {
    const slugs = knownSlugs(SEED_DIMENSIONS, records)
    expect(slugs).toContain('ごわごわ')
    const index = buildIndex(records, slugs.map(s => aggregateTerm(s, SEED_DIMENSIONS, records)))
    expect(index.trials.map(t => t.id)).toEqual(['t2', 't1', 't3'])
    expect(index.trials[2].rated).toBe(false)
    expect(index.terms.find(t => t.slug === 'ごわごわ')).toMatchObject({ trials: 2, ratedCandidates: 4, goodN: 2 })
  })

  it('validates dimensions.json', () => {
    expect(parseDimensions(JSON.stringify(SEED_DIMENSIONS)).dimensions).toHaveLength(7)
    expect(() => parseDimensions('{"format":"x"}')).toThrow(/format/)
  })
})

describe('KnowledgeFolder', () => {
  it('scaffolds without overwriting human-owned files', async () => {
    const root = new MemoryDirectory('root')
    root.put('haptic-knowledge/insights.md', 'mine')
    root.put('AGENTS.md', 'existing')
    const folder = await KnowledgeFolder.open(root.asHandle())
    await folder.writeScaffold('9.9.9')
    expect(await root.text('haptic-knowledge/insights.md')).toBe('mine')
    expect(await root.text('AGENTS.md')).toBe('existing')
    expect(await root.text('CLAUDE.md')).toBe('@AGENTS.md\n')
    expect(await root.text('hapbeat-agent/GUIDE.md')).toMatch(/^<!-- generated by Hapbeat Studio v9\.9\.9/)
    expect(root.has('hapbeat-agent/inbox/_rejected')).toBe(true)
    expect(root.has('hapbeat-agent/sources')).toBe(true)
    expect((await root.json<{ terms: unknown[] }>('haptic-knowledge/dimensions.json')).terms).toHaveLength(10)
  })

  it('keeps rating history and regenerates derived files', async () => {
    const root = new MemoryDirectory('root')
    const folder = await KnowledgeFolder.open(root.asHandle())
    const r = record('t1', ['ごわごわ'], null)
    await folder.writeTrial('2026-09', r.trial)
    for (const c of r.candidates) await folder.writeCandidate('2026-09', c, new Blob(['wav']))
    const body = { format: 'hapbeat-rating@1' as const, trialId: 't1', ratedAt: '2026-09-29T11:00:00+09:00', candidates: { A: { overall: 3 } } }
    await folder.saveRating('2026-09', body)
    const second = await folder.saveRating('2026-09', { ...body, ratedAt: '2026-09-29T12:00:00+09:00', candidates: { A: { overall: 5, termMatch: { ごわごわ: 0 } } } })
    expect(second.history).toEqual([{ ...body }])
    const records = await folder.listTrials()
    expect(records).toHaveLength(1)
    expect(records[0].rating?.candidates.A.overall).toBe(5)
    await folder.regenerate(records, SEED_DIMENSIONS)
    const term = await root.json<{ good: { n: number } }>('haptic-knowledge/terms/ごわごわ.json')
    expect(term.good.n).toBe(1)
    expect((await root.json<{ trials: unknown[] }>('haptic-knowledge/index.json')).trials).toHaveLength(1)
    expect(await new Response(await folder.readCandidateAudio('2026-09', 't1', 'A')).text()).toBe('wav')
  })
})

describe('appendProposedInsight', () => {
  const at = '2026-10-01T12:00:00+09:00'
  const bullet = '- AM depth matters (evidence: t1/A, t2/B) — proposed 2026-10-01T12:00:00+09:00'
  it('appends to the end of the Proposed section and leaves Confirmed alone', () => {
    const template = insightsTemplate()
    const once = appendProposedInsight(template, 'AM depth\n  matters ', ['t1/A', 't2/B'], at)
    expect(once).toBe(`${template.trimEnd()}\n${bullet}\n`)
    const confirmed = (md: string) => md.slice(md.indexOf('## Confirmed'), md.indexOf('## Proposed'))
    expect(confirmed(once)).toBe(confirmed(template))
    expect(appendProposedInsight(once, 'second', ['t3/C'], at).endsWith(`${bullet}\n- second (evidence: t3/C) — proposed ${at}\n`)).toBe(true)
  })
  it('inserts before a following section', () => {
    const md = '# X\n\n## Proposed\n\n- old\n\n## Confirmed\n\n- keep\n'
    expect(appendProposedInsight(md, 'AM depth matters', ['t1/A', 't2/B'], at)).toBe(`# X\n\n## Proposed\n\n- old\n${bullet}\n\n## Confirmed\n\n- keep\n`)
  })
  it('creates the section at the end when missing', () => {
    expect(appendProposedInsight('# X\n\n## Confirmed\n\n- keep\n\n', 'AM depth matters', ['t1/A', 't2/B'], at)).toBe(`# X\n\n## Confirmed\n\n- keep\n\n## Proposed\n\n${bullet}\n`)
    expect(appendProposedInsight('', 'AM depth matters', ['t1/A', 't2/B'], at)).toBe(`## Proposed\n\n${bullet}\n`)
  })
})
