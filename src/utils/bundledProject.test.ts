import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bundledFileUrl, isBundledProject, openBundledProject } from './bundledProject'
import { isNotFound, listWavs, openSceneProject, readProjectFile } from './sceneProject'
import { serializeCueTable } from './sceneCueTable'
import { memoryFolder, sampleLib, sampleTable, sampleViewerDataFile, sampleViewerLibFile } from './sceneTestFixtures'

const BASE = 'https://studio.hapbeat.com/__project/'
const MTIME = 1793546366434
const lib = sampleLib()
const files: Record<string, string> = {
  'Saved/HapticViewer/viewer-lib.json': JSON.stringify(sampleViewerLibFile()),
  'Saved/HapticViewer/viewer-data.json': JSON.stringify(sampleViewerDataFile()),
  [lib.paths.cues]: serializeCueTable(sampleTable()),
  [`${lib.paths.clips}/click.wav`]: 'x', [`${lib.paths.clips}/thump.wav`]: 'x', [`${lib.paths.clips}/hum.wav`]: 'x',
  [`${lib.paths.sounds}/Click.wav`]: 'x', [`${lib.paths.sounds}/Motor.wav`]: 'x',
  'Saved/HapticViewer/a b+c.mp4': 'video',
}
const fetchMock = vi.fn(async (input: string) => {
  const url = String(input)
  if (url === `${BASE}tree.json`) return new Response(JSON.stringify({ name: 'haptic-sports', files: Object.keys(files).map(path => ({ path, size: files[path].length, mtimeMs: MTIME })) }))
  const path = decodeURIComponent(url.slice(BASE.length))
  return path in files ? new Response(files[path], { headers: { 'content-type': 'text/plain' } }) : new Response('', { status: 404 })
})
const open = () => openBundledProject(BASE)
const mustReject = async (work: Promise<unknown>, name: string) => { await expect(work).rejects.toMatchObject({ name }) }

beforeEach(() => { fetchMock.mockClear(); vi.stubGlobal('fetch', fetchMock) })
afterEach(() => { vi.unstubAllGlobals() })

describe('bundled project handle', () => {
  it('walks the tree like a folder', async () => {
    const root = await open()
    expect(root.kind).toBe('directory')
    expect(root.name).toBe('haptic-sports')
    const viewer = await (await root.getDirectoryHandle('Saved')).getDirectoryHandle('HapticViewer')
    const names: string[] = []
    for await (const [name] of viewer.entries()) names.push(name)
    expect(names).toContain('viewer-lib.json')
    const keys: string[] = []
    for await (const name of viewer.keys()) keys.push(name)
    expect(keys).toEqual(names)
    const kinds: string[] = []
    for await (const handle of viewer.values()) kinds.push(handle.kind)
    expect(kinds).toHaveLength(names.length)
    const iterated: string[] = []
    for await (const [name] of viewer as unknown as AsyncIterable<[string, unknown]>) iterated.push(name)
    expect(iterated).toEqual(names)
  })

  it('says what sceneProject and sceneKit test for on a missing or wrong entry', async () => {
    const root = await open()
    const missing = await root.getFileHandle('nope.json').catch(error => error)
    expect(isNotFound(missing)).toBe(true)
    await mustReject(root.getDirectoryHandle('nope'), 'NotFoundError')
    await mustReject(root.getFileHandle('Saved'), 'TypeMismatchError')
    const viewer = await (await root.getDirectoryHandle('Saved')).getDirectoryHandle('HapticViewer')
    await mustReject(viewer.getDirectoryHandle('viewer-lib.json'), 'TypeMismatchError')
  })

  it('never writes', async () => {
    const root = await open()
    await mustReject(root.getFileHandle('new.json', { create: true }), 'NoModificationAllowedError')
    await mustReject(root.getDirectoryHandle('new', { create: true }), 'NoModificationAllowedError')
    await mustReject(root.removeEntry('Saved'), 'NoModificationAllowedError')
    const viewer = await (await root.getDirectoryHandle('Saved')).getDirectoryHandle('HapticViewer')
    await expect((await viewer.getFileHandle('viewer-lib.json', { create: true })).kind).toBe('file')
    await mustReject((await viewer.getFileHandle('viewer-lib.json')).createWritable(), 'NoModificationAllowedError')
  })

  it('grants permission, knows its entries', async () => {
    const root = await open()
    expect(await root.queryPermission({ mode: 'readwrite' })).toBe('granted')
    expect(await root.requestPermission({ mode: 'readwrite' })).toBe('granted')
    const saved = await root.getDirectoryHandle('Saved'), viewer = await saved.getDirectoryHandle('HapticViewer'), file = await viewer.getFileHandle('viewer-lib.json')
    expect(await saved.isSameEntry(await root.getDirectoryHandle('Saved'))).toBe(true)
    expect(await saved.isSameEntry(viewer)).toBe(false)
    expect(await root.resolve(file)).toEqual(['Saved', 'HapticViewer', 'viewer-lib.json'])
    expect(await saved.resolve(file)).toEqual(['HapticViewer', 'viewer-lib.json'])
    expect(await viewer.resolve(viewer)).toEqual([])
    expect(await viewer.resolve(saved)).toBeNull()
  })

  it('reads a file with the same lastModified every time', async () => {
    const root = await open()
    const first = await readProjectFile(root, 'Saved/HapticViewer/viewer-lib.json')
    const second = await readProjectFile(root, 'Saved/HapticViewer/viewer-lib.json')
    expect(first.name).toBe('viewer-lib.json')
    expect(await first.text()).toBe(files['Saved/HapticViewer/viewer-lib.json'])
    expect(first.lastModified).toBe(MTIME)
    expect(second.lastModified).toBe(MTIME)
    expect(first.type).toContain('text/plain')
  })

  it('a listed file the app no longer has is NotFoundError', async () => {
    const root = await open()
    delete files['Saved/HapticViewer/a b+c.mp4']
    await mustReject(readProjectFile(root, 'Saved/HapticViewer/a b+c.mp4'), 'NotFoundError')
    files['Saved/HapticViewer/a b+c.mp4'] = 'video'
  })

  it('opens as a scene project', async () => {
    const root = await open()
    const opened = await openSceneProject(root)
    expect(opened.ok).toBe(true)
    expect(await listWavs(root, lib.paths.clips)).toEqual(['click', 'hum', 'thump'])
    expect(await listWavs(root, 'no/such/folder')).toEqual([])
  })

  it('rejects a list it cannot use', async () => {
    fetchMock.mockImplementationOnce(async () => new Response('{}'))
    await expect(open()).rejects.toThrow('no file list')
    fetchMock.mockImplementationOnce(async () => new Response('', { status: 500 }))
    await expect(open()).rejects.toThrow('HTTP 500')
  })

  it('gives an absolute URL only for a bundled handle', async () => {
    const root = await open()
    expect(isBundledProject(root)).toBe(true)
    expect(isBundledProject(memoryFolder({ 'a.txt': 'x' }).handle)).toBe(false)
    expect(bundledFileUrl(root, 'Saved/HapticViewer/a b+c.mp4')).toBe(`${BASE}Saved/HapticViewer/a%20b%2Bc.mp4`)
    expect(bundledFileUrl(await root.getDirectoryHandle('Saved'), 'HapticViewer/x.mp4')).toBe(`${BASE}Saved/HapticViewer/x.mp4`)
    expect(bundledFileUrl(memoryFolder({ 'a.txt': 'x' }).handle, 'a.txt')).toBeNull()
  })
})

