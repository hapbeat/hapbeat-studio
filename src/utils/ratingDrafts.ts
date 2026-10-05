import type { TrialRequest } from './agentProtocol'
import type { CandidateRatingForm, RatingForm } from './agentTrialUi'
import { writeEditorFile } from './editorFolder'

/**
 * Unsaved AI-trial rating forms, kept so a reload or a dev-server restart does
 * not lose them: one JSON per trial in `<editor folder>/.hapbeat-editor/rating-drafts/`
 * and a localStorage copy. Written (debounced) on every change, restored when the
 * trial is opened again, removed once the rating is saved. These files are
 * Studio's own temporary drafts, so removing them is allowed (no `_archive`).
 */
export const DRAFT_FORMAT = 'hapbeat-rating-draft@1'
export const DRAFT_DIR = 'rating-drafts'
export const DRAFT_DEBOUNCE_MS = 600
const storageKey = (trialId: string) => `hapbeat-rating-draft:${trialId}`

export interface RatingDraft { format: typeof DRAFT_FORMAT; trialId: string; savedAt: string; form: RatingForm }

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown) => typeof v === 'string' ? v : ''

/** A stored draft for `trial`, or null when absent / unreadable / for another trial. Fields are re-checked; candidates not in the trial are dropped. */
export function parseRatingDraft(text: string | null, trial: Pick<TrialRequest, 'id' | 'candidates' | 'terms'>): RatingDraft | null {
  if (!text) return null
  let v: unknown
  try { v = JSON.parse(text) } catch { return null }
  if (!isRecord(v) || v.format !== DRAFT_FORMAT || v.trialId !== trial.id || typeof v.savedAt !== 'string' || !isRecord(v.form)) return null
  const f = v.form, ctx = isRecord(f.context) ? f.context : {}
  const ids = trial.candidates.map(c => c.id)
  const candidates: Record<string, CandidateRatingForm> = {}
  for (const id of ids) {
    const c = isRecord(f.candidates) && isRecord(f.candidates[id]) ? f.candidates[id] as Record<string, unknown> : {}
    const overall = typeof c.overall === 'number' && Number.isInteger(c.overall) && c.overall >= 1 && c.overall <= 5 ? c.overall : null
    const termMatch = Object.fromEntries(Object.entries(isRecord(c.termMatch) ? c.termMatch : {}).filter(([k, x]) => trial.terms.includes(k) && typeof x === 'number' && x >= -2 && x <= 2)) as Record<string, number>
    const directions = Object.fromEntries(Object.entries(isRecord(c.directions) ? c.directions : {}).filter(([, x]) => x === -1 || x === 0 || x === 1)) as CandidateRatingForm['directions']
    const useRange = (Array.isArray(c.useRange) ? c.useRange : []).filter((r): r is [number, number] => Array.isArray(r) && r.length === 2 && r.every(x => typeof x === 'number' && Number.isFinite(x)) && r[0] >= 0 && r[1] > r[0])
    const verdict = c.verdict === 'use' || c.verdict === 'maybe' || c.verdict === 'no' ? c.verdict : null
    candidates[id] = { overall, termMatch, directions, comment: str(c.comment), useRange, verdict, useFor: str(c.useFor).slice(0, 200) }
  }
  const form: RatingForm = {
    best: typeof f.best === 'string' && ids.includes(f.best) ? f.best : null,
    othersSimilar: f.othersSimilar === true,
    context: { device: str(ctx.device), position: str(ctx.position), deviceWiper: str(ctx.deviceWiper), volumeLabel: str(ctx.volumeLabel), note: str(ctx.note) },
    candidates,
  }
  return { format: DRAFT_FORMAT, trialId: trial.id, savedAt: v.savedAt, form }
}

export const serializeRatingDraft = (trialId: string, form: RatingForm, savedAt: string) => JSON.stringify({ format: DRAFT_FORMAT, trialId, savedAt, form } satisfies RatingDraft, null, 2)

/** The newer of two drafts (folder copy vs localStorage copy). */
export const newerDraft = (a: RatingDraft | null, b: RatingDraft | null) => !a ? b : !b ? a : Date.parse(b.savedAt) > Date.parse(a.savedAt) ? b : a

export function readLocalDraft(trial: Pick<TrialRequest, 'id' | 'candidates' | 'terms'>): RatingDraft | null {
  try { return parseRatingDraft(localStorage.getItem(storageKey(trial.id)), trial) } catch { return null }
}
async function draftDir(root: FileSystemDirectoryHandle, create: boolean) {
  return (await root.getDirectoryHandle('.hapbeat-editor', { create })).getDirectoryHandle(DRAFT_DIR, { create })
}
export async function readFolderDraft(root: FileSystemDirectoryHandle, trial: Pick<TrialRequest, 'id' | 'candidates' | 'terms'>): Promise<RatingDraft | null> {
  try { return parseRatingDraft(await (await (await (await draftDir(root, false)).getFileHandle(`${trial.id}.json`)).getFile()).text(), trial) } catch { return null }
}
/** Both copies; the folder write is best effort (localStorage still holds the draft). */
export async function writeRatingDraft(root: FileSystemDirectoryHandle | null, trialId: string, form: RatingForm, savedAt: string): Promise<void> {
  const text = serializeRatingDraft(trialId, form, savedAt)
  try { localStorage.setItem(storageKey(trialId), text) } catch { /* storage unavailable: the folder copy remains */ }
  if (root) await writeEditorFile(await draftDir(root, true), `${trialId}.json`, text)
}
/** Removes both copies after the rating is saved (Studio's own temporary file). */
export async function clearRatingDraft(root: FileSystemDirectoryHandle | null, trialId: string): Promise<void> {
  try { localStorage.removeItem(storageKey(trialId)) } catch { /* nothing stored */ }
  if (!root) return
  try { await (await draftDir(root, false)).removeEntry(`${trialId}.json`) }
  catch (error) { if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error }
}
