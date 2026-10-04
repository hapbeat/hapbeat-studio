import { describe, expect, it } from 'vitest'
import { DEFAULT_SCENE_UI, parseSceneUiFile, parseStoredSceneUi, resolveSceneUi, sanitizeSceneUi, serializeSceneUi } from './sceneUiSettings'

const layout = { grid: { root: {} }, panels: { video: {} } }

describe('scene UI settings', () => {
  it('keeps valid fields, clamps the lead and never stores haptic send', () => {
    const s = sanitizeSceneUi({ pcSound: false, hapticLeadMs: 900, loop: 'x', dockLayout: layout, sendHaptics: true })
    expect(s).toEqual({ ...DEFAULT_SCENE_UI, pcSound: false, hapticLeadMs: 400, dockLayout: layout })
    expect('sendHaptics' in s).toBe(false)
  })

  it('round-trips the file format and rejects untagged files', () => {
    const settings = { ...DEFAULT_SCENE_UI, loop: false, dockLayout: layout }
    expect(parseSceneUiFile(serializeSceneUi(settings))).toEqual({ ok: true, settings })
    expect(parseSceneUiFile('{"loop":true}').ok).toBe(false)
    expect(parseStoredSceneUi('{"loop":false}')?.loop).toBe(false)
    expect(parseStoredSceneUi('{')).toBeNull()
  })

  it('prefers the project copy, then localStorage, then defaults', () => {
    const folder = serializeSceneUi({ ...DEFAULT_SCENE_UI, hapticLeadMs: 20 })
    expect(resolveSceneUi(folder, '{"hapticLeadMs":40}')).toMatchObject({ source: 'folder', settings: { hapticLeadMs: 20 } })
    expect(resolveSceneUi('{bad', '{"hapticLeadMs":40}')).toMatchObject({ source: 'local', settings: { hapticLeadMs: 40 }, folderMalformed: expect.any(String) })
    expect(resolveSceneUi(null, null)).toMatchObject({ source: 'default' })
  })
})