describe('sceneStore with a bundled project', () => {
  const storage = new Map<string, string>()
  const saved = vi.fn(async () => {}), registered = vi.fn(async () => {})
  beforeEach(() => {
    storage.clear()
    vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, v) }, removeItem: (k: string) => { storage.delete(k) } })
    vi.stubGlobal('OfflineAudioContext', class { decodeAudioData() { return Promise.resolve({ length: 1, numberOfChannels: 1, getChannelData: () => new Float32Array(1) }) } })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  })
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.doUnmock('@/utils/localDirectory'); vi.doUnmock('@/utils/sceneRegistry') })

  async function openPage() {
    vi.resetModules()
    vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} })
    vi.doMock('@/utils/localDirectory', async original => ({ ...await original<typeof import('@/utils/localDirectory')>(), saveDirectoryHandle: saved }))
    vi.doMock('@/utils/sceneRegistry', async original => ({ ...await original<typeof import('@/utils/sceneRegistry')>(), registerSceneProject: registered }))
    const store = await import('@/stores/sceneStore')
    const bundled = await import('./bundledProject')
    const root = await bundled.openBundledProject(BASE)
    await store.useSceneStore.getState().openBundled(root)
    return { ...store, root }
  }

  it('opens at the full replay, remembers nothing in IndexedDB, streams the video from its URL', async () => {
    const { useSceneStore, sceneVideoUrl, root } = await openPage()
    const s = useSceneStore.getState()
    expect(s.notice?.error).toBeFalsy()
    expect(s.items[s.cur].kind).toBe('full')
    expect(s.table).not.toBeNull()
    expect(saved).not.toHaveBeenCalled()
    expect(registered).not.toHaveBeenCalled()
    const reads = fetchMock.mock.calls.length
    expect(await sceneVideoUrl(root, 'a b+c.mp4')).toBe(`${BASE}Saved/HapticViewer/a%20b%2Bc.mp4`)
    expect(fetchMock.mock.calls.length).toBe(reads)
  })

  it('never sees a change on the 2 s check', async () => {
    const { useSceneStore } = await openPage()
    const table = useSceneStore.getState().table, kit = useSceneStore.getState().projectKit
    await vi.advanceTimersByTimeAsync(6000)
    expect(useSceneStore.getState().table).toBe(table)
    expect(useSceneStore.getState().projectKit).toBe(kit)
    expect(useSceneStore.getState().dirty).toBe(false)
  })
})
