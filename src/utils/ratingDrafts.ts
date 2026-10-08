import type { TrialRequest } from './agentProtocol'
import { initialIntensity, type CandidateRatingForm, type RatingForm } from './agentTrialUi'
import { writeEditorFile } from './editorFolder'

/**
 * Unsaved AI-trial rating forms, kept so a reload or a dev-server restart does
 * not lose them: one JSON per trial in `<editor folder>/.hapbeat-editor/rating-drafts/`
 * and a localStorage copy. The localStorage copy is written at once on every change
 * (a reload at any moment keeps the last input), the folder copy after a debounce;
 * restored when the trial is opened again, removed once the rating is saved. These
 * files are Studio's own temporary drafts, so removing them is allowed (no `_archive`).
 */
export const DRAFT_FORMAT = 'hapbeat-rating-draft@1'
export const DRAFT_DIR = 'rating-drafts'
/** Delay of the folder copy after the last change (the localStorage copy is not delayed). */
export const DRAFT_DEBOUNCE_MS = 300
const storageKey = (trialId: string) => `hapbeat-rating-draft:${trialId}`
const OPEN_TRIAL_KEY = 'hapbeat-agent-open-trial'

/** The trial open in the AI trials panel, so a reload opens the same one again (null = none open). */
export function rememberOpenTrial(trialId: string | null) {
  try { if (trialId) localStorage.setItem(OPEN_TRIAL_KEY, trialId); else localStorage.removeItem(OPEN_TRIAL_KEY) } catch { /* storage unavailable: the queue head opens */ }
}
export function rememberedOpenTrial(): string | null {
  try { return localStorage.getItem(OPEN_TRIAL_KEY) } catch { return null }
}

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
  const candidates: Record<string, CandidateRatingForm> = {}
  for (const { id, intensity: proposed } of trial.candidates) {
    const c = isRecord(f.candidates) && isRecord(f.candidates[id]) ? f.candidates[id] as Record<string, unknown> : {}
    const overall = typeof c.overall === 'number' && Number.isInteger(c.overall) && c.overall >= 1 && c.overall <= 5 ? c.overall : null
    const termMatch = Object.fromEntries(Object.entries(isRecord(c.termMatch) ? c.termMatch : {}).filter(([k, x]) => trial.terms.includes(k) && typeof x === 'number' && x >= -2 && x <= 2)) as Record<string, number>
    const directions = Object.fromEntries(Object.entries(isRecord(c.directions) ? c.directions : {}).filter(([, x]) => x === -1 || x === 0 || x === 1)) as CandidateRatingForm['directions']
    const useRange = (Array.isArray(c.useRange) ? c.useRange : []).filter((r): r is [number, number] => Array.isArray(r) && r.length === 2 && r.every(x => typeof x === 'number' && Number.isFinite(x)) && r[0] >= 0 && r[1] > r[0])
    const verdict = c.verdict === 'use' || c.verdict === 'maybe' || c.verdict === 'no' ? c.verdict : null
    const intensity = typeof c.intensity === 'number' && Number.isFinite(c.intensity) && c.intensity >= 0 && c.intensity <= 1 ? c.intensity : initialIntensity({ intensity: proposed })
    candidates[id] = { overall, termMatch, directions, comment: str(c.comment), useRange, verdict, useFor: str(c.useFor).slice(0, 200), intensity }
  }
  const form: RatingForm = {
    comment: str(f.comment).slice(0, 4000),
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
/** The localStorage copy (synchronous, so it is in place even when the page is reloaded right after). */
export function writeLocalDraft(trialId: string, form: RatingForm, savedAt: string): void {
  try { localStorage.setItem(storageKey(trialId), serializeRatingDraft(trialId, form, savedAt)) } catch { /* storage unavailable: the folder copy remains */ }
}
/** The folder copy; best effort (localStorage still holds the draft). */
export async function writeFolderDraft(root: FileSystemDirectoryHandle | null, trialId: string, form: RatingForm, savedAt: string): Promise<void> {
  if (root) await writeEditorFile(await draftDir(root, true), `${trialId}.json`, serializeRatingDraft(trialId, form, savedAt))
}
/** Removes both copies after the rating is saved (Studio's own temporary file). */
export async function clearRatingDraft(root: FileSystemDirectoryHandle | null, trialId: string): Promise<void> {
  try { localStorage.removeItem(storageKey(trialId)) } catch { /* nothing stored */ }
  if (!root) return
  try { await (await draftDir(root, false)).removeEntry(`${trialId}.json`) }
  catch (error) { if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error }
}

type DraftTrial = Pick<TrialRequest, 'id' | 'candidates' | 'terms'>
export interface DraftStores {
  readLocal: (trial: DraftTrial) => RatingDraft | null
  readFolder: (trial: DraftTrial) => Promise<RatingDraft | null>
  /** Synchronous: called on every change. */
  writeLocal: (trialId: string, form: RatingForm, savedAt: string) => void
  /** Debounced (and on flush). */
  writeFolder: (trialId: string, form: RatingForm, savedAt: string) => Promise<void>
  clear: (trialId: string) => Promise<void>
}

/**
 * Keeps unsaved rating forms across trial switches, reloads and restarts.
 * Opening a trial always restores: this page's memory, else the stored draft
 * (localStorage now, the newer folder copy when it arrives — unless the user
 * typed meanwhile). Every change goes to localStorage at once and to the folder
 * after `delayMs` (at once on flush, e.g. when the page is hidden); only `done`
 * (saved, moving on) removes it.
 * Nothing here depends on React effects, so a double-run effect (StrictMode)
 * or an auto-open racing the restore cannot wipe a draft.
 */
export class DraftKeeper {
  private memory = new Map<string, { form: RatingForm; savedAt: string }>()
  private pending = new Map<string, { timer: ReturnType<typeof setTimeout>; form: RatingForm; savedAt: string }>()
  constructor(private stores: DraftStores, private now: () => string = () => new Date().toISOString(), private delayMs = DRAFT_DEBOUNCE_MS) {}

  /** What to show when `trial` opens; `savedAt` identifies the version shown (null = fresh form). */
  open(trial: DraftTrial, fresh: () => RatingForm): { form: RatingForm; restored: boolean; savedAt: string | null } {
    const m = this.memory.get(trial.id)
    if (m) return { form: m.form, restored: true, savedAt: m.savedAt }
    const local = this.stores.readLocal(trial)
    if (local) { this.memory.set(trial.id, { form: local.form, savedAt: local.savedAt }); return { form: local.form, restored: true, savedAt: local.savedAt } }
    return { form: fresh(), restored: false, savedAt: null }
  }
  /** The folder copy when it is newer than the version shown and nothing was typed since; it becomes the current draft. */
  async newerFromFolder(trial: DraftTrial, shownSavedAt: string | null): Promise<RatingDraft | null> {
    const found = await this.stores.readFolder(trial)
    if (!found) return null
    const current = this.memory.get(trial.id)
    if ((current?.savedAt ?? null) !== shownSavedAt) return null
    if (shownSavedAt && Date.parse(found.savedAt) <= Date.parse(shownSavedAt)) return null
    this.memory.set(trial.id, { form: found.form, savedAt: found.savedAt })
    return found
  }
  /** Records a change: memory and localStorage now, the folder copy after the debounce. */
  change(trialId: string, form: RatingForm) {
    const savedAt = this.now()
    this.memory.set(trialId, { form, savedAt })
    this.stores.writeLocal(trialId, form, savedAt)
    const before = this.pending.get(trialId)
    if (before) clearTimeout(before.timer)
    const timer = setTimeout(() => { this.pending.delete(trialId); void this.stores.writeFolder(trialId, form, savedAt).catch(() => {}) }, this.delayMs)
    this.pending.set(trialId, { timer, form, savedAt })
  }
  /** Writes the pending folder copies now (page hide / unload). */
  flush() {
    for (const [trialId, p] of this.pending) { clearTimeout(p.timer); void this.stores.writeFolder(trialId, p.form, p.savedAt).catch(() => {}) }
    this.pending.clear()
  }
  /** The rating was saved: the draft goes (memory, pending write, both stored copies). */
  async done(trialId: string) {
    const p = this.pending.get(trialId)
    if (p) clearTimeout(p.timer)
    this.pending.delete(trialId)
    this.memory.delete(trialId)
    await this.stores.clear(trialId)
  }
  has(trialId: string) { return this.memory.has(trialId) }
}
