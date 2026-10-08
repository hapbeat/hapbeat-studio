/**
 * Pure helpers behind the editor's "AI trials" panel: the adopted clip's effect
 * chain and the rating form ↔ hapbeat-rating@1 conversion.
 */
import type { EffectEntry, EffectParams } from '@/types/waveform'
import { RATING_FORMAT, DEVICE_WIPER_MAX, MAX_USE_RANGES, type Verdict, type RatingBody, type RatingContext, type TrialKind, type TrialRequest, type TrialCandidate } from '@/utils/agentProtocol'
import type { Dimension } from '@/utils/hapticKnowledge'
import { devicePosition } from './playbackDevices'
import type { DeviceInfo } from '@/types/manager'

/** Candidate effects as a NOT-yet-applied editor chain (fresh ids, enabled) so the user can keep tweaking. */
export function derivedEffectChain(effects: EffectParams[], newId: () => string = () => crypto.randomUUID()): EffectEntry[] {
  return effects.map(params => ({ id: newId(), params: structuredClone(params), enabled: true, applied: false }))
}

export type Direction = -1 | 0 | 1
/** `useRange`: "use only this part" ranges recorded from the waveform selection (seconds of the rendered candidate). */
export interface CandidateRatingForm {
  overall: number | null; termMatch: Record<string, number>; directions: Record<string, Direction>; comment: string; useRange: [number, number][]
  /** use / maybe / no (null = not said) and what it is good for. */
  verdict: Verdict | null; useFor: string
  /** The strength slider (0..1, default 1): the audition's gain; saved as `intensity` when not 1. */
  intensity: number
}
/** Text fields of the conditions; `deviceWiper` is typed only when the helper cannot report it. */
export interface RatingContextForm { device: string; position: string; deviceWiper: string; volumeLabel: string; note: string }
/** No trial-level "best" input: `best` is derived on save (autoBest). */
/** `comment`: the comment on the whole trial (comparisons). */
export interface RatingForm { context: RatingContextForm; comment: string; candidates: Record<string, CandidateRatingForm> }

export const EMPTY_CONTEXT: RatingContextForm = { device: '', position: '', deviceWiper: '', volumeLabel: '', note: '' }

/** The strength slider's starting value for a candidate without a saved rating or draft: the trial's proposed `intensity`, else 1. */
export const initialIntensity = (c: Pick<TrialCandidate, 'intensity'> | undefined) => c?.intensity ?? 1
const emptyCandidate = (c: TrialCandidate): CandidateRatingForm => ({ overall: null, termMatch: {}, directions: {}, comment: '', useRange: [], verdict: null, useFor: '', intensity: initialIntensity(c) })

/** Pre-fills from the saved rating; a trial without a rating starts empty with the remembered context. */
export function ratingToForm(trial: TrialRequest, rating: RatingBody | null, rememberedContext: RatingContextForm = EMPTY_CONTEXT): RatingForm {
  const saved = rating?.context
  const context: RatingContextForm = saved
    ? { ...EMPTY_CONTEXT, device: saved.device ?? '', position: saved.position ?? '', note: saved.note ?? '', volumeLabel: saved.volumeLabel ?? '', deviceWiper: saved.deviceWiper === undefined ? '' : String(saved.deviceWiper) }
    : rating ? { ...EMPTY_CONTEXT } : { ...rememberedContext }
  const candidates: Record<string, CandidateRatingForm> = {}
  for (const c of trial.candidates) {
    const saved = rating?.candidates[c.id]
    candidates[c.id] = saved ? { overall: saved.overall ?? null, termMatch: { ...saved.termMatch }, directions: { ...saved.directions }, comment: saved.comment ?? '', useRange: (saved.useRange ?? []).map(r => [r[0], r[1]] as [number, number]), verdict: saved.verdict ?? null, useFor: saved.useFor ?? '', intensity: saved.intensity ?? 1 } : emptyCandidate(c)
  }
  return { context, comment: rating?.comment ?? '', candidates }
}

