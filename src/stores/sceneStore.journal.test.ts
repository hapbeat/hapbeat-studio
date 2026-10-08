import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseCueTable, serializeCueTable, type CueTable } from '@/utils/sceneCueTable'
import { memoryFolder, sampleData, sampleLib, sampleTable } from '@/utils/sceneTestFixtures'
import { journalKey, readJournal, restoreFromJournal } from '@/utils/sceneJournal'
import { CueTableSync } from '@/utils/cueTableSync'
import { setEmit, setLevelMap } from '@/utils/cueEvents'

/** A localStorage that outlives a "reload" (vi.resetModules), like the browser's. */
const storage = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, v) }, removeItem: (k: string) => { storage.delete(k) },
})
/** Decoding is not what these tests check: every WAV decodes to one silent sample. */
vi.stubGlobal('OfflineAudioContext', class { decodeAudioData() { return Promise.resolve({ length: 1, numberOfChannels: 1, getChannelData: () => new Float32Array(1) }) } })

const lib = sampleLib()
const project = () => memoryFolder({
  'Saved/HapticViewer/viewer-lib.json': JSON.stringify(lib),
  'Saved/HapticViewer/viewer-data.json': JSON.stringify(sampleData()),
  [lib.paths.cues]: serializeCueTable(sampleTable()),
  [`${lib.paths.clips}/click.wav`]: 'x', [`${lib.paths.clips}/thump.wav`]: 'x', [`${lib.paths.clips}/hum.wav`]: 'x',
  [`${lib.paths.sounds}/Click.wav`]: 'x', [`${lib.paths.sounds}/Motor.wav`]: 'x',
})
const key = journalKey(lib.project_name, lib.paths.cues)
const map = { points: [[0.5, 0.3]] as [number, number][] }

/** Opens `folder` in a fresh store (a page load) through the folder picker. */
async function openPage(folder: ReturnType<typeof memoryFolder>) {
  vi.resetModules()
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {}, showDirectoryPicker: async () => folder.handle })
  const { useSceneStore } = await import('./sceneStore')
  await useSceneStore.getState().pick()
  return useSceneStore
}
/** Writes the file as another tool would (outside Studio). */
async function writeOutside(folder: ReturnType<typeof memoryFolder>, table: CueTable) {
  const dir = await (await folder.handle.getDirectoryHandle('Content')).getDirectoryHandle('Hapbeat')
  const w = await (await dir.getFileHandle('cues.json')).createWritable()
  await w.write(serializeCueTable(table)); await w.close()
}

beforeEach(() => { storage.clear(); vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] }) })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

