import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearRatingDraft, DraftKeeper, newerDraft, parseRatingDraft, readFolderDraft, serializeRatingDraft, writeFolderDraft } from './ratingDrafts'
import { LevelCommit, LEVEL_SAVE_DELAY_MS } from './levelCommit'
import { onPageHide } from './pageHide'
import { ratingToForm } from './agentTrialUi'
import type { TrialRequest } from './agentProtocol'
import type { RatingForm } from './agentTrialUi'
import type { RatingDraft } from './ratingDrafts'
import { MemoryDirectory } from './memoryDirectory.testutil'
import { sanitizeUiSettings } from './editorUiSettings'

const trial: TrialRequest = {
  format: 'hapbeat-trial@1', id: 't-1', intent: 'create', prompt: 'p', terms: ['どしん'],
  candidates: [{ id: 'A', label: 'a', source: { kind: 'clip', clipId: 'c' }, effects: [] }, { id: 'B', label: 'b', source: { kind: 'clip', clipId: 'c' }, effects: [] }],
}

describe('rating drafts', () => {
  it('round-trips a form and re-checks every field', () => {
    const form = ratingToForm(trial, null)
    form.comment = 'B is closest'
    form.candidates.A = { overall: 4, termMatch: { どしん: -1 }, directions: { weight: 1 }, comment: 'heavier', useRange: [[0.1, 0.4]], verdict: 'maybe', useFor: 'idle growl', intensity: 0.7 }
    const draft = parseRatingDraft(serializeRatingDraft('t-1', form, '2026-10-05T10:00:00+09:00'), trial)
    expect(draft?.form).toEqual(form)
    const messy = JSON.parse(serializeRatingDraft('t-1', form, '2026-10-05T10:00:00+09:00'))
    messy.form.candidates.A.overall = 9; messy.form.candidates.A.intensity = 3; messy.form.candidates.A.termMatch = { other: 1 }; messy.form.best = 'Z'; messy.form.candidates.Z = {}
    const cleaned = parseRatingDraft(JSON.stringify(messy), trial)!
    expect(cleaned.form.candidates.A.overall).toBeNull()
    expect(cleaned.form.candidates.A.termMatch).toEqual({})
    expect(cleaned.form.candidates.A.intensity).toBe(1)
    expect(Object.keys(cleaned.form.candidates)).toEqual(['A', 'B'])
    expect(parseRatingDraft(serializeRatingDraft('other', form, 'x'), trial)).toBeNull()
    expect(parseRatingDraft('{', trial)).toBeNull()
  })

  it('keeps the newer copy and writes / removes the folder file', async () => {
    const a = parseRatingDraft(serializeRatingDraft('t-1', ratingToForm(trial, null), '2026-10-05T10:00:00+09:00'), trial)
    const b = parseRatingDraft(serializeRatingDraft('t-1', ratingToForm(trial, null), '2026-10-05T10:05:00+09:00'), trial)
    expect(newerDraft(a, b)).toBe(b)
    expect(newerDraft(null, a)).toBe(a)
    const root = new MemoryDirectory('folder')
    await writeFolderDraft(root as unknown as FileSystemDirectoryHandle, 't-1', b!.form, b!.savedAt)
    expect(root.has('.hapbeat-editor/rating-drafts/t-1.json')).toBe(true)
    expect((await readFolderDraft(root as unknown as FileSystemDirectoryHandle, trial))?.savedAt).toBe(b!.savedAt)
    await clearRatingDraft(root as unknown as FileSystemDirectoryHandle, 't-1')
    expect(root.has('.hapbeat-editor/rating-drafts/t-1.json')).toBe(false)
    await clearRatingDraft(root as unknown as FileSystemDirectoryHandle, 't-1') // already gone: no error
  })


  it('remembers the AI trials project filter in the editor settings', () => {
    expect(sanitizeUiSettings({ trialProjectFilter: 'trex-encounter' }).trialProjectFilter).toBe('trex-encounter')
    expect(sanitizeUiSettings({ trialProjectFilter: 3 }).trialProjectFilter).toBe('')
  })
})

/** localStorage stand-in + folder copy, shared by keepers (a new keeper = a reloaded page). */
function stores() {
  const local = new Map<string, string>()
  const folder = new Map<string, string>()
  return {
    local, folder,
    keeper: (now: () => string) => new DraftKeeper({
      readLocal: t => { const raw = local.get(t.id); return raw ? parseRatingDraft(raw, t) : null },
      readFolder: async t => { const raw = folder.get(t.id); return raw ? parseRatingDraft(raw, t) : null },
      writeLocal: (id, form, savedAt) => { local.set(id, serializeRatingDraft(id, form, savedAt)) },
      writeFolder: async (id, form, savedAt) => { folder.set(id, serializeRatingDraft(id, form, savedAt)) },
      clear: async id => { local.delete(id); folder.delete(id) },
    }, now),
  }
}
const trial2: TrialRequest = { ...trial, id: 't-2' }
const withComment = (text: string): RatingForm => { const f = ratingToForm(trial, null); f.comment = text; return f }

