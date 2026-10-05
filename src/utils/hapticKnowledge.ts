/**
 * Haptic knowledge base kept in `<editor folder>/haptic-knowledge/`.
 * Raw data (trials/**) is append-only; index.json and terms/*.json are derived
 * and regenerated deterministically from it. Hierarchy:
 * dimensions → terms → trials → candidates → ratings.
 */
import type { CandidateFile, RatingBody, RatingFile, TrialFile } from '@/utils/agentProtocol'
import { normalizeTerm, termSlug, trialTarget, type TrialMethod } from '@/utils/agentProtocol'
import { SCALAR_FEATURES, type HapticFeatures } from '@/utils/hapticFeatures'
import { writeEditorFile } from '@/utils/editorFolder'
import { agentsMd, claudeMd, guideMarkdown, insightsTemplate, knowledgeReadme } from '@/utils/agentGuide'

export const AGENT_DIR = 'hapbeat-agent'
export const KNOWLEDGE_DIR = 'haptic-knowledge'

export interface Dimension { id: string; ja: string; en: string; poles: { ja: [string, string]; en: [string, string] } }
export interface DimensionTerm { term: string; aliases?: string[]; dimensions?: Record<string, number>; source?: string }
export interface DimensionsDoc { format: 'hapbeat-dimensions@1'; note?: string; dimensions: Dimension[]; terms: DimensionTerm[] }

const SEED_SOURCE = 'Initial hypothesis: voiced consonants = rough / unvoiced = smooth (Sakamoto & Watanabe 2018); higher frequency = lighter and higher intensity = rougher (Oketani et al. 2025, underwater vibration). Not yet verified for worn Hapbeat vibration.'
export const SEED_DIMENSIONS: DimensionsDoc = {
  format: 'hapbeat-dimensions@1',
  note: 'Human-edited source of truth. Studio writes this seed only when the file is missing.',
  dimensions: [
    { id: 'roughness', ja: '粗さ', en: 'Roughness', poles: { ja: ['滑らか', '粗い'], en: ['smooth', 'rough'] } },
    { id: 'weight', ja: '重さ', en: 'Weight', poles: { ja: ['軽い', '重い'], en: ['light', 'heavy'] } },
    { id: 'sharpness', ja: '鋭さ', en: 'Sharpness', poles: { ja: ['鈍い', '鋭い'], en: ['dull', 'sharp'] } },
    { id: 'intensity', ja: '強さ', en: 'Intensity', poles: { ja: ['弱い', '強い'], en: ['weak', 'strong'] } },
    { id: 'regularity', ja: '規則性', en: 'Regularity', poles: { ja: ['不規則', '規則的'], en: ['irregular', 'regular'] } },
    { id: 'continuity', ja: '連続性', en: 'Continuity', poles: { ja: ['断続', '連続'], en: ['intermittent', 'continuous'] } },
    { id: 'pleasantness', ja: '快さ', en: 'Pleasantness', poles: { ja: ['不快', '快'], en: ['unpleasant', 'pleasant'] } },
  ],
  terms: ([
    ['ごわごわ', 'gowa-gowa', { roughness: 2, weight: 1, pleasantness: -1 }],
    ['ざらざら', 'zara-zara', { roughness: 2 }],
    ['さらさら', 'sara-sara', { roughness: -2, weight: -1, pleasantness: 1 }],
    ['ざーざー', 'zaa-zaa', { continuity: 2, regularity: -1 }],
    ['ぶるぶる', 'buru-buru', { regularity: 2, continuity: 1 }],
    ['ごつん', 'gotsun', { sharpness: 1, weight: 2, continuity: -2 }],
    ['こつん', 'kotsun', { sharpness: 2, weight: -1, continuity: -2 }],
    ['びりびり', 'biri-biri', { sharpness: 2, roughness: 1 }],
    ['ふわふわ', 'fuwa-fuwa', { intensity: -2, sharpness: -2, pleasantness: 1 }],
    ['どしん', 'doshin', { weight: 2, intensity: 2, continuity: -2 }],
  ] as const).map(([term, romaji, dimensions]) => ({ term, aliases: [romaji], dimensions: { ...dimensions }, source: SEED_SOURCE })),
}