describe('Scene edits survive a reload before the autosave (journal)', () => {
  it('an edit is journaled at once; a reload before the 300 ms save restores it, saves it and clears the journal', async () => {
    const folder = project()
    let store = await openPage(folder)
    expect(store.getState().table).toEqual(sampleTable())
    store.getState().edit(tb => setLevelMap(tb, 'feed_loop', 0, map))
    expect(readJournal(key)).not.toBeNull() // synchronously, before any file write
    expect(parseCueTable(folder.read(lib.paths.cues)!).cues.feed_loop.haptics![0].levelMap).toBeUndefined()
    // Reload: the old page's timers never fire.
    vi.clearAllTimers()
    store = await openPage(folder)
    expect(store.getState().table!.cues.feed_loop.haptics![0].levelMap).toEqual(map)
    expect(store.getState().dirty).toBe(true)
    expect(store.getState().notice).toEqual({ id: 'scene.journal.restored' })
    await vi.advanceTimersByTimeAsync(400)
    expect(parseCueTable(folder.read(lib.paths.cues)!).cues.feed_loop.haptics![0].levelMap).toEqual(map)
    expect(store.getState().dirty).toBe(false)
    expect(readJournal(key)).toBeNull()
    // Opened again: nothing to restore.
    store = await openPage(folder)
    expect(store.getState().notice).toEqual({ id: 'scene.open.loaded', params: { folder: 'project' } })
  })

  it('an outside change to another cue meanwhile + the journaled levelMap edit: both kept', async () => {
    const folder = project()
    let store = await openPage(folder)
    store.getState().edit(tb => setLevelMap(tb, 'feed_loop', 0, map))
    vi.clearAllTimers()
    const outside = sampleTable(); outside.cues.detent.haptics![0].gain = 0.9
    await writeOutside(folder, outside)
    store = await openPage(folder)
    await vi.advanceTimersByTimeAsync(400)
    const saved = parseCueTable(folder.read(lib.paths.cues)!)
    expect(saved.cues.feed_loop.haptics![0].levelMap).toEqual(map)
    expect(saved.cues.detent.haptics![0].gain).toBe(0.9)
    expect(readJournal(key)).toBeNull()
  })

  it('the same field changed outside: the journaled Studio edit wins and is reported', async () => {
    const folder = project()
    let store = await openPage(folder)
    store.getState().edit(tb => setLevelMap(tb, 'feed_loop', 0, map))
    vi.clearAllTimers()
    const outside = sampleTable(); outside.cues.feed_loop.haptics![0].gain = 0.5
    await writeOutside(folder, outside)
    store = await openPage(folder)
    expect(store.getState().notice).toEqual({ id: 'scene.journal.restoredConflicts', params: { fields: 'cues.feed_loop.haptics' } })
    await vi.advanceTimersByTimeAsync(400)
    const saved = parseCueTable(folder.read(lib.paths.cues)!)
    expect(saved.cues.feed_loop.haptics![0]).toEqual({ clip: 'hum', at: 'hand', gain: 0.8, levelMap: map })
  })

  it('revert drops the journal with the unsaved edits', async () => {
    const folder = project()
    let store = await openPage(folder)
    store.getState().edit(tb => setLevelMap(tb, 'feed_loop', 0, map))
    await store.getState().revert()
    expect(readJournal(key)).toBeNull()
    vi.clearAllTimers()
    store = await openPage(folder)
    expect(store.getState().table).toEqual(sampleTable())
  })
})

describe('outside changes never drop Studio-only fields of a pending edit', () => {
  it('levelMap / emit / alternates / distanceFalloff pending in Studio + another cue changed in the file: all kept', async () => {
    const base = sampleTable()
    let ours = setLevelMap(base, 'feed_loop', 0, map)
    ours = setEmit(ours, 'detent', { during: 'feed_loop', intervalSec: 0.5 })
    ours = structuredClone(ours)
    ours.cues.button.sfx = { ...ours.cues.button.sfx!, alternates: ['Bell'] }
    ours.cues.button.distanceFalloff = { nearCm: 100, farCm: 500, farGain: 0.2 }
    const theirs = sampleTable(); theirs.cues.grab.description = 'changed outside'
    let file = serializeCueTable(theirs)
    const sync = new CueTableSync<null>({ read: async () => ({ text: file, mtime: 2 }), write: async t => { file = serializeCueTable(t); return 3 } })
    sync.reset(serializeCueTable(base), 1)
    const result = await sync.save(ours, null, async () => [])
    expect(result).toMatchObject({ ok: true, external: true, conflicts: [] })
    const saved = parseCueTable(file)
    expect(saved.cues.feed_loop.haptics![0].levelMap).toEqual(map)
    expect(saved.cues.detent.emit).toEqual(ours.cues.detent.emit)
    expect(saved.cues.button.sfx!.alternates).toEqual(['Bell'])
    expect(saved.cues.button.distanceFalloff).toEqual({ nearCm: 100, farCm: 500, farGain: 0.2 })
    expect(saved.cues.grab.description).toBe('changed outside')
    // The same through the journal (a reload in between).
    expect(restoreFromJournal({ table: serializeCueTable(ours), base: serializeCueTable(base), savedAt: 0 }, serializeCueTable(theirs))!.table).toEqual(saved)
  })
})
