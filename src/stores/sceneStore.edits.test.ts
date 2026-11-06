import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { serializeCueTable } from '@/utils/sceneCueTable'
import { memoryFolder, sampleLib, sampleTable, sampleViewerDataFile, sampleViewerLibFile } from '@/utils/sceneTestFixtures'
import { VERSIONS_DIR } from '@/utils/sceneVersions'

const storage = new Map<string, string>()
vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, v) }, removeItem: (k: string) => { storage.delete(k) } })
vi.stubGlobal('OfflineAudioContext', class { decodeAudioData() { return Promise.resolve({ length: 1, numberOfChannels: 1, getChannelData: () => new Float32Array(1) }) } })

const lib = sampleLib()
const VIEWER_DATA = 'Saved/HapticViewer/viewer-data.json'
const EDITS = 'Saved/HapticViewer/viewer-edits.json'
const files = (extra: Record<string, string> = {}) => ({
  'Saved/HapticViewer/viewer-lib.json': JSON.stringify(sampleViewerLibFile()),
  [VIEWER_DATA]: `${JSON.stringify(sampleViewerDataFile(), null, 2)}\n`,
  [lib.paths.cues]: serializeCueTable(sampleTable()),
  [`${lib.paths.clips}/click.wav`]: 'x', [`${lib.paths.clips}/thump.wav`]: 'x', [`${lib.paths.clips}/hum.wav`]: 'x',
  [`${lib.paths.sounds}/Click.wav`]: 'x', [`${lib.paths.sounds}/Motor.wav`]: 'x',
  ...extra,
})
type Folder = ReturnType<typeof memoryFolder>
async function openPage(folder: Folder) {
  vi.resetModules()
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {}, showDirectoryPicker: async () => folder.handle })
  const { useSceneStore } = await import('./sceneStore')
  const strength = await import('./sceneStrength')
  await useSceneStore.getState().pick()
  return { store: useSceneStore, strength }
}
/** Writes a file of the folder as another program would. */
async function put(folder: Folder, path: string, text: string) {
  const parts = path.split('/')
  let dir = folder.handle
  for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true })
  const w = await (await dir.getFileHandle(parts[parts.length - 1], { create: true })).createWritable()
  await w.write(text); await w.close()
}
const versionFolders = async (folder: Folder) => {
  const dir = await (await (await folder.handle.getDirectoryHandle('Saved')).getDirectoryHandle('HapticViewer')).getDirectoryHandle('versions').catch(() => null)
  const out: string[] = []
  if (dir) for await (const [name] of dir.entries()) out.push(name)
  return out
}
const versionOf = (folder: Folder, id: string) => JSON.parse(folder.read(`${VERSIONS_DIR}/${id}/version.json`)!) as { reason: string; label: string; firings: number }

beforeEach(() => { storage.clear(); vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] }) })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