/** Any input besides the score; a strength moved off its starting value alone is kept too (saved as an intensity-only, unscored candidate). */
const touched = (c: CandidateRatingForm, start: number) => Object.keys(c.termMatch).length > 0 || Object.keys(c.directions).length > 0 || c.comment.trim() !== '' || c.useRange.length > 0 || c.useFor.trim() !== '' || c.intensity !== start

/** Why the form cannot be saved yet: nothing rated, or a candidate has inputs but no overall score. */
/** Why the form cannot be saved yet: nothing at all (no score and no comment anywhere), or a bad wiper. A candidate without a score is saved as "no score". */
export function ratingFormIssue(form: RatingForm, trial: Pick<TrialRequest, 'candidates'>): { kind: 'none-rated' } | { kind: 'bad-wiper' } | null {
  const wiper = form.context.deviceWiper.trim()
  if (wiper && parseWiper(wiper) === null) return { kind: 'bad-wiper' }
  const anything = form.comment.trim() !== '' || trial.candidates.some(c => { const f = form.candidates[c.id]; return !!f && (f.overall !== null || touched(f, initialIntensity(c))) })
  return anything ? null : { kind: 'none-rated' }
}

/** Builds the rating body. Candidates with a score or any input are included (no score = `overall` absent); unset fields are omitted. */
export function formToRating(form: RatingForm, trial: TrialRequest, ratedAt: string): RatingBody {
  const best = autoBest(form, trial.candidates.map(c => c.id))
  const candidates: RatingBody['candidates'] = {}
  for (const c of trial.candidates) {
    const f = form.candidates[c.id]
    if (!f || (f.overall === null && !touched(f, initialIntensity(c)))) continue
    const termMatch = Object.fromEntries(trial.terms.filter(term => f.termMatch[term] !== undefined).map(term => [term, f.termMatch[term]]))
    const comment = f.comment.trim()
    candidates[c.id] = {
      ...(f.overall !== null ? { overall: f.overall } : {}),
      ...(Object.keys(termMatch).length ? { termMatch } : {}),
      ...(Object.keys(f.directions).length ? { directions: { ...f.directions } } : {}),
      ...(comment ? { comment } : {}),
      ...(f.useRange.length ? { useRange: f.useRange.map(r => [round3(r[0]), round3(r[1])] as [number, number]) } : {}),
      // Derived from the overall score (no separate input).
      ...(f.overall !== null ? { verdict: verdictFromOverall(f.overall)! } : {}),
      ...(f.useFor.trim() ? { useFor: f.useFor.trim().slice(0, 200) } : {}),
      ...(f.intensity !== 1 ? { intensity: Math.round(Math.max(0, Math.min(1, f.intensity)) * 100) / 100 } : {}),
    }
  }
  const context: RatingContext = {}
  for (const key of ['device', 'position', 'volumeLabel', 'note'] as const) { const v = form.context[key].trim(); if (v) context[key] = v }
  const wiper = parseWiper(form.context.deviceWiper)
  if (wiper !== null) context.deviceWiper = wiper
  return {
    format: RATING_FORMAT, trialId: trial.id, ratedAt,
    ...(Object.keys(context).length ? { context } : {}),
    ...(best ? { best } : {}),
    ...(form.comment.trim() ? { comment: form.comment.trim().slice(0, 4000) } : {}),
    candidates,
  }
}

const round3 = (x: number) => Math.round(x * 1000) / 1000

/** Adds a "use only this part" range (rounded to ms; duplicates ignored, at most MAX_USE_RANGES). */
export function addUseRange(ranges: [number, number][], start: number, end: number): [number, number][] {
  const r: [number, number] = [round3(Math.min(start, end)), round3(Math.max(start, end))]
  if (r[1] <= r[0] || ranges.some(x => x[0] === r[0] && x[1] === r[1]) || ranges.length >= MAX_USE_RANGES) return ranges
  return [...ranges, r].sort((a, b) => a[0] - b[0])
}

