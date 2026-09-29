/**
 * Pure helpers behind the editor's "AI trials" panel: the adopted clip's effect
 * chain and the rating form ↔ hapbeat-rating@1 conversion.
 */
import type { EffectEntry, EffectParams } from '@/types/waveform'
import { RATING_FORMAT, type RatingBody, type RatingContext, type TrialRequest } from '@/utils/agentProtocol'

/** Candidate effects as a NOT-yet-applied editor chain (fresh ids, enabled) so the user can keep tweaking. */
export function derivedEffectChain(effects: EffectParams[], newId: () => string = () => crypto.randomUUID()): EffectEntry[] {
  return effects.map(params => ({ id: newId(), params: structuredClone(params), enabled: true, applied: false }))
}

export type Direction = -1 | 0 | 1
export interface CandidateRatingForm { overall: number | null; termMatch: Record<string, number>; directions: Record<string, Direction>; comment: string }
export interface RatingContextForm { device: string; position: string; volume: string; note: string }
export interface RatingForm { best: string | null; context: RatingContextForm; candidates: Record<string, CandidateRatingForm> }

export const EMPTY_CONTEXT: RatingContextForm = { device: '', position: '', volume: '', note: '' }
export const POSITION_SUGGESTIONS = ['neck', 'chest', 'back', 'wrist', 'waist'] as const

const emptyCandidate = (): CandidateRatingForm => ({ overall: null, termMatch: {}, directions: {}, comment: '' })

/** Pre-fills from the saved rating; a trial without a rating starts empty with the remembered context. */
export function ratingToForm(trial: TrialRequest, rating: RatingBody | null, rememberedContext: RatingContextForm = EMPTY_CONTEXT): RatingForm {
  const context = rating ? { ...EMPTY_CONTEXT, ...rating.context } : { ...rememberedContext }
  const candidates: Record<string, CandidateRatingForm> = {}
  for (const c of trial.candidates) {
    const saved = rating?.candidates[c.id]
    candidates[c.id] = saved ? { overall: saved.overall, termMatch: { ...saved.termMatch }, directions: { ...saved.directions }, comment: saved.comment ?? '' } : emptyCandidate()
  }
  return { best: rating?.best ?? null, context, candidates }
}

const touched = (c: CandidateRatingForm) => Object.keys(c.termMatch).length > 0 || Object.keys(c.directions).length > 0 || c.comment.trim() !== ''

/** Why the form cannot be saved yet: nothing rated, or a candidate has inputs but no overall score. */
export function ratingFormIssue(form: RatingForm): { kind: 'none-rated' } | { kind: 'missing-overall'; candidateId: string } | null {
  const entries = Object.entries(form.candidates)
  const missing = entries.find(([, c]) => c.overall === null && touched(c))
  if (missing) return { kind: 'missing-overall', candidateId: missing[0] }
  return entries.some(([, c]) => c.overall !== null) ? null : { kind: 'none-rated' }
}

/** Builds the rating body. Only candidates with an overall score are included; unset fields are omitted. */
export function formToRating(form: RatingForm, trial: TrialRequest, ratedAt: string): RatingBody {
  const candidates: RatingBody['candidates'] = {}
  for (const c of trial.candidates) {
    const f = form.candidates[c.id]
    if (!f || f.overall === null) continue
    const termMatch = Object.fromEntries(trial.terms.filter(term => f.termMatch[term] !== undefined).map(term => [term, f.termMatch[term]]))
    const comment = f.comment.trim()
    candidates[c.id] = {
      overall: f.overall,
      ...(Object.keys(termMatch).length ? { termMatch } : {}),
      ...(Object.keys(f.directions).length ? { directions: { ...f.directions } } : {}),
      ...(comment ? { comment } : {}),
    }
  }
  const context: RatingContext = {}
  for (const key of Object.keys(EMPTY_CONTEXT) as (keyof RatingContextForm)[]) { const v = form.context[key].trim(); if (v) context[key] = v }
  return {
    format: RATING_FORMAT, trialId: trial.id, ratedAt,
    ...(Object.keys(context).length ? { context } : {}),
    ...(form.best && trial.candidates.some(c => c.id === form.best) ? { best: form.best } : {}),
    candidates,
  }
}

const CONTEXT_KEY = 'hapbeat-agent-rating-context'
export function loadRememberedContext(): RatingContextForm {
  try {
    const saved = JSON.parse(localStorage.getItem(CONTEXT_KEY) ?? 'null')
    if (!saved || typeof saved !== 'object') return EMPTY_CONTEXT
    return Object.fromEntries((Object.keys(EMPTY_CONTEXT) as (keyof RatingContextForm)[]).map(k => [k, typeof saved[k] === 'string' ? saved[k] : ''])) as unknown as RatingContextForm
  } catch { return EMPTY_CONTEXT }
}
export function rememberContext(context: RatingContextForm) {
  try { localStorage.setItem(CONTEXT_KEY, JSON.stringify(context)) } catch { /* storage unavailable: context is only a convenience */ }
}
