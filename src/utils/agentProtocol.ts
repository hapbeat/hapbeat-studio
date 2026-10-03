/**
 * File formats exchanged with the user's local AI agent through the editor
 * folder (`hapbeat-agent/` and `haptic-knowledge/`). Studio never calls an LLM;
 * the agent writes trial requests, Studio renders them and stores human ratings.
 */
import type { EffectParams } from '@/types/waveform'
import { isProjectName, validateEffectParams } from '@/utils/editorFolder'
import { isSafeAgentPath, validateRecipe } from '@/utils/recipe'
import type { HapticFeatures } from '@/utils/hapticFeatures'

export const TRIAL_FORMAT = 'hapbeat-trial@1'
export const RATING_FORMAT = 'hapbeat-rating@1'
export const CANDIDATE_FORMAT = 'hapbeat-candidate@1'
export const TRIAL_ID = /^[A-Za-z0-9_-]{1,80}$/
export const CANDIDATE_ID = /^[A-Za-z0-9_-]{1,16}$/

export type CandidateSource =
  | { kind: 'clip'; clipId: string; use?: 'original' | 'working' }
  | { kind: 'file'; path: string }
  | { kind: 'recipe'; recipe: unknown }
export interface TrialCandidate { id: string; label: string; hypothesis?: string; source: CandidateSource; effects: EffectParams[] }
export interface TrialRequest {
  format: typeof TRIAL_FORMAT
  id: string
  intent: 'modify' | 'create'
  prompt: string
  terms: string[]
  parentTrial?: string
  agent?: { name?: string; model?: string }
  rationale?: string
  knowledgeUsed?: string[]
  /** Optional editor project label; copied to clips adopted from this trial. */
  project?: string
  candidates: TrialCandidate[]
}
/** trials/<YYYY-MM>/<id>/trial.json */
export interface TrialFile extends TrialRequest { receivedAt: string; studioVersion: string }
/** trials/<YYYY-MM>/<id>/candidates/<cid>.json */
export interface CandidateFile {
  format: typeof CANDIDATE_FORMAT
  trialId: string
  id: string
  label: string
  hypothesis?: string
  spec: { source: CandidateSource; effects: EffectParams[] }
  resolved?: { clipName?: string; sourceSampleRate: number; sourceChannels: number; sourceDurationSec: number }
  /** Relative to the trial folder. Absent when rendering failed. */
  audio?: string
  sampleRate?: number
  autoNormalizedDb?: number
  features: HapticFeatures | null
  error?: string
  renderedAt: string
}
export interface CandidateRating {
  overall: number
  termMatch?: Record<string, number>
  directions?: Record<string, -1 | 0 | 1>
  comment?: string
}
export interface RatingContext { device?: string; position?: string; volume?: string; note?: string }
export interface RatingBody {
  format: typeof RATING_FORMAT
  trialId: string
  ratedAt: string
  context?: RatingContext
  best?: string
  candidates: Record<string, CandidateRating>
}
/** trials/<YYYY-MM>/<id>/rating.json — latest rating plus every previous one. */
export interface RatingFile extends RatingBody { history: RatingBody[] }

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const optString = (v: unknown, max: number) => v === undefined || (typeof v === 'string' && v.length <= max)

function candidateError(c: unknown, index: number): string | null {
  const at = `candidates[${index}]`
  if (!isObject(c)) return `${at} must be an object`
  if (typeof c.id !== 'string' || !CANDIDATE_ID.test(c.id)) return `${at}.id must match /^[A-Za-z0-9_-]{1,16}$/`
  if (typeof c.label !== 'string' || !c.label.trim() || c.label.length > 80) return `${at}.label must be a non-empty string of at most 80 characters`
  if (!optString(c.hypothesis, 400)) return `${at}.hypothesis must be a string of at most 400 characters`
  const s = c.source
  if (!isObject(s)) return `${at}.source must be an object`
  switch (s.kind) {
    case 'clip':
      if (typeof s.clipId !== 'string' || !s.clipId) return `${at}.source.clipId must be a clip id from catalog.json`
      if (s.use !== undefined && s.use !== 'original' && s.use !== 'working') return `${at}.source.use must be "original" or "working"`
      break
    case 'file':
      if (!isSafeAgentPath(s.path)) return `${at}.source.path must be a relative path inside hapbeat-agent/ (for example "sources/rain.wav"); ".." and absolute paths are not allowed`
      break
    case 'recipe': {
      const error = validateRecipe(s.recipe)
      if (error) return `${at}.source.recipe: ${error}`
      break
    }
    default: return `${at}.source.kind must be "clip", "file" or "recipe"`
  }
  if (!Array.isArray(c.effects)) return `${at}.effects must be an array (use [] for none)`
  if (c.effects.length > 32) return `${at}.effects has more than 32 steps`
  const bad = c.effects.findIndex(e => !validateEffectParams(e))
  if (bad >= 0) return `${at}.effects[${bad}] has an unknown type or out-of-range parameters (see effectTypes in catalog.json)`
  return null
}