describe('rating drafts with a proposed starting intensity', () => {
  it('a stored draft wins over the trial candidate intensity; an unreadable value falls back to it', () => {
    const proposed: TrialRequest = { ...trial, candidates: [{ ...trial.candidates[0], intensity: 0.3 }, trial.candidates[1]] }
    const form = ratingToForm(proposed, null)
    expect(form.candidates.A.intensity).toBe(0.3)
    form.candidates.A.intensity = 0.8
    expect(parseRatingDraft(serializeRatingDraft('t-1', form, '2026-10-08T10:00:00+09:00'), proposed)?.form.candidates.A.intensity).toBe(0.8)
    const messy = JSON.parse(serializeRatingDraft('t-1', form, '2026-10-08T10:00:00+09:00'))
    messy.form.candidates.A.intensity = 'loud'
    expect(parseRatingDraft(JSON.stringify(messy), proposed)?.form.candidates.A.intensity).toBe(0.3)
  })
})

describe('DraftKeeper', () => {
  afterEach(() => { vi.useRealTimers() })
  let clock = 0
  const now = () => new Date(Date.UTC(2026, 9, 5, 0, 0, clock++)).toISOString()

  it('keeps the draft across trial switches and StrictMode-style double opens', () => {
    vi.useFakeTimers()
    const { keeper } = stores(); const k = keeper(now)
    const first = k.open(trial, () => ratingToForm(trial, null))
    expect(first.restored).toBe(false)
    k.change('t-1', withComment('heavier'))
    k.open(trial2, () => ratingToForm(trial2, null)) // switch away
    for (let i = 0; i < 2; i++) { // switch back; opened twice like a double-run effect
      const back = k.open(trial, () => ratingToForm(trial, null))
      expect(back.restored).toBe(true); expect(back.form.comment).toBe('heavier')
    }
  })

  it('writes localStorage on every change and the folder after the debounce; a reload restores (a new keeper on the same stores)', () => {
    vi.useFakeTimers()
    const s = stores(); const k = s.keeper(now)
    k.open(trial, () => ratingToForm(trial, null))
    k.change('t-1', withComment('a')); k.change('t-1', withComment('ab'))
    expect(parseRatingDraft(s.local.get('t-1')!, trial)?.form.comment).toBe('ab')
    expect(s.folder.has('t-1')).toBe(false)
    vi.advanceTimersByTime(300)
    expect(s.folder.has('t-1')).toBe(true)
    const reloaded = s.keeper(now).open(trial, () => ratingToForm(trial, null))
    expect(reloaded.restored).toBe(true); expect(reloaded.form.comment).toBe('ab')
  })

  it('a comment typed within the debounce survives a reload without any unload event', () => {
    vi.useFakeTimers()
    const s = stores(); const k = s.keeper(now)
    k.change('t-1', withComment('typed just before the reload'))
    // No flush, no timer: the page is gone (a Vite full reload).
    expect(s.keeper(now).open(trial, () => ratingToForm(trial, null)).form.comment).toBe('typed just before the reload')
  })

  it('every field of the form comes back identical after a reload', () => {
    vi.useFakeTimers()
    const s = stores(); const k = s.keeper(now)
    const form = ratingToForm(trial, null)
    form.comment = 'B is closest'
    form.context = { device: 'C01C-band-wl-v4', position: 'pos_r_wrist', deviceWiper: '70', volumeLabel: 'mid', note: 'seated' }
    form.candidates.A = { overall: 4, termMatch: { どしん: 2 }, directions: { weight: -1, attack: 1 }, comment: 'heavier', useRange: [[0.1, 0.4], [0.6, 0.9]], verdict: 'use', useFor: 'idle growl', intensity: 0.35 }
    form.candidates.B = { overall: 1, termMatch: {}, directions: {}, comment: '', useRange: [], verdict: 'no', useFor: '', intensity: 0 }
    k.change('t-1', form)
    expect(s.keeper(now).open(trial, () => ratingToForm(trial, null)).form).toEqual(form)
  })

  it('a strength slider moved < 500 ms before the reload is saved by the page-hide commit', () => {
    vi.useFakeTimers()
    const s = stores(); const k = s.keeper(now)
    let form = k.open(trial, () => ratingToForm(trial, null)).form
    // The panel's LevelSlider: onSave = editCandidate(intensity) -> keeper.change.
    const commit = new LevelCommit(intensity => { form = { ...form, candidates: { ...form.candidates, A: { ...form.candidates.A, intensity } } }; k.change('t-1', form) })
    const win = new EventTarget(), doc = Object.assign(new EventTarget(), { visibilityState: 'visible' as DocumentVisibilityState })
    const off = onPageHide(() => commit.flush(), win, doc)
    commit.input(0.42)
    vi.advanceTimersByTime(LEVEL_SAVE_DELAY_MS - 100)
    expect(s.local.has('t-1')).toBe(false)
    win.dispatchEvent(new Event('beforeunload'))
    expect(s.keeper(now).open(trial, () => ratingToForm(trial, null)).form.candidates.A.intensity).toBe(0.42)
    // The tab being hidden commits too; a visibility change to visible does not.
    commit.input(0.6)
    doc.dispatchEvent(new Event('visibilitychange'))
    expect(parseRatingDraft(s.local.get('t-1')!, trial)?.form.candidates.A.intensity).toBe(0.42)
    doc.visibilityState = 'hidden'
    doc.dispatchEvent(new Event('visibilitychange'))
    expect(parseRatingDraft(s.local.get('t-1')!, trial)?.form.candidates.A.intensity).toBe(0.6)
    off()
    commit.input(0.7)
    win.dispatchEvent(new Event('pagehide'))
    expect(parseRatingDraft(s.local.get('t-1')!, trial)?.form.candidates.A.intensity).toBe(0.6)
  })

  it('flush writes the pending folder copy at once (page hide)', async () => {
    vi.useFakeTimers()
    const s = stores(); const k = s.keeper(now)
    k.change('t-1', withComment('typed just before closing'))
    k.flush()
    expect(parseRatingDraft(s.folder.get('t-1')!, trial)?.form.comment).toBe('typed just before closing')
    s.local.clear() // another browser / cleared site data: the folder copy restores
    expect((await s.keeper(now).newerFromFolder(trial, null))?.form.comment).toBe('typed just before closing')
  })

  it('an older folder copy never replaces the newer localStorage draft', async () => {
    const s = stores()
    s.folder.set('t-1', serializeRatingDraft('t-1', withComment('old folder'), '2026-10-05T09:00:00.000Z'))
    s.local.set('t-1', serializeRatingDraft('t-1', withComment('newer local'), '2026-10-05T09:00:05.000Z'))
    const k = s.keeper(now)
    const shown = k.open(trial, () => ratingToForm(trial, null))
    expect(shown.form.comment).toBe('newer local')
    expect(await k.newerFromFolder(trial, shown.savedAt)).toBeNull()
    expect(k.open(trial, () => ratingToForm(trial, null)).form.comment).toBe('newer local')
  })

  it('a newer folder copy replaces the shown form only when nothing was typed since (auto-open before the restore)', async () => {
    const s = stores()
    s.folder.set('t-1', serializeRatingDraft('t-1', withComment('from folder'), '2026-10-05T09:00:00.000Z'))
    const k = s.keeper(now)
    const shown = k.open(trial, () => ratingToForm(trial, null)) // nothing in localStorage (another browser / cleared)
    expect(shown.restored).toBe(false)
    const found: RatingDraft | null = await k.newerFromFolder(trial, shown.savedAt)
    expect(found?.form.comment).toBe('from folder')
    expect(k.open(trial, () => ratingToForm(trial, null)).form.comment).toBe('from folder')
    // Typing before the folder read resolves wins.
    const s2 = stores(); s2.folder.set('t-1', s.folder.get('t-1')!)
    const k2 = s2.keeper(now)
    const shown2 = k2.open(trial, () => ratingToForm(trial, null))
    const pending = k2.newerFromFolder(trial, shown2.savedAt)
    k2.change('t-1', withComment('typed'))
    expect(await pending).toBeNull()
    expect(k2.open(trial, () => ratingToForm(trial, null)).form.comment).toBe('typed')
  })

  it('removes the draft only when the rating is saved', async () => {
    vi.useFakeTimers()
    const s = stores(); const k = s.keeper(now)
    k.change('t-1', withComment('x')); vi.advanceTimersByTime(300)
    await k.done('t-1')
    expect(s.local.has('t-1') || s.folder.has('t-1') || k.has('t-1')).toBe(false)
    expect(k.open(trial, () => ratingToForm(trial, null)).restored).toBe(false)
  })
})
