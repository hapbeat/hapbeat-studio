import { describe, expect, it } from 'vitest'
import { DEFAULT_SCENE_UI, parseSceneUiFile, parseStoredSceneUi, resolveSceneUi, sanitizeSceneUi, serializeSceneUi } from './sceneUiSettings'

const layout = { grid: { root: {} }, panels: { video: {} } }

describe('scene UI settings', () => {
  it('keeps valid fields, drops unknown ones (the old haptic lead: DEC-093) and keeps haptic send (on by default)', () => {
    const s = sanitizeSceneUi({ pcSound: false, hapticLeadMs: 900, loop: 'x', dockLayout: layout, sendHaptics: false })
    expect(s).toEqual({ ...DEFAULT_SCENE_UI, pcSound: false, dockLayout: layout, sendHaptics: false })
    expect(DEFAULT_SCENE_UI.sendHaptics).toBe(true)
    expect(sanitizeSceneUi({}).sendHaptics).toBe(true)
  })

  it('round-trips the file format and rejects untagged files', () => {
    const settings = { ...DEFAULT_SCENE_UI, loop: false, dockLayout: layout }
    expect(parseSceneUiFile(serializeSceneUi(settings))).toEqual({ ok: true, settings })
    expect(parseSceneUiFile('{"loop":true}').ok).toBe(false)
    expect(parseStoredSceneUi('{"loop":false}')?.loop).toBe(false)
    expect(parseStoredSceneUi('{')).toBeNull()
  })

  it('prefers the project copy, then localStorage, then defaults', () => {
    const folder = serializeSceneUi({ ...DEFAULT_SCENE_UI, leadSec: 2 })
    expect(resolveSceneUi(folder, '{"leadSec":4}')).toMatchObject({ source: 'folder', settings: { leadSec: 2 } })
    expect(resolveSceneUi('{bad', '{"leadSec":4}')).toMatchObject({ source: 'local', settings: { leadSec: 4 }, folderMalformed: expect.any(String) })
    expect(resolveSceneUi(null, null)).toMatchObject({ source: 'default' })
  })
})