export function trialRequestError(data: unknown, fileId?: string): string | null {
  if (!isObject(data)) return 'Request must be a JSON object'
  if (data.format !== TRIAL_FORMAT) return `format must be "${TRIAL_FORMAT}"`
  if (typeof data.id !== 'string' || !TRIAL_ID.test(data.id)) return 'id must match /^[A-Za-z0-9_-]{1,80}$/'
  if (fileId !== undefined && data.id !== fileId) return `id "${data.id}" must equal the file name "${fileId}.json"`
  if (data.intent !== 'modify' && data.intent !== 'create') return 'intent must be "modify" or "create"'
  if (typeof data.prompt !== 'string' || !data.prompt.trim() || data.prompt.length > 2000) return 'prompt must be a non-empty string of at most 2000 characters'
  if (!Array.isArray(data.terms) || data.terms.length < 1 || data.terms.length > 5 || !data.terms.every(t => typeof t === 'string' && t.trim() && t.length <= 40)) return 'terms must be 1-5 non-empty strings of at most 40 characters'
  if (data.parentTrial !== undefined && (typeof data.parentTrial !== 'string' || !TRIAL_ID.test(data.parentTrial))) return 'parentTrial must be a trial id'
  if (data.agent !== undefined && (!isObject(data.agent) || !optString(data.agent.name, 80) || !optString(data.agent.model, 80))) return 'agent must be { name?: string, model?: string }'
  if (!optString(data.rationale, 4000)) return 'rationale must be a string of at most 4000 characters'
  if (data.project !== undefined && !isProjectName(data.project)) return 'project must be a string of 1-80 characters without leading/trailing spaces or control characters'
  if (data.knowledgeUsed !== undefined && (!Array.isArray(data.knowledgeUsed) || data.knowledgeUsed.length > 50 || !data.knowledgeUsed.every(k => typeof k === 'string' && k.length <= 200))) return 'knowledgeUsed must be an array of strings'
  if (!Array.isArray(data.candidates) || data.candidates.length < 1 || data.candidates.length > 6) return 'candidates must contain 1-6 items'
  const ids = new Set<string>()
  for (let i = 0; i < data.candidates.length; i++) {
    const error = candidateError(data.candidates[i], i)
    if (error) return error
    const id = (data.candidates[i] as { id: string }).id
    if (ids.has(id)) return `candidates[${i}].id "${id}" is duplicated`
    ids.add(id)
  }
  return null
}

export function parseTrialRequest(text: string, fileId?: string): { ok: true; trial: TrialRequest } | { ok: false; error: string } {
  let data: unknown
  try { data = JSON.parse(text) } catch (error) { return { ok: false, error: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}` } }
  const error = trialRequestError(data, fileId)
  return error ? { ok: false, error } : { ok: true, trial: data as TrialRequest }
}

/** Validates a rating produced by the UI against its trial before it is written. */
export function ratingError(rating: RatingBody, trial: TrialRequest, dimensionIds: string[]): string | null {
  if (rating.format !== RATING_FORMAT || rating.trialId !== trial.id || Number.isNaN(Date.parse(rating.ratedAt))) return 'Invalid rating header'
  const cids = new Set(trial.candidates.map(c => c.id))
  if (rating.best !== undefined && !cids.has(rating.best)) return `Unknown best candidate "${rating.best}"`
  if (!isObject(rating.candidates)) return 'candidates must be an object'
  for (const [cid, r] of Object.entries(rating.candidates)) {
    if (!cids.has(cid)) return `Unknown candidate "${cid}"`
    if (!Number.isInteger(r.overall) || r.overall < 1 || r.overall > 5) return `${cid}: overall must be 1-5`
    for (const v of Object.values(r.termMatch ?? {})) if (!Number.isFinite(v) || v < -2 || v > 2) return `${cid}: termMatch must be -2..+2`
    for (const [dim, v] of Object.entries(r.directions ?? {})) if (!dimensionIds.includes(dim) || ![-1, 0, 1].includes(v)) return `${cid}: invalid direction "${dim}"`
    if (!optString(r.comment, 4000)) return `${cid}: comment is too long`
  }
  return null
}

// ---- Vocabulary normalization ----

/** NFKC, trimmed, katakana folded to hiragana. Used for alias matching and slugs. */
export function normalizeTerm(term: string): string {
  return term.normalize('NFKC').trim().replace(/[ァ-ヶ]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60))
}
/** File-name-safe slug for terms/<slug>.json. */
export function termSlug(term: string): string {
  return normalizeTerm(term).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '') || '_'
}
