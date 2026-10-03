import { describe, expect, it } from 'vitest'
import { DEFAULT_UI_SETTINGS, parseStoredUiSettings, parseUiSettingsFile, resolveUiSettings, sanitizeUiSettings, serializeUiSettings } from './editorUiSettings'

const layout = { grid: { root: {} }, panels: { clips: {} } }

describe('editor UI settings', () => {
  it('keeps valid fields and replaces invalid ones with defaults', () => {
    const settings = sanitizeUiSettings({ loop: true, loopDelay: 99, height: 'tall', clipGroupBy: 'nope', collapsedGroups: [1], dockLayout: layout, muted: true, sendHaptics: 'no' })
    expect(settings).toEqual({ ...DEFAULT_UI_SETTINGS, loop: true, loopDelay: 60, dockLayout: layout, muted: true })
    expect(sanitizeUiSettings({ dockLayout: { grid: 1 } }).dockLayout).toBeNull()
    expect(sanitizeUiSettings({}).sendHaptics).toBe(true)
    expect(sanitizeUiSettings({ sendHaptics: false }).sendHaptics).toBe(false)
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
})