export function parseDimensions(text: string): DimensionsDoc {
  const data = JSON.parse(text)
  const pair = (v: unknown) => Array.isArray(v) && v.length === 2 && v.every(s => typeof s === 'string')
  if (data?.format !== 'hapbeat-dimensions@1' || !Array.isArray(data.dimensions) || !Array.isArray(data.terms)) throw new Error('dimensions.json: format must be "hapbeat-dimensions@1" with dimensions[] and terms[]')
  for (const d of data.dimensions) if (!d || typeof d.id !== 'string' || typeof d.ja !== 'string' || typeof d.en !== 'string' || !pair(d.poles?.ja) || !pair(d.poles?.en)) throw new Error(`dimensions.json: invalid dimension ${JSON.stringify(d?.id ?? d)}`)
  for (const t of data.terms) if (!t || typeof t.term !== 'string' || (t.aliases !== undefined && !(Array.isArray(t.aliases) && t.aliases.every((a: unknown) => typeof a === 'string'))) || (t.dimensions !== undefined && (typeof t.dimensions !== 'object' || !Object.values(t.dimensions).every(Number.isFinite)))) throw new Error(`dimensions.json: invalid term ${JSON.stringify(t?.term ?? t)}`)
  return data
}

/** Resolves aliases (dimensions.json) to the canonical term. Unknown terms keep their NFKC-trimmed spelling. */
export function canonicalTerm(term: string, dims: DimensionsDoc): { term: string; slug: string; entry?: DimensionTerm } {
  const key = normalizeTerm(term)
  const entry = dims.terms.find(t => normalizeTerm(t.term) === key || (t.aliases ?? []).some(a => normalizeTerm(a) === key))
  const canonical = entry?.term ?? term.normalize('NFKC').trim()
  return { term: canonical, slug: termSlug(canonical), entry }
}

// ---- Pure aggregation ----

export interface TrialRecord {
  month: string; trial: TrialFile; candidates: CandidateFile[]; rating: RatingFile | null
  /** Short id for conversation ("T27"; candidates "T27-B"): the trial's position in reception order in this folder. */
  shortId?: string
}

/**
 * Short trial ids: T1, T2 … in reception order (receivedAt, then id). Trials are
 * append-only and receivedAt only grows, so an id never changes once given;
 * older trials get theirs the same way.
 */
export function shortTrialIds(records: readonly Pick<TrialRecord, 'trial'>[]): Map<string, string> {
  const order = [...records].sort((a, b) => Date.parse(a.trial.receivedAt) - Date.parse(b.trial.receivedAt) || a.trial.id.localeCompare(b.trial.id))
  return new Map(order.map((r, i) => [r.trial.id, `T${i + 1}`]))
}
export const withShortIds = <T extends Pick<TrialRecord, 'trial'> & { shortId?: string }>(records: T[]): T[] => {
  const ids = shortTrialIds(records)
  return records.map(r => ({ ...r, shortId: ids.get(r.trial.id) }))
}
export interface FeatureStat { median: number; p25: number; p75: number }
export interface FeatureGroup { n: number; features: Record<string, FeatureStat> }
export interface TermExample {
  trialId: string; candidateId: string; overall: number; termMatch: number | null
  /** How the candidate was made (its `method`), when the trial said. */
  method?: TrialMethod
  spec: CandidateFile['spec']; features: HapticFeatures | null; comment?: string
}
/** Per way of making: rated candidates, how many were good / too weak / too strong, and the best rated example. */
export interface MethodStat { rated: number; good: number; tooWeak: number; tooStrong: number; best: TermExample | null }
export interface TermDoc {
  format: 'hapbeat-term@1'
  term: string; slug: string; aliases: string[]
  dimensions: Record<string, number>
  counts: { trials: number; ratedCandidates: number }
  good: FeatureGroup; tooWeak: FeatureGroup; tooStrong: FeatureGroup
  directionVotes: Record<string, { '+': number; '-': number }>
  /** Keyed by method; candidates without one are counted under "unspecified". */
  byMethod: Record<string, MethodStat>
  exemplars: TermExample[]
  counterExamples: TermExample[]
  updatedAt: string | null
}
export interface KnowledgeIndex {
  format: 'hapbeat-knowledge-index@1'
  terms: { term: string; slug: string; trials: number; ratedCandidates: number; goodN: number; updatedAt: string | null }[]
  trials: { id: string; shortId: string; month: string; intent: string; terms: string[]; rated: boolean; receivedAt: string }[]
}