describe('firing edits → viewer-edits.json (the recording is never written)', () => {
  it('data changes at once, viewer-edits.json 300 ms later; viewer-data.json and the cue table stay byte for byte', async () => {
    const folder = memoryFolder(files()), { store } = await openPage(folder)
    const before = store.getState().recorded!, data = folder.read(VIEWER_DATA)!, cues = folder.read(lib.paths.cues)!
    store.getState().setFiringEdits(new Map([[1, { gain: 0.25 }]]))
    const s = store.getState()
    expect(s.recorded).toBe(before)
    expect(s.edited!.full.events[1].gain).toBe(0.25)
    expect(s.data!.full.events.find(e => e.name === 'button')!.gain).toBe(0.25)
    // The same levels: the runtime keeps its video.
    expect(s.data!.full.levels).toBe(before.full.levels)
    expect(folder.exists(EDITS)).toBe(false)
    await vi.advanceTimersByTimeAsync(400)
    expect(JSON.parse(folder.read(EDITS)!)).toEqual({ schema_version: 1, firings: [{ of: { name: 'button', t: 3, hand: 'right' }, gain: 0.25 }] })
    expect(folder.read(VIEWER_DATA)).toBe(data)
    expect(folder.read(lib.paths.cues)).toBe(cues)
  })

  it('reads the edits when the project opens; one that matches no firing is kept, counted and removed on request', async () => {
    const text = `${JSON.stringify({ schema_version: 1, firings: [{ of: { name: 'button', t: 3.01, hand: 'right' }, gain: 0.5 }, { of: { name: 'gone', t: 2 }, gain: 1 }] }, null, 2)}\n`
    const folder = memoryFolder(files({ [EDITS]: text })), { store } = await openPage(folder)
    expect(store.getState().edited!.full.events[1].gain).toBe(0.5)
    expect(store.getState().editsOrphans).toBe(1)
    await vi.advanceTimersByTimeAsync(2100)
    expect(folder.read(EDITS)).toBe(text)
    store.getState().removeOrphanEdits()
    await vi.advanceTimersByTimeAsync(400)
    expect(store.getState().editsOrphans).toBe(0)
    expect(JSON.parse(folder.read(EDITS)!).firings).toEqual([{ of: { name: 'button', t: 3.01, hand: 'right' }, gain: 0.5 }])
  })

  it('an unreadable file is kept under a new name and the project opens without edits', async () => {
    const folder = memoryFolder(files({ [EDITS]: '{"schema_version": 1, "fir' })), { store } = await openPage(folder)
    expect(store.getState().edits.firings).toEqual([])
    expect(store.getState().notice).toMatchObject({ id: 'scene.edits.unreadable' })
    const keptAs = (store.getState().notice!.params as { keptAs: string }).keptAs
    expect(folder.read(`Saved/HapticViewer/${keptAs}`)).toBe('{"schema_version": 1, "fir')
  })

  it('a change made outside Studio is read again; while an edit is pending, Studio\'s is written over it and said so', async () => {
    const folder = memoryFolder(files()), { store } = await openPage(folder)
    await put(folder, EDITS, JSON.stringify({ schema_version: 1, firings: [{ of: { name: 'button', t: 3, hand: 'right' }, gain: 0.7 }] }))
    await vi.advanceTimersByTimeAsync(2100)
    expect(store.getState().edited!.full.events[1].gain).toBe(0.7)
    store.getState().setFiringEdits(new Map([[0, { gain: 0.2 }]]))
    await put(folder, EDITS, JSON.stringify({ schema_version: 1, firings: [] }))
    await vi.advanceTimersByTimeAsync(400)
    expect(store.getState().notice).toMatchObject({ id: 'scene.edits.overwritten' })
    expect(JSON.parse(folder.read(EDITS)!).firings).toHaveLength(2)
    expect(store.getState().edited!.full.events[1].gain).toBe(0.7)
  })

  it('a firing moved past its neighbour plays at its new time, in time order, and the moments follow it', async () => {
    const folder = memoryFolder(files()), { store } = await openPage(folder)
    const levels = store.getState().data!.full.levels
    store.getState().setFiringEdits(new Map([[1, { t: 4 }]]))
    const s = store.getState()
    expect(s.data!.full.events.map(e => [e.name, e.t])).toEqual([['detent', 1], ['grab', 3.1], ['detent', 3.15], ['button', 4], ['feed_loop', 4.5]])
    expect(s.data!.full.levels).toBe(levels)
    expect(s.items.some(it => it.kind === 'clip' && it.name === 'button' && it.at === 4)).toBe(true)
    await vi.advanceTimersByTimeAsync(400)
    expect(JSON.parse(folder.read(EDITS)!).firings).toEqual([{ of: { name: 'button', t: 3, hand: 'right' }, t: 4 }])
  })

  it('a firing moved into another moment: both moments\' cues follow (the list is made again)', async () => {
    const folder = memoryFolder(files()), { store } = await openPage(folder)
    const clip = (name: string) => store.getState().items.find(it => it.kind === 'clip' && it.name === name)!
    expect(clip('button').names).toEqual(['button', 'grab'])
    // grab (3.1) next to feed_loop (4.5): the first cues and times of the moments stay the same.
    store.getState().setFiringEdits(new Map([[2, { t: 4.6 }]]))
    expect(clip('button').names).toEqual(['button'])
    expect(clip('feed_loop').names).toEqual(['feed_loop', 'grab'])
  })

  it('an override names a firing at its recorded time: it still applies after the firing\'s time was edited', async () => {
    const folder = memoryFolder(files()), { store } = await openPage(folder)
    store.getState().setOverrides([{ from: 'button', atSec: 3, to: 'grab', requestedAt: '' }])
    const at = (t: number) => store.getState().data!.full.events.find(e => e.t === t) as { name: string; from?: string }
    expect(at(3)).toMatchObject({ name: 'grab', from: 'button' })
    store.getState().setFiringEdits(new Map([[1, { t: 4 }]]))
    expect(at(4)).toMatchObject({ name: 'grab', from: 'button' })
    // The moment made again at its new time keeps the mark (its recorded name).
    expect(store.getState().items.find(it => it.kind === 'clip' && it.at === 4)).toMatchObject({ name: 'grab', from: 'button' })
  })
})

