import { describe, expect, it } from 'vitest'
import { clearRatingDraft, newerDraft, parseRatingDraft, readFolderDraft, serializeRatingDraft, writeRatingDraft } from './ratingDrafts'
import { ratingToForm } from './agentTrialUi'
import type { TrialRequest } from './agentProtocol'
import { MemoryDirectory } from './memoryDirectory.testutil'
import { sanitizeUiSettings } from './editorUiSettings'

const trial: TrialRequest = {
  format: 'hapbeat-trial@1', id: 't-1', intent: 'create', prompt: 'p', terms: ['どしん'],
  candidates: [{ id: 'A', label: 'a', source: { kind: 'clip', clipId: 'c' }, effects: [] }, { id: 'B', label: 'b', source: { kind: 'clip', clipId: 'c' }, effects: [] }],
}

describe('rating drafts', () => {
  it('round-trips a form and re-checks every field', () => {
    const form = ratingToForm(trial, null)
    form.best = 'A'
    form.candidates.A = { overall: 4, termMatch: { どしん: -1 }, directions: { weight: 1 }, comment: 'heavier', useRange: [[0.1, 0.4]], verdict: 'maybe', useFor: 'idle growl' }
    const draft = parseRatingDraft(serializeRatingDraft('t-1', form, '2026-10-05T10:00:00+09:00'), trial)
    expect(draft?.form).toEqual(form)
    const messy = JSON.parse(serializeRatingDraft('t-1', form, '2026-10-05T10:00:00+09:00'))
    messy.form.candidates.A.overall = 9; messy.form.candidates.A.termMatch = { other: 1 }; messy.form.best = 'Z'; messy.form.candidates.Z = {}
    const cleaned = parseRatingDraft(JSON.stringify(messy), trial)!
    expect(cleaned.form.candidates.A.overall).toBeNull()
    expect(cleaned.form.candidates.A.termMatch).toEqual({})
    expect(cleaned.form.best).toBeNull()
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
    await writeRatingDraft(root as unknown as FileSystemDirectoryHandle, 't-1', b!.form, b!.savedAt)
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
