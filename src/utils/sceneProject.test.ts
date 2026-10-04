import { describe, expect, it } from 'vitest'
import { keepSceneUiSettingsCopy, openSceneProject, readSceneTable, readSceneUiSettings, writeSceneSave, writeSceneUiSettings } from './sceneProject'
import { parseCueTable, serializeCueTable } from './sceneCueTable'
import { memoryFolder, sampleData, sampleLib, sampleTable } from './sceneTestFixtures'

const project = () => {
  const lib = sampleLib()
  return memoryFolder({
    'Saved/HapticViewer/viewer-lib.json': JSON.stringify(lib),
    'Saved/HapticViewer/viewer-data.json': JSON.stringify(sampleData()),
    [lib.paths.cues]: serializeCueTable(sampleTable()),
    [`${lib.paths.clips}/click.wav`]: 'x', [`${lib.paths.clips}/thump.wav`]: 'x', [`${lib.paths.clips}/hum.wav`]: 'x',
    [`${lib.paths.sounds}/Click.wav`]: 'x', [`${lib.paths.sounds}/Motor.wav`]: 'x', [`${lib.paths.sounds}/readme.txt`]: 'x',
  })
}

describe('scene project folder', () => {
  it('opens a recorded project and reads its cue table and WAV lists', async () => {
    const folder = project()
    const opened = await openSceneProject(folder.handle)
    expect(opened.ok).toBe(true)
    if (!opened.ok) return
    expect(opened.data.clips).toHaveLength(1)
    const files = await readSceneTable(folder.handle, opened.lib)
    expect(files.table).toEqual(sampleTable())
    expect(files.clipFiles).toEqual(['click', 'hum', 'thump'])
    expect(files.soundFiles).toEqual(['Click']) // loop sounds and non-WAVs are not cue sounds
  })

  it('tells a folder without a lib from a project without a recording', async () => {
    expect(await openSceneProject(memoryFolder({}).handle)).toMatchObject({ ok: false, reason: 'noLib' })
    const unrecorded = memoryFolder({ 'Saved/HapticViewer/viewer-lib.json': JSON.stringify(sampleLib()) })
    expect(await openSceneProject(unrecorded.handle)).toMatchObject({ ok: false, reason: 'noData', lib: { record_command: 'record.ps1' } })
  })

  it('writes new WAVs and the cue table exactly where the viewer did', async () => {
    const folder = project(), lib = sampleLib()
    const table = sampleTable()
    table.clips.new_hit = { intensity: 1, loop: false }
    await writeSceneSave(folder.handle, lib, table, { clips: { new_hit: new TextEncoder().encode('RIFF').buffer }, sounds: { Bell: new TextEncoder().encode('RIFF').buffer } })
    expect(folder.read(`${lib.paths.clips}/new_hit.wav`)).toBe('RIFF')
    expect(folder.read(`${lib.paths.sounds}/Bell.wav`)).toBe('RIFF')
    expect(folder.read(lib.paths.cues)).toBe(serializeCueTable(table))
    expect(parseCueTable(folder.read(lib.paths.cues)!).clips.new_hit.intensity).toBe(1)
    expect(folder.exists(`${lib.paths.clips}/click.wav`)).toBe(true) // nothing removed
  })

  it('keeps its UI settings next to the recording', async () => {
    const folder = project()
    expect(await readSceneUiSettings(folder.handle)).toBeNull()
    await writeSceneUiSettings(folder.handle, '{"a":1}')
    expect(await readSceneUiSettings(folder.handle)).toBe('{"a":1}')
    const kept = await keepSceneUiSettingsCopy(folder.handle, 'broken')
    expect(folder.read(`Saved/HapticViewer/${kept}`)).toBe('broken')
  })
})
