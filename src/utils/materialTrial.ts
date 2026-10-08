import type { TrialCandidate } from './agentProtocol'
import type { TrialRecord } from './hapticKnowledge'

/**
 * Which AI trial candidate an event material (clip / sound WAV name) came from. Studio names a material written
 * from a candidate `<cue>_<shortId>_<candidateId>` (eventDecide.autoWavName: roar_T45_A, clips in lower case,
 * `_2` … on a content clash), so the name is resolved against the loaded trials' short ids. Materials named
 * otherwise (editor clips, hand-made files) resolve to null.
 */
export interface MaterialTrial { record: TrialRecord; candidate: TrialCandidate; shortId: string }

/** Lower case, every run of characters a WAV name cannot hold as one "_" (safeWavName for clips and sounds alike). */
const norm = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')

const indexCache = new WeakMap<readonly TrialRecord[], Map<string, TrialRecord>>()
/** Trials by lower-case short id ("t90"); cached per trials array (the store replaces it on every reload). */
function shortIdIndex(trials: readonly TrialRecord[]): Map<string, TrialRecord> {
  let index = indexCache.get(trials)
  if (!index) {
    index = new Map(trials.flatMap(r => r.shortId ? [[r.shortId.toLowerCase(), r] as const] : []))
    indexCache.set(trials, index)
  }
  return index
}

/** The trial + candidate a material name was written from, or null. */
export function resolveMaterialTrial(name: string, trials: readonly TrialRecord[]): MaterialTrial | null {
  const index = shortIdIndex(trials)
  if (!index.size) return null
  const n = norm(name)
  // Every `_t<N>_` in the name (the cue part may itself hold one): the rest must be a candidate id of trial T<N>, optionally numbered.
  for (const m of n.matchAll(/(?:^|_)(t\d+)(?=_.)/g)) {
    const record = index.get(m[1])
    if (!record) continue
    const rest = n.slice(m.index! + m[0].length + 1)
    const candidate = record.trial.candidates.find(c => {
      const id = norm(c.id)
      return rest === id || new RegExp(`^${id}_([2-9]|[1-9]\\d+)$`).test(rest)
    })
    if (candidate) return { record, candidate, shortId: record.shortId! }
  }
  return null
}

/** The trial + candidate by ids (AI reserves keep them), or null when the trial is not loaded. */
export function materialTrialByIds(trialId: string, candidateId: string, trials: readonly TrialRecord[]): MaterialTrial | null {
  const record = trials.find(r => r.trial.id === trialId)
  const candidate = record?.trial.candidates.find(c => c.id === candidateId)
  return record && candidate ? { record, candidate, shortId: record.shortId ?? record.trial.id } : null
}

export const ORIGIN_TEXT_MAX = 200
const shorten = (text: string, max = ORIGIN_TEXT_MAX) => {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max)}…` : one
}

/**
 * Tooltip lines for an AI-made material: the candidate's label and hypothesis, the trial's rationale and prompt
 * (each shortened), then `heading` (e.g. "AI 提案 T90・候補 B").
 */
export function materialTrialTooltip(m: MaterialTrial, heading: string): string {
  return [
    m.candidate.label,
    m.candidate.hypothesis ? shorten(m.candidate.hypothesis) : '',
    m.record.trial.rationale ? shorten(m.record.trial.rationale) : '',
    m.record.trial.prompt ? shorten(m.record.trial.prompt) : '',
    heading,
  ].filter(Boolean).join('\n')
}

/** The one line shown in the event view's fixed area: label — hypothesis. */
export function materialTrialSummary(m: MaterialTrial): string {
  return m.candidate.hypothesis ? `${m.candidate.label} — ${shorten(m.candidate.hypothesis)}` : m.candidate.label
}