function flattenFeatures(f: HapticFeatures): Record<string, number> {
  const out: Record<string, number> = {}
  for (const key of SCALAR_FEATURES) { const v = f[key]; if (typeof v === 'number' && Number.isFinite(v)) out[key] = v }
  for (const [band, v] of Object.entries(f.bandEnergy)) out[`bandEnergy.${band}`] = v
  return out
}
function quantile(sorted: number[], q: number) {
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos)
  return Math.round((sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)) * 1e4) / 1e4
}
function featureGroup(items: { features: HapticFeatures | null }[]): FeatureGroup {
  const values: Record<string, number[]> = {}
  for (const { features } of items) if (features) for (const [k, v] of Object.entries(flattenFeatures(features))) (values[k] ??= []).push(v)
  const features: Record<string, FeatureStat> = {}
  for (const k of Object.keys(values).sort()) {
    const s = values[k].sort((a, b) => a - b)
    features[k] = { median: quantile(s, 0.5), p25: quantile(s, 0.25), p75: quantile(s, 0.75) }
  }
  return { n: items.length, features }
}
/** Terms a trial contributes to. Sound trials (target "sound") design the event's sound effect, not a haptic: they stay out of the haptic knowledge. */
export const trialSlugs = (trial: TrialFile, dims: DimensionsDoc) => trialTarget(trial) === 'sound' ? [] : [...new Set(trial.terms.map(t => canonicalTerm(t, dims).slug))]
const latest = (dates: (string | undefined)[]) => dates.filter((d): d is string => !!d).sort((a, b) => Date.parse(a) - Date.parse(b) || a.localeCompare(b)).pop() ?? null

const isGood = (c: { overall: number; termMatch: number | null }) => c.overall >= 4 && c.termMatch !== null && Math.abs(c.termMatch) <= 0.5

