import { describe, expect, it } from 'vitest'
import { createSceneTable, keepSceneUiSettingsCopy, openSceneProject, readSceneTable, readSceneUiSettings, writeSceneSave, writeSceneUiSettings } from './sceneProject'
import { parseCueTable, serializeCueTable } from './sceneCueTable'
import { memoryFolder, sampleLib, sampleTable, sampleViewerDataFile, sampleViewerLibFile } from './sceneTestFixtures'

const project = () => {
  const lib = sampleLib()
  return memoryFolder({
    'Saved/HapticViewer/viewer-lib.json': JSON.stringify(sampleViewerLibFile()),
    'Saved/HapticViewer/viewer-data.json': JSON.stringify(sampleViewerDataFile()),
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
    expect(opened.lib).toEqual(sampleLib())
    // detent (tick) · button + grab · detent (tick) · feed_loop
    expect(opened.data.clips.map(c => c.names)).toEqual([['detent'], ['button', 'grab'], ['detent'], ['feed_loop']])
    const files = (await readSceneTable(folder.handle, opened.lib))!
    expect(files.table).toEqual(sampleTable())
    expect(files.clipFiles).toEqual(['click', 'hum', 'thump'])
    expect(files.soundFiles).toEqual(['Click', 'Motor']) // every WAV is a sound candidate (no loop_sounds in v1); non-WAVs are not
  })

  it('makes the layers from the column names when the lib names none', async () => {
    const { layers: _omitted, ...lib } = sampleViewerLibFile()
    const folder = memoryFolder({ 'Saved/HapticViewer/viewer-lib.json': JSON.stringify(lib), 'Saved/HapticViewer/viewer-data.json': JSON.stringify(sampleViewerDataFile()) })
    const opened = await openSceneProject(folder.handle)
    expect(opened).toMatchObject({ ok: true, lib: { layers: [{ cue: 'feed_loop', gain: [0, 1], rate: [2, 3] }], loop_cues: ['feed_loop'] } })
  })

  it('reports an older format (another schema_version) as such', async () => {
    const old = memoryFolder({ 'Saved/HapticViewer/viewer-lib.json': JSON.stringify({ ...sampleViewerLibFile(), schema_version: undefined }) })
    expect(await openSceneProject(old.handle)).toMatchObject({ ok: false, reason: 'noLib', oldFormat: true })
    const oldData = memoryFolder({ 'Saved/HapticViewer/viewer-lib.json': JSON.stringify(sampleViewerLibFile()), 'Saved/HapticViewer/viewer-data.json': JSON.stringify({ fps: 30, clips: [], full: {} }) })
    expect(await openSceneProject(oldData.handle)).toMatchObject({ ok: false, reason: 'noData', oldFormat: true })
  })

  it('opens a project without a cue table, and creates one only when asked (never over an existing one)', async () => {
    const lib = sampleLib()
    const folder = memoryFolder({ 'Saved/HapticViewer/viewer-lib.json': JSON.stringify(sampleViewerLibFile()), 'Saved/HapticViewer/viewer-data.json': JSON.stringify(sampleViewerDataFile()) })
    const opened = await openSceneProject(folder.handle)
    if (!opened.ok) throw new Error('not opened')
    expect(await readSceneTable(folder.handle, lib)).toBeNull()
    expect(folder.exists(lib.paths.cues)).toBe(false)
    const made = await createSceneTable(folder.handle, opened.lib, opened.data)
    expect(made).toEqual({ schema_version: 1, kit: 'mill-kit', clips: {}, sounds: {}, cues: { button: {}, detent: {}, feed_loop: { loop: true }, grab: {} } })
    expect(parseCueTable(folder.read(lib.paths.cues)!)).toEqual(made)
    await expect(createSceneTable(folder.handle, opened.lib, opened.data)).rejects.toThrow(/exists already/)
    expect(await readSceneTable(folder.handle, lib)).toMatchObject({ table: made, clipFiles: [], soundFiles: [] })
  })

  it('tells a folder without a lib from a project without a recording', async () => {
    expect(await openSceneProject(memoryFolder({}).handle)).toMatchObject({ ok: false, reason: 'noLib' })
    const unrecorded = memoryFolder({ 'Saved/HapticViewer/viewer-lib.json': JSON.stringify(sampleViewerLibFile()) })
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
