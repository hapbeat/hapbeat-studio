import { describe, expect, it } from 'vitest'
import { DEFAULT_UI_SETTINGS, parseStoredUiSettings, parseUiSettingsFile, resolveUiSettings, sanitizeUiSettings, serializeUiSettings } from './editorUiSettings'

const layout = { grid: { root: {} }, panels: { clips: {} } }

describe('editor UI settings', () => {
  it('keeps valid event marks (clip id or trialId/candidateId keys)', () => {
    const mark = { project: 'trex', event: 'footstep:approach', target: 'haptic' }
    const marks = sanitizeUiSettings({ eventMarks: { c1: [mark, { project: 'x' }], 't-1/A': [{ ...mark, target: 'sound' }], 'bad key': [mark], c2: 'no' } }).eventMarks
    expect(marks).toEqual({ c1: [mark], 't-1/A': [{ ...mark, target: 'sound' }] })
  })

  it('keeps valid fields and replaces invalid ones with defaults', () => {
    const settings = sanitizeUiSettings({ loop: true, loopDelay: 99, height: 'tall', clipGroupBy: 'nope', collapsedGroups: [1], dockLayout: layout, muted: true, sendHaptics: 'no' })
    expect(settings).toEqual({ ...DEFAULT_UI_SETTINGS, loop: true, loopDelay: 60, dockLayout: layout, muted: true })
    expect(sanitizeUiSettings({ dockLayout: { grid: 1 } }).dockLayout).toBeNull()
    expect(sanitizeUiSettings({}).sendHaptics).toBe(true)
    expect(sanitizeUiSettings({ sendHaptics: false }).sendHaptics).toBe(false)
    expect(sanitizeUiSettings({ projectNames: ['trex', ' bad ', 'trex', ''] }).projectNames).toEqual(['trex'])
    expect(sanitizeUiSettings({ projectNames: [1] }).projectNames).toEqual([])
  })

  it('keeps valid scene choices per trial and clamps the scene lead', () => {
    const s = sanitizeUiSettings({ sceneLeadSec: 30, trialScenes: { 't-01': { project: 'trex', file: '03_roar.mp4' }, 'bad id': { project: 'x', file: 'y' }, 't-02': { project: 1 } } })
    expect(s.sceneLeadSec).toBe(10)
    expect(s.trialScenes).toEqual({ 't-01': { project: 'trex', file: '03_roar.mp4' } })
    expect(sanitizeUiSettings({}).sceneLeadSec).toBe(1)
    expect(sanitizeUiSettings({ clipScenes: { 'c1': { project: 'trex', file: '01.mp4' }, 'x': 3 } }).clipScenes).toEqual({ c1: { project: 'trex', file: '01.mp4' } })
  })

  it('roundtrips through the file format and rejects untagged or broken files', () => {
    const settings = { ...DEFAULT_UI_SETTINGS, clipThumbnails: true, dockLayout: layout }
    const parsed = parseUiSettingsFile(serializeUiSettings(settings))
    expect(parsed).toEqual({ ok: true, settings })
    expect(parseUiSettingsFile('{"loop":true}').ok).toBe(false)
    expect(parseUiSettingsFile('{').ok).toBe(false)
  })

  it('reads older untagged localStorage entries leniently', () => {
    expect(parseStoredUiSettings('{"loop":true,"columns":2,"layout":"right"}')?.loop).toBe(true)
    expect(parseStoredUiSettings('[]')).toBeNull()
    expect(parseStoredUiSettings(null)).toBeNull()
    expect(parseStoredUiSettings('{')).toBeNull()
  })

  it('prefers the folder copy, then localStorage, then defaults', () => {
    const folder = serializeUiSettings({ ...DEFAULT_UI_SETTINGS, loop: true })
    const local = JSON.stringify({ ...DEFAULT_UI_SETTINGS, muted: true })
    expect(resolveUiSettings(folder, local)).toMatchObject({ source: 'folder', settings: { loop: true, muted: false } })
    expect(resolveUiSettings(null, local)).toMatchObject({ source: 'local', settings: { muted: true } })
    expect(resolveUiSettings(null, null)).toEqual({ source: 'default', settings: DEFAULT_UI_SETTINGS, folderMalformed: undefined })
    const broken = resolveUiSettings('{oops', local)
    expect(broken.source).toBe('local')
    expect(broken.folderMalformed).toMatch(/Invalid JSON/)
  })

  it('keeps event reserves (valid references only) and the backfill flag', () => {
    const v = sanitizeUiSettings({ eventReserves: { bite: [{ trialId: 't1', candidateId: 'A', target: 'sound' }, { trialId: 3 }], x: 'no' }, reservesBackfilled: true })
    expect(v.eventReserves).toEqual({ bite: [{ trialId: 't1', candidateId: 'A', target: 'sound' }] })
    expect(v.reservesBackfilled).toBe(true)
    expect(sanitizeUiSettings({}).reservesBackfilled).toBe(false)
    // Materials taken off by "back to undecided": name, a haptic's position and gain (clamped).
    expect(sanitizeUiSettings({ eventReserves: { button: [{ material: 'thump', target: 'haptic', at: 'hand', gain: 3 }, { material: 'Clack', target: 'sound' }, { material: '', target: 'sound' }] } }).eventReserves)
      .toEqual({ button: [{ material: 'thump', target: 'haptic', at: 'hand', gain: 2 }, { material: 'Clack', target: 'sound' }] })
  })
})