/** Aggregates every rated candidate of the trials that target `slug`. Deterministic for the same inputs. */
export function aggregateTerm(slug: string, dims: DimensionsDoc, records: TrialRecord[]): TermDoc {
  const related = records.filter(r => trialSlugs(r.trial, dims).includes(slug)).sort((a, b) => a.trial.id.localeCompare(b.trial.id))
  const entry = dims.terms.find(t => termSlug(t.term) === slug)
  const displayTerm = entry?.term ?? related.flatMap(r => r.trial.terms.map(t => canonicalTerm(t, dims))).find(t => t.slug === slug)?.term ?? slug
  const rated: (TermExample & { ratedAt: string; directions: Record<string, number> })[] = []
  for (const r of related) {
    if (!r.rating) continue
    for (const [cid, cr] of Object.entries(r.rating.candidates).sort(([a], [b]) => a.localeCompare(b))) {
      const cand = r.candidates.find(c => c.id === cid), requested = r.trial.candidates.find(c => c.id === cid)
      const tmKey = Object.keys(cr.termMatch ?? {}).find(k => canonicalTerm(k, dims).slug === slug)
      rated.push({
        trialId: r.trial.id, candidateId: cid, overall: cr.overall, termMatch: tmKey === undefined ? null : cr.termMatch![tmKey],
        ...(requested?.method ? { method: requested.method } : {}),
        spec: cand?.spec ?? { source: requested?.source ?? { kind: 'file', path: '?' }, effects: requested?.effects ?? [] },
        features: cand?.features ?? null, comment: cr.comment, ratedAt: r.rating.ratedAt, directions: cr.directions ?? {},
      })
    }
  }
  const directionVotes: TermDoc['directionVotes'] = {}
  for (const c of rated) for (const [dim, v] of Object.entries(c.directions)) {
    if (!v) continue
    const vote = (directionVotes[dim] ??= { '+': 0, '-': 0 })
    vote[v > 0 ? '+' : '-']++
  }
  const example = ({ ratedAt: _r, directions: _d, ...rest }: typeof rated[number]): TermExample => rest
  const byRecency = (a: typeof rated[number], b: typeof rated[number]) => Date.parse(b.ratedAt) - Date.parse(a.ratedAt) || a.trialId.localeCompare(b.trialId) || a.candidateId.localeCompare(b.candidateId)
  const exemplars = rated.filter(c => c.overall >= 4)
    .sort((a, b) => b.overall - a.overall || Math.abs(a.termMatch ?? 2) - Math.abs(b.termMatch ?? 2) || byRecency(a, b)).slice(0, 5).map(example)
  const counterExamples = rated.filter(c => c.overall <= 2).sort((a, b) => a.overall - b.overall || byRecency(a, b)).slice(0, 3).map(example)
  const byMethod: Record<string, MethodStat> = {}
  for (const c of [...rated].sort((a, b) => b.overall - a.overall || byRecency(a, b))) {
    const m = (byMethod[c.method ?? 'unspecified'] ??= { rated: 0, good: 0, tooWeak: 0, tooStrong: 0, best: null })
    m.rated++
    if (isGood(c)) m.good++
    if (c.termMatch !== null && c.termMatch <= -1) m.tooWeak++
    if (c.termMatch !== null && c.termMatch >= 1) m.tooStrong++
    m.best ??= example(c)
  }
  return {
    format: 'hapbeat-term@1',
    term: displayTerm, slug, aliases: entry?.aliases ?? [], dimensions: entry?.dimensions ?? {},
    counts: { trials: related.length, ratedCandidates: rated.length },
    good: featureGroup(rated.filter(isGood)),
    tooWeak: featureGroup(rated.filter(c => c.termMatch !== null && c.termMatch <= -1)),
    tooStrong: featureGroup(rated.filter(c => c.termMatch !== null && c.termMatch >= 1)),
    directionVotes, byMethod, exemplars, counterExamples,
    updatedAt: latest(related.flatMap(r => [r.trial.receivedAt, r.rating?.ratedAt])),
  }
}

/** Every slug known from dimensions.json plus every term used in a trial, sorted. */
export function knownSlugs(dims: DimensionsDoc, records: TrialRecord[]): string[] {
  return [...new Set([...dims.terms.map(t => termSlug(t.term)), ...records.flatMap(r => trialSlugs(r.trial, dims))])].sort()
}

export function buildIndex(records: TrialRecord[], terms: TermDoc[]): KnowledgeIndex {
  const shortIds = shortTrialIds(records)
  return {
    format: 'hapbeat-knowledge-index@1',
    terms: [...terms].sort((a, b) => a.slug.localeCompare(b.slug)).map(t => ({ term: t.term, slug: t.slug, trials: t.counts.trials, ratedCandidates: t.counts.ratedCandidates, goodN: t.good.n, updatedAt: t.updatedAt })),
    trials: [...records].sort((a, b) => Date.parse(b.trial.receivedAt) - Date.parse(a.trial.receivedAt) || a.trial.id.localeCompare(b.trial.id))
      .map(r => ({ id: r.trial.id, shortId: shortIds.get(r.trial.id)!, month: r.month, intent: r.trial.intent, terms: r.trial.terms, rated: !!r.rating, receivedAt: r.trial.receivedAt })),
  }
}