describe('strength undo / redo of firing edits', () => {
  it('gain and time, each one step, restoring the entries exactly', async () => {
    const folder = memoryFolder(files()), { store, strength } = await openPage(folder)
    const st = () => strength.useSceneStrength.getState()
    st().select([1], 'replace')
    expect(st().scaleSelected(0.5)).toBe(true)
    expect(st().moveSelected(0.51)).toBe(true)
    const ev = () => store.getState().edited!.full.events[1]
    // Snapped to frames: 3 + 0.51 → 3.5 (frame 105).
    expect(ev()).toMatchObject({ gain: 0.5, t: 3.5 })
    st().undoLast()
    expect(ev()).toMatchObject({ gain: 0.5, t: 3 })
    st().undoLast()
    expect(ev()).toMatchObject({ gain: 1, t: 3 })
    expect(store.getState().edits.firings).toEqual([])
    st().redoLast(); st().redoLast()
    expect(ev()).toMatchObject({ gain: 0.5, t: 3.5 })
    // Back to the recorded values: one step, the entry gone.
    expect(st().resetSelected()).toBe(true)
    expect(store.getState().edits.firings).toEqual([])
    st().undoLast()
    expect(ev()).toMatchObject({ gain: 0.5, t: 3.5 })
  })

  it('an undo step that can no longer apply is dropped with a notice; the older ones still work', async () => {
    const folder = memoryFolder(files()), { store, strength } = await openPage(folder)
    const { setRouteGains } = await import('@/utils/sceneStrength')
    const st = () => strength.useSceneStrength.getState()
    store.getState().edit(tb => setRouteGains(tb, { cue: 'button', variant: null }, [0.5])); st().pushRoutes('button', [1], [0.5])
    store.getState().edit(tb => setRouteGains(tb, { cue: 'detent', variant: null }, [1])); st().pushRoutes('detent', [0.5], [1])
    // detent loses its routes (as if changed outside Studio).
    store.getState().edit(tb => ({ ...tb, cues: { ...tb.cues, detent: { ...tb.cues.detent, haptics: [] } } }))
    st().undoLast()
    expect(store.getState().notice).toMatchObject({ id: 'scene.strength.stepDropped' })
    expect(st().undo).toHaveLength(1)
    st().undoLast()
    expect(store.getState().table!.cues.button.haptics![0].gain).toBe(1)
    expect(st().redo).toHaveLength(1)
  })
})

describe('versions', () => {
  it('the first edit after the project opened saves a before-edit version (once); opened again, once more', async () => {
    const folder = memoryFolder(files()), { store } = await openPage(folder)
    store.getState().setFiringEdits(new Map([[1, { gain: 0.25 }]]))
    store.getState().setFiringEdits(new Map([[1, { gain: 0.3 }]]))
    await vi.advanceTimersByTimeAsync(400)
    await vi.waitFor(async () => { expect(await versionFolders(folder)).toHaveLength(1) })
    const [first] = await versionFolders(folder)
    expect(versionOf(folder, first)).toMatchObject({ reason: 'before-edit', firings: 0 })
    // The state before the edit: no edits file then, the cue table as it was.
    expect(folder.exists(`${VERSIONS_DIR}/${first}/viewer-edits.json`)).toBe(false)
    expect(folder.read(`${VERSIONS_DIR}/${first}/cues.json`)).toBe(serializeCueTable(sampleTable()))
    await store.getState().pick()
    store.getState().setFiringEdits(new Map([[1, { gain: 0.4 }]]))
    await vi.waitFor(async () => { expect(await versionFolders(folder)).toHaveLength(2) })
    expect(store.getState().notice?.error).toBeFalsy()
  })

  it('restores a version: the current state saved first, its edits written, its strength values set as one undo step', async () => {
    const folder = memoryFolder(files()), { store, strength } = await openPage(folder)
    const { setRouteGains } = await import('@/utils/sceneStrength')
    store.getState().setFiringEdits(new Map([[1, { gain: 0.25 }]]))
    const id = (await store.getState().saveVersion('Mix A'))!
    expect(id).toMatch(/-mix-a$/)
    expect(versionOf(folder, id)).toMatchObject({ reason: 'manual', label: 'Mix A', firings: 1 })
    // Changed after the version: another firing gain, the button route.
    store.getState().setFiringEdits(new Map([[1, { gain: 0.9 }], [0, { gain: 0.1 }]]))
    store.getState().edit(tb => setRouteGains(tb, { cue: 'button', variant: null }, [0.4]))
    const result = await strength.restoreVersion(id)
    expect(result).toMatchObject({ ok: true, skipped: [] })
    expect(store.getState().edits.firings).toEqual([{ of: { name: 'button', t: 3, hand: 'right' }, gain: 0.25 }])
    expect(JSON.parse(folder.read(EDITS)!).firings).toEqual([{ of: { name: 'button', t: 3, hand: 'right' }, gain: 0.25 }])
    expect(store.getState().table!.cues.button.haptics![0].gain).toBe(1)
    const reasons = (await store.getState().listVersions()).map(v => v.reason)
    expect(reasons[0]).toBe('before-restore')
    expect(reasons).toContain('manual')
    // Ctrl+Z puts the strength values and the edits back as they were before the restore (one step), Ctrl+Y again.
    const entries = () => store.getState().edits.firings.map(e => [e.of.name, e.gain]).sort()
    strength.useSceneStrength.getState().undoLast()
    expect(store.getState().table!.cues.button.haptics![0].gain).toBe(0.4)
    expect(entries()).toEqual([['button', 0.9], ['detent', 0.1]])
    strength.useSceneStrength.getState().redoLast()
    expect(store.getState().table!.cues.button.haptics![0].gain).toBe(1)
    expect(entries()).toEqual([['button', 0.25]])
    strength.useSceneStrength.getState().undoLast()
    // 「消す」 moves it to _archive.
    await store.getState().deleteVersion(id)
    expect((await store.getState().listVersions()).some(v => v.id === id)).toBe(false)
    expect(folder.exists(`Saved/HapticViewer/_archive/versions/${id}/version.json`)).toBe(true)
  })
})