/** Integer 0..DEVICE_WIPER_MAX, else null. */
export function parseWiper(text: string): number | null {
  const t = text.trim()
  if (!/^\d{1,3}$/.test(t)) return null
  const n = Number(t)
  return n <= DEVICE_WIPER_MAX ? n : null
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

// ---- Trial kind, dimension wording, automatic conditions ----

/** Longest candidate (seconds) that still reads as a single event when a trial names no kind. */
export const ONESHOT_MAX_SEC = 2
/**
 * The trial's kind: its `kind`, else a loop when every scene cue is a loop cue,
 * else a one-shot when every rendered candidate is at most ONESHOT_MAX_SEC long.
 * null = unknown (the form shows every dimension).
 */
export function trialKind(trial: Pick<TrialRequest, 'kind' | 'scene'>, durations: (number | null | undefined)[], loopCues: string[] = []): TrialKind | null {
  if (trial.kind) return trial.kind
  // A `cue:variant` scene cue is a loop when its cue is.
  if (trial.scene && trial.scene.cues.length && trial.scene.cues.every(c => loopCues.includes(c.split(':')[0]))) return 'loop'
  const known = durations.filter((d): d is number => typeof d === 'number' && Number.isFinite(d))
  return known.length && known.every(d => d <= ONESHOT_MAX_SEC) ? 'oneshot' : null
}
/** Axes the rating form does not ask (pleasantness reads as the overall score). */

/**
 * Axes of a sound trial (target "sound"): weight (bass), roughness, sharpness, strength (volume), length, regularity (always).
 * Sound ratings never enter the haptic knowledge, so `length` needs no entry in dimensions.json.
 */
export const SOUND_DIMENSIONS: Dimension[] = [
  { id: 'weight', ja: '重さ（低音）', en: 'Weight (bass)', poles: { ja: ['軽い', '重い'], en: ['light', 'heavy'] } },
  { id: 'roughness', ja: '粗さ', en: 'Roughness', poles: { ja: ['滑らか', '粗い'], en: ['smooth', 'rough'] } },
  { id: 'sharpness', ja: '鋭さ', en: 'Sharpness', poles: { ja: ['鈍い', '鋭い'], en: ['dull', 'sharp'] } },
  { id: 'intensity', ja: '強さ（音量）', en: 'Strength (volume)', poles: { ja: ['弱い', '強い'], en: ['weak', 'strong'] } },
  { id: 'length', ja: '長さ', en: 'Length', poles: { ja: ['短い', '長い'], en: ['short', 'long'] } },
  { id: 'regularity', ja: '規則性', en: 'Regularity', poles: { ja: ['規則的', 'ランダム'], en: ['regular', 'random'] } },
]

/** The verdict the form writes, from the overall score: 4–5 use, 3 maybe, 1–2 no. */
export const verdictFromOverall = (overall: number | null): Verdict | null => overall == null ? null : overall >= 4 ? 'use' : overall === 3 ? 'maybe' : 'no'


/**
 * Rating conditions the helper reports for the playback devices: names, the
 * volume wiper (only when every target reports the same value) and the level
 * label "level/steps" when known. Empty / null when unknown.
 */
export function autoRatingContext(devices: DeviceInfo[], targetIps: string[]): { device: string; position: string; deviceWiper: number | null; volumeLabel: string } {
  const targets = targetIps.map(ip => devices.find(d => d.ipAddress === ip)).filter((d): d is DeviceInfo => !!d)
  const device = targets.map(d => d.name).filter(Boolean).join(', ')
  const wipers = [...new Set(targets.map(d => d.volumeWiper))]
  const deviceWiper = targets.length && wipers.length === 1 && typeof wipers[0] === 'number' ? wipers[0] : null
  const labels = [...new Set(targets.map(d => typeof d.volumeLevel === 'number' && typeof d.volumeSteps === 'number' ? `${d.volumeLevel}/${d.volumeSteps}` : ''))]
  // The positions the audition went to, from the device addresses (several allowed).
  const position = [...new Set(targets.map(d => devicePosition(d.address)).filter((p): p is string => !!p))].join(', ')
  return { device, position, deviceWiper, volumeLabel: deviceWiper !== null && labels.length === 1 ? labels[0] : '' }
}


/**
 * The trial's `best` (kept in hapbeat-rating@1 for compatibility; there is no input for it):
 * the "use" candidate with the highest overall score, when exactly one has it. Null on a tie or with no "use".
 */
export function autoBest(form: RatingForm, ids: readonly string[]): string | null {
  const usable = ids.filter(id => verdictFromOverall(form.candidates[id]?.overall ?? null) === 'use')
  if (!usable.length) return null
  const top = Math.max(...usable.map(id => form.candidates[id].overall!))
  const leaders = usable.filter(id => form.candidates[id].overall === top)
  return leaders.length === 1 ? leaders[0] : null
}

/** ElevenLabs free-plan output (not for commercial use): its label or source names "free plan" / "(free)". Never pooled automatically. */
export function isFreePlanCandidate(c: Pick<TrialCandidate, 'label' | 'source'>): boolean {
  const text = `${c.label} ${JSON.stringify(c.source)}`.toLowerCase()
  return text.includes('free plan') || text.includes('(free)')
}

/**
 * Candidates a saved rating adds to the event's material pool: every one rated ★4+ (verdict "use"), best
 * first (overall descending, then id), except free-plan output. The pool's existing representative stays first.
 */
export function poolCandidates(trial: Pick<TrialRequest, 'candidates'>, rating: Pick<RatingBody, 'candidates'>): string[] {
  return trial.candidates
    .filter(c => (rating.candidates[c.id]?.overall ?? 0) >= 4 && !isFreePlanCandidate(c))
    .sort((a, b) => (rating.candidates[b.id]!.overall! - rating.candidates[a.id]!.overall!) || a.id.localeCompare(b.id))
    .map(c => c.id)
}

/** ★3 (verdict "maybe") candidates kept aside as the event's reserves (free-plan output excluded, like the pool). */
export function reserveCandidates(trial: Pick<TrialRequest, 'candidates'>, rating: Pick<RatingBody, 'candidates'>): string[] {
  return trial.candidates.filter(c => rating.candidates[c.id]?.overall === 3 && !isFreePlanCandidate(c)).map(c => c.id)
}
/** Adds reserve references under `key` (no duplicates); returns the same object when nothing changed. */
export function addReserves<R extends { trialId: string; candidateId: string }>(map: Record<string, R[]>, key: string, refs: readonly R[]): Record<string, R[]> {
  const list = map[key] ?? []
  const fresh = refs.filter(r => !list.some(x => x.trialId === r.trialId && x.candidateId === r.candidateId))
  return fresh.length ? { ...map, [key]: [...list, ...fresh] } : map
}
/** Removes one reserve; an emptied key goes. */
export function removeReserve<R extends { trialId: string; candidateId: string }>(map: Record<string, R[]>, key: string, ref: Pick<R, 'trialId' | 'candidateId'>): Record<string, R[]> {
  const list = (map[key] ?? []).filter(x => !(x.trialId === ref.trialId && x.candidateId === ref.candidateId))
  const next = { ...map }
  if (list.length) next[key] = list; else delete next[key]
  return next
}

/** A remake request is answered once a trial for its cue (in `scene.cues`) is received after it was sent. */
export function reviseAnswered(req: { cue: string; at: string }, trials: readonly { trial: { receivedAt: string; scene?: { cues: string[] } } }[]): boolean {
  const sent = Date.parse(req.at)
  return trials.some(r => !!r.trial.scene?.cues.includes(req.cue) && Date.parse(r.trial.receivedAt) > sent)
}

/** A "go to haptics" / "request a sound" request is answered once a trial of that target naming the cue (`scene.cues`) is received after it. */
export function requestAnswered(req: { cue: string; at: string }, target: 'sound' | 'haptic', trials: readonly { trial: { receivedAt: string; target?: 'sound' | 'haptic'; scene?: { cues: string[] } } }[]): boolean {
  const sent = Date.parse(req.at)
  return trials.some(r => (r.trial.target ?? 'haptic') === target && !!r.trial.scene?.cues.includes(req.cue) && Date.parse(r.trial.receivedAt) > sent)
}

/** Whether the editor plays the shown waveform on the PC: not a haptic audition (AI haptic candidate / event haptic material) unless "haptics on the PC too" is on. */
export const waveformOnPc = (o: { hapticAudition: boolean; hapticOnPc: boolean }) => !o.hapticAudition || o.hapticOnPc