/** ISO 8601 with the local UTC offset, e.g. 2026-09-29T15:42:00+09:00. */
export function localIsoString(date: Date): string {
  const pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, '0')
  const offset = -date.getTimezoneOffset()
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${offset >= 0 ? '+' : '-'}${pad(offset / 60)}:${pad(offset % 60)}`
}
export const monthOf = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`

/**
 * Appends `- <statement> (evidence: a/b, …) — proposed <at>` to the end of the "## Proposed"
 * section of insights.md (created at the end when missing). Other sections are untouched.
 */
export function appendProposedInsight(markdown: string, statement: string, evidence: string[], at: string): string {
  const bullet = `- ${statement.trim().replace(/\s+/g, ' ')} (evidence: ${evidence.join(', ')}) — proposed ${at}`
  const heading = /^## Proposed[ \t]*$/m.exec(markdown)
  if (!heading) return `${markdown.trimEnd()}${markdown.trim() ? '\n\n' : ''}## Proposed\n\n${bullet}\n`
  const bodyStart = heading.index + heading[0].length
  const next = /^## /m.exec(markdown.slice(bodyStart))
  const end = next ? bodyStart + next.index : markdown.length
  return `${markdown.slice(0, end).trimEnd()}\n${bullet}\n${next ? `\n${markdown.slice(end)}` : ''}`
}

