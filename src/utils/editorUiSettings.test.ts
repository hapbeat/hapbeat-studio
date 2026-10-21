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

  it('folds the sound and haptic sections separately; a single fold saved before seeds both once', () => {
    expect(sanitizeUiSettings({})).toMatchObject({ soundMaterialsOpen: true, hapticMaterialsOpen: true, soundReservesOpen: true, hapticReservesOpen: true })
    const old = sanitizeUiSettings({ materialsOpen: false, reservesOpen: false })
    expect(old).toMatchObject({ soundMaterialsOpen: false, hapticMaterialsOpen: false, soundReservesOpen: false, hapticReservesOpen: false })
    expect(JSON.parse(serializeUiSettings(old))).not.toHaveProperty('materialsOpen')
    expect(JSON.parse(serializeUiSettings(old))).not.toHaveProperty('reservesOpen')
    const split = sanitizeUiSettings({ materialsOpen: false, soundMaterialsOpen: true, hapticReservesOpen: false })
    expect(split).toMatchObject({ soundMaterialsOpen: true, hapticMaterialsOpen: false, soundReservesOpen: true, hapticReservesOpen: false })
  })

  it('keeps valid scene choices per trial and clamps the scene lead', () => {
    const s = sanitizeUiSettings({ sceneLeadSec: 30, trialScenes: { 't-01': { project: 'trex', at: 7.9 }, 't-03': { project: 'trex', at: null }, 'bad id': { project: 'x', at: 1 }, 't-02': { project: 1, at: 1 }, 't-04': { project: 'trex', file: '03_roar.mp4' }, 't-05': { project: 'trex', at: -1 } } })
    expect(s.sceneLeadSec).toBe(10)
    expect(s.trialScenes).toEqual({ 't-01': { project: 'trex', at: 7.9 }, 't-03': { project: 'trex', at: null } })
    expect(sanitizeUiSettings({}).sceneLeadSec).toBe(1)
    expect(sanitizeUiSettings({ clipScenes: { 'c1': { project: 'trex', at: 1.3, extra: 1 }, 'x': 3 } }).clipScenes).toEqual({ c1: { project: 'trex', at: 1.3 } })
  })

  it('clamps the scene post-roll to 0–5 s (default 0 s)', () => {
    const fromSound = { scenePostRollFromSound: true }
    expect(sanitizeUiSettings({}).scenePostRollSec).toBe(0)
    expect(sanitizeUiSettings({ ...fromSound, scenePostRollSec: 2.5 }).scenePostRollSec).toBe(2.5)
    expect(sanitizeUiSettings({ ...fromSound, scenePostRollSec: 9 }).scenePostRollSec).toBe(5)
    expect(sanitizeUiSettings({ ...fromSound, scenePostRollSec: -1 }).scenePostRollSec).toBe(0)
    expect(sanitizeUiSettings({ ...fromSound, scenePostRollSec: 'x' }).scenePostRollSec).toBe(0)
  })

  it('resets a post-roll saved before it counted from the sound end to 0 once, then keeps the user value', () => {
    const migrated = sanitizeUiSettings({ scenePostRollSec: 1 })
    expect(migrated.scenePostRollSec).toBe(0)
    expect(migrated.scenePostRollFromSound).toBe(true)
    const changed = parseStoredUiSettings(JSON.stringify({ ...migrated, scenePostRollSec: 1.5 }))
    expect(changed?.scenePostRollSec).toBe(1.5)
    expect(sanitizeUiSettings(changed).scenePostRollSec).toBe(1.5)
  })

  it('keeps the context toggle (default on) and the hand-edited event groups per project', () => {
    expect(sanitizeUiSettings({}).sceneContext).toBe(true)
    expect(sanitizeUiSettings({ sceneContext: false }).sceneContext).toBe(false)
    expect(sanitizeUiSettings({ sceneContext: 'no' }).sceneContext).toBe(true)
    expect(sanitizeUiSettings({ eventGroupEdits: { mill: { detached: ['cut_loop', 'cut_loop'], joined: [['engage', 'feed_loop'], ['x', 'x'], ['a'], 3] }, bad: 3, empty: { detached: [], joined: [] } } }).eventGroupEdits)
      .toEqual({ mill: { detached: ['cut_loop'], joined: [['engage', 'feed_loop']] } })
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