// ---- File system layer ----

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`
function isNotFound(error: unknown) { return error instanceof DOMException && (error.name === 'NotFoundError' || error.name === 'TypeMismatchError') }
async function readFile(dir: FileSystemDirectoryHandle, name: string): Promise<File | null> {
  try { return await (await dir.getFileHandle(name)).getFile() }
  catch (error) { if (isNotFound(error)) return null; throw error }
}
async function readText(dir: FileSystemDirectoryHandle, name: string) { return (await readFile(dir, name))?.text() ?? null }
async function subdir(dir: FileSystemDirectoryHandle, name: string): Promise<FileSystemDirectoryHandle | null> {
  try { return await dir.getDirectoryHandle(name) }
  catch (error) { if (isNotFound(error)) return null; throw error }
}
async function dirPath(dir: FileSystemDirectoryHandle, parts: string[], create: boolean): Promise<FileSystemDirectoryHandle> {
  for (const part of parts) dir = await dir.getDirectoryHandle(part, { create })
  return dir
}
async function writeIfAbsent(dir: FileSystemDirectoryHandle, name: string, content: string) {
  if (await readFile(dir, name) === null) await writeEditorFile(dir, name, content)
}
async function listEntries(dir: FileSystemDirectoryHandle, kind: 'file' | 'directory') {
  const names: string[] = []
  for await (const [name, handle] of dir.entries()) if (handle.kind === kind) names.push(name)
  return names.sort()
}
/**
 * Move within the chosen folder: copy, verify the copy closed, then remove the source.
 * Only used for inbox → trial / _rejected. Never exported as a delete API.
 */
async function moveFile(from: FileSystemDirectoryHandle, name: string, to: FileSystemDirectoryHandle, target: string) {
  const file = await (await from.getFileHandle(name)).getFile()
  const existing = new Set(await listEntries(to, 'file'))
  const dot = target.lastIndexOf('.'), stem = dot > 0 ? target.slice(0, dot) : target, ext = dot > 0 ? target.slice(dot) : ''
  let dest = target
  for (let i = 2; existing.has(dest); i++) dest = `${stem}_${i}${ext}`
  await writeEditorFile(to, dest, file)
  await from.removeEntry(name)
  return dest
}

export interface InboxEntry { name: string; file: File }
export type TrialState = { state: 'none' } | { state: 'incomplete' | 'complete'; month: string }

export class KnowledgeFolder {
  private constructor(readonly root: FileSystemDirectoryHandle, readonly agent: FileSystemDirectoryHandle, readonly knowledge: FileSystemDirectoryHandle) {}
  static async open(root: FileSystemDirectoryHandle): Promise<KnowledgeFolder> {
    const agent = await root.getDirectoryHandle(AGENT_DIR, { create: true })
    const knowledge = await root.getDirectoryHandle(KNOWLEDGE_DIR, { create: true })
    await dirPath(agent, ['inbox', '_rejected'], true)
    await agent.getDirectoryHandle('sources', { create: true })
    await knowledge.getDirectoryHandle('trials', { create: true })
    await knowledge.getDirectoryHandle('terms', { create: true })
    return new KnowledgeFolder(root, agent, knowledge)
  }
  /** Overwrites generated guides; writes human-owned files only when missing. */
  async writeScaffold(studioVersion: string) {
    await writeEditorFile(this.agent, 'GUIDE.md', guideMarkdown(studioVersion))
    await writeEditorFile(this.knowledge, 'README.md', knowledgeReadme(studioVersion))
    await writeIfAbsent(this.knowledge, 'dimensions.json', json(SEED_DIMENSIONS))
    await writeIfAbsent(this.knowledge, 'insights.md', insightsTemplate())
    await writeIfAbsent(this.root, 'AGENTS.md', agentsMd())
    await writeIfAbsent(this.root, 'CLAUDE.md', claudeMd())
  }
  async writeCatalog(catalog: unknown) { await writeEditorFile(this.agent, 'catalog.json', json(catalog)) }
  async readDimensions(): Promise<DimensionsDoc> {
    const text = await readText(this.knowledge, 'dimensions.json')
    return text === null ? SEED_DIMENSIONS : parseDimensions(text)
  }
  /** Top-level `*.json` files in inbox/ (sub-folders such as _rejected are ignored). */
  async listInbox(): Promise<InboxEntry[]> {
    const inbox = await this.agent.getDirectoryHandle('inbox', { create: true })
    const entries: InboxEntry[] = []
    for (const name of await listEntries(inbox, 'file')) if (/\.json$/i.test(name) && !name.startsWith('.')) entries.push({ name, file: await (await inbox.getFileHandle(name)).getFile() })
    return entries
  }
  async rejectInbox(name: string, error: string) {
    const inbox = await this.agent.getDirectoryHandle('inbox')
    const rejected = await inbox.getDirectoryHandle('_rejected', { create: true })
    const dest = await moveFile(inbox, name, rejected, name)
    await writeEditorFile(rejected, `${dest.replace(/\.json$/i, '')}.error.txt`, `${error}\n`)
  }
  /** Reads a file below hapbeat-agent/ (path already validated by isSafeAgentPath). */
  async readAgentFile(path: string): Promise<File> {
    const parts = path.split('/')
    const dir = await dirPath(this.agent, parts.slice(0, -1), false)
    return (await dir.getFileHandle(parts[parts.length - 1])).getFile()
  }
  private async trialDir(month: string, id: string, create = false) { return dirPath(this.knowledge, ['trials', month, id], create) }
  async trialState(id: string): Promise<TrialState> {
    const trials = await this.knowledge.getDirectoryHandle('trials', { create: true })
    for (const month of await listEntries(trials, 'directory')) {
      const dir = await subdir(await trials.getDirectoryHandle(month), id)
      if (dir) return { state: await readFile(dir, 'request.json') ? 'complete' : 'incomplete', month }
    }
    return { state: 'none' }
  }
  async writeTrial(month: string, trial: TrialFile) { await writeEditorFile(await this.trialDir(month, trial.id, true), 'trial.json', json(trial)) }
  async writeCandidate(month: string, candidate: CandidateFile, wav: Blob | null) {
    const dir = await this.trialDir(month, candidate.trialId, true)
    if (wav) await writeEditorFile(await dir.getDirectoryHandle('audio', { create: true }), `${candidate.id}.wav`, wav)
    await writeEditorFile(await dir.getDirectoryHandle('candidates', { create: true }), `${candidate.id}.json`, json(candidate))
  }
  /** Final step of accepting: the request file moves verbatim into the trial as request.json. */
  async finishInbox(name: string, month: string, id: string) {
    await moveFile(await this.agent.getDirectoryHandle('inbox'), name, await this.trialDir(month, id), 'request.json')
  }
  /** request.json for a trial submitted directly (not through the inbox). */
  async writeRequest(month: string, id: string, request: unknown) { await writeEditorFile(await this.trialDir(month, id), 'request.json', json(request)) }
  async readInsights(): Promise<string> { return await readText(this.knowledge, 'insights.md') ?? insightsTemplate() }
  async appendInsight(statement: string, evidence: string[], at: string) {
    await writeEditorFile(this.knowledge, 'insights.md', appendProposedInsight(await this.readInsights(), statement, evidence, at))
  }
  async listTrials(): Promise<TrialRecord[]> {
    const trials = await this.knowledge.getDirectoryHandle('trials', { create: true })
    const records: TrialRecord[] = []
    for (const month of await listEntries(trials, 'directory')) {
      const monthDir = await trials.getDirectoryHandle(month)
      for (const id of await listEntries(monthDir, 'directory')) {
        const dir = await monthDir.getDirectoryHandle(id)
        const trialText = await readText(dir, 'trial.json')
        if (trialText === null) continue
        try {
          const candidates: CandidateFile[] = []
          const candDir = await subdir(dir, 'candidates')
          if (candDir) for (const name of await listEntries(candDir, 'file')) if (name.endsWith('.json')) candidates.push(JSON.parse((await readText(candDir, name))!))
          const ratingText = await readText(dir, 'rating.json')
          records.push({ month, trial: JSON.parse(trialText), candidates, rating: ratingText === null ? null : JSON.parse(ratingText) })
        } catch (error) { throw new Error(`haptic-knowledge/trials/${month}/${id}: ${error instanceof Error ? error.message : String(error)}`) }
      }
    }
    return withShortIds(records)
  }
  /** Writes rating.json; the previous rating (without its history) is appended to history. */
  async saveRating(month: string, rating: RatingBody): Promise<RatingFile> {
    const dir = await this.trialDir(month, rating.trialId)
    const previousText = await readText(dir, 'rating.json')
    const previous: RatingFile | null = previousText === null ? null : JSON.parse(previousText)
    const history = previous ? [...(previous.history ?? []), (({ history: _h, ...body }) => body)(previous)] : []
    const file: RatingFile = { ...rating, history }
    await writeEditorFile(dir, 'rating.json', json(file))
    return file
  }
  async readCandidateAudio(month: string, trialId: string, candidateId: string): Promise<ArrayBuffer> {
    return (await (await (await this.trialDir(month, trialId)).getDirectoryHandle('audio')).getFileHandle(`${candidateId}.wav`)).getFile().then(f => f.arrayBuffer())
  }
  /** Regenerates terms/<slug>.json (all, or only `slugs`) and index.json from raw trials. */
  async regenerate(records: TrialRecord[], dims: DimensionsDoc, slugs?: string[]): Promise<KnowledgeIndex> {
    const terms = await this.knowledge.getDirectoryHandle('terms', { create: true })
    const docs = knownSlugs(dims, records).map(slug => aggregateTerm(slug, dims, records))
    for (const doc of docs) if (!slugs || slugs.includes(doc.slug)) await writeEditorFile(terms, `${doc.slug}.json`, json(doc))
    const index = buildIndex(records, docs)
    await writeEditorFile(this.knowledge, 'index.json', json(index))
    return index
  }
}
