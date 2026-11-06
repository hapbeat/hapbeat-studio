import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appFolderStamp, appProjectFileUrl, isAppProject, openAppProject } from './appProject'
import { isNotFound, listWavs, openSceneProject, readProjectFile } from './sceneProject'
import { serializeCueTable } from './sceneCueTable'
import { memoryFolder, sampleLib, sampleTable, sampleViewerDataFile, sampleViewerLibFile } from './sceneTestFixtures'

const BASE = 'https://studio.hapbeat.com/__project/'
const lib = sampleLib()
const VIEWER_DATA = 'Saved/HapticViewer/viewer-data.json'

/** The folder on disk the app serves: path → text and modification time. */
let disk: Map<string, { text: string; mtimeMs: number }>
let clock = 1793546366434
const write = (path: string, text: string) => { clock += 1000; disk.set(path, { text, mtimeMs: clock }) }
function resetDisk() {
  disk = new Map()
  write('Saved/HapticViewer/viewer-lib.json', JSON.stringify(sampleViewerLibFile()))
  write(VIEWER_DATA, JSON.stringify(sampleViewerDataFile()))
  write(lib.paths.cues, serializeCueTable(sampleTable()))
  for (const name of ['click', 'thump', 'hum']) write(`${lib.paths.clips}/${name}.wav`, 'x')
  for (const name of ['Click', 'Motor']) write(`${lib.paths.sounds}/${name}.wav`, 'x')
  write('Saved/HapticViewer/a b+c.mp4', 'video')
  write('.git/HEAD', 'ref')
}

/** Runs after the mock answered a file (not a listing): a save landing between two reads. */
let afterServe: ((path: string) => void) | null = null
/** The app's answers (app/src/server.js): `?list` = a folder's entries, else the file with x-mtime-ms. */
const fetchMock = vi.fn(async (input: string) => {
  const url = new URL(String(input))
  const path = decodeURIComponent(url.pathname.slice('/__project/'.length)).replace(/\/$/, '')
  if (url.search === '?list') {
    const prefix = path ? `${path}/` : ''
    const entries = new Map<string, { name: string; kind: string; size: number; mtimeMs: number }>()
    for (const [p, f] of disk) {
      if (!p.startsWith(prefix)) continue
      const [name, ...rest] = p.slice(prefix.length).split('/')
      if (name.startsWith('.')) continue
      entries.set(name, rest.length ? { name, kind: 'directory', size: 0, mtimeMs: 0 } : { name, kind: 'file', size: f.text.length, mtimeMs: f.mtimeMs })
    }
    if (!entries.size && path) return new Response('', { status: 404 })
    return new Response(JSON.stringify({ entries: [...entries.values()].sort((a, b) => a.name.localeCompare(b.name)) }))
  }
  const file = disk.get(path)
  const response = file ? new Response(file.text, { headers: { 'content-type': 'text/plain', 'x-mtime-ms': String(file.mtimeMs) } }) : new Response('', { status: 404 })
  afterServe?.(path)
  return response
})
const open = () => openAppProject('haptic-sports', BASE)
const mustReject = async (work: Promise<unknown>, name: string) => { await expect(work).rejects.toMatchObject({ name }) }

beforeEach(() => { resetDisk(); afterServe = null; fetchMock.mockClear(); vi.stubGlobal('fetch', fetchMock) })
afterEach(() => { vi.unstubAllGlobals() })

describe('app project handle', () => {
  it('walks the folder on disk like a folder', async () => {
    const root = await open()
    expect(root.kind).toBe('directory')
    expect(root.name).toBe('haptic-sports')
    const viewer = await (await root.getDirectoryHandle('Saved')).getDirectoryHandle('HapticViewer')
    const names: string[] = []
    for await (const [name] of viewer.entries()) names.push(name)
    expect(names).toEqual(['a b+c.mp4', 'viewer-data.json', 'viewer-lib.json'])
    const keys: string[] = []
    for await (const name of viewer.keys()) keys.push(name)
    expect(keys).toEqual(names)
    const kinds: string[] = []
    for await (const handle of viewer.values()) kinds.push(handle.kind)
    expect(kinds).toEqual(['file', 'file', 'file'])
    const iterated: string[] = []
    for await (const [name] of viewer as unknown as AsyncIterable<[string, unknown]>) iterated.push(name)
    expect(iterated).toEqual(names)
  })

  it('says what sceneProject and sceneKit test for on a missing or wrong entry', async () => {
    const root = await open()
    const missing = await root.getFileHandle('nope.json').catch(error => error)
    expect(isNotFound(missing)).toBe(true)
    await mustReject(root.getDirectoryHandle('nope'), 'NotFoundError')
    await mustReject(root.getDirectoryHandle('.git'), 'NotFoundError')
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
    expect((await viewer.getFileHandle('viewer-lib.json', { create: true })).kind).toBe('file')
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

  it('reads the file as it is on disk now, with its modification time', async () => {
    const root = await open()
    const first = await readProjectFile(root, lib.paths.cues)
    expect(first.name).toBe('cues.json')
    expect(await first.text()).toBe(disk.get(lib.paths.cues)!.text)
    expect(first.lastModified).toBe(disk.get(lib.paths.cues)!.mtimeMs)
    expect(first.type).toContain('text/plain')
    write(lib.paths.cues, 'changed')
    const second = await readProjectFile(root, lib.paths.cues)
    expect(await second.text()).toBe('changed')
    expect(second.lastModified).toBeGreaterThan(first.lastModified)
  })

  it('a file removed on disk is NotFoundError', async () => {
    const root = await open()
    const handle = await (await (await root.getDirectoryHandle('Saved')).getDirectoryHandle('HapticViewer')).getFileHandle('a b+c.mp4')
    disk.delete('Saved/HapticViewer/a b+c.mp4')
    await mustReject(handle.getFile(), 'NotFoundError')
    await mustReject(readProjectFile(root, 'Saved/HapticViewer/a b+c.mp4'), 'NotFoundError')
  })

  it('opens as a scene project', async () => {
    const root = await open()
    expect((await openSceneProject(root)).ok).toBe(true)
    expect(await listWavs(root, lib.paths.clips)).toEqual(['click', 'hum', 'thump'])
    expect(await listWavs(root, 'no/such/folder')).toEqual([])
  })

  it('no project in the app: NotFoundError; a list it cannot use: an error', async () => {
    fetchMock.mockImplementationOnce(async () => new Response('', { status: 404 }))
    await mustReject(open(), 'NotFoundError')
    fetchMock.mockImplementationOnce(async () => new Response('{}'))
    await expect(open()).rejects.toThrow('no entry list')
    fetchMock.mockImplementationOnce(async () => new Response('', { status: 500 }))
    await expect(open()).rejects.toThrow('HTTP 500')
  })

  it('gives an absolute URL, versioned by the file, only for the app project', async () => {
    const root = await open()
    expect(isAppProject(root)).toBe(true)
    expect(isAppProject(memoryFolder({ 'a.txt': 'x' }).handle)).toBe(false)
    const video = () => disk.get('Saved/HapticViewer/a b+c.mp4')!
    const first = await appProjectFileUrl(root, 'Saved/HapticViewer/a b+c.mp4')
    expect(first).toBe(`${BASE}Saved/HapticViewer/a%20b%2Bc.mp4?v=${video().mtimeMs}-5`)
    expect(await appProjectFileUrl(root, 'Saved/HapticViewer/a b+c.mp4')).toBe(first)
    expect(await appProjectFileUrl(await root.getDirectoryHandle('Saved'), 'HapticViewer/A B+C.MP4')).toBe(first)
    write('Saved/HapticViewer/a b+c.mp4', 'video2')
    expect(await appProjectFileUrl(root, 'Saved/HapticViewer/a b+c.mp4')).toBe(`${BASE}Saved/HapticViewer/a%20b%2Bc.mp4?v=${video().mtimeMs}-6`)
    await mustReject(appProjectFileUrl(root, 'Saved/HapticViewer/none.mp4'), 'NotFoundError')
    await mustReject(appProjectFileUrl(root, 'Saved/HapticViewer'), 'NotFoundError')
    expect(await appProjectFileUrl(memoryFolder({ 'a.txt': 'x' }).handle, 'a.txt')).toBeNull()
  })

  it('finds a name whatever its case, as File System Access does on Windows, and keeps the name on disk', async () => {
    const root = await open()
    const viewer = await (await root.getDirectoryHandle('saved')).getDirectoryHandle('HAPTICVIEWER')
    expect(viewer.name).toBe('HapticViewer')
    const file = await viewer.getFileHandle('Viewer-Lib.JSON')
    expect(file.name).toBe('viewer-lib.json')
    expect(await root.resolve(file)).toEqual(['Saved', 'HapticViewer', 'viewer-lib.json'])
    expect(JSON.parse(await (await file.getFile()).text())).toEqual(sampleViewerLibFile())
    await mustReject(root.getFileHandle('SAVED'), 'TypeMismatchError')
  })

  it('a folder stamp changes with a written, added or removed file it picks, and with nothing else', async () => {
    const root = await open()
    const wavs = () => appFolderStamp(root, lib.paths.clips, name => name.endsWith('.wav'))
    const before = await wavs()
    expect(await wavs()).toBe(before)
    write(`${lib.paths.clips}/notes.txt`, 'x')
    expect(await wavs()).toBe(before)
    write(`${lib.paths.clips}/hum.wav`, 'xy')
    const written = await wavs()
    expect(written).not.toBe(before)
    write(`${lib.paths.clips}/new.wav`, 'x')
    expect(await wavs()).not.toBe(written)
    expect(await appFolderStamp(root, 'no/such/folder', () => true)).toBe('')
  })
})

describe('sceneStore with the app project', () => {
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
    const app = await import('./appProject')
    const root = await app.openAppProject('haptic-sports', BASE)
    await store.useSceneStore.getState().openAppProject(root)
    return { ...store, root }
  }
  const viewerData = () => JSON.parse(disk.get(VIEWER_DATA)!.text) as { events: { t: number; name: string; gain?: number }[] }

  it('opens at the full replay, remembers nothing in IndexedDB, streams the video from its URL', async () => {
    const { useSceneStore, sceneVideoUrl, root } = await openPage()
    const s = useSceneStore.getState()
    expect(s.notice?.error).toBeFalsy()
    expect(s.items[s.cur].kind).toBe('full')
    expect(s.table).not.toBeNull()
    expect(s.recordingFrom).toBe('open')
    expect(saved).not.toHaveBeenCalled()
    expect(registered).not.toHaveBeenCalled()
    // The URL names the file and its version; the video itself is never fetched here (the video element streams it).
    const url = await sceneVideoUrl(root, 'a b+c.mp4')
    expect(url).toBe(`${BASE}Saved/HapticViewer/a%20b%2Bc.mp4?v=${disk.get('Saved/HapticViewer/a b+c.mp4')!.mtimeMs}-5`)
    expect(fetchMock.mock.calls.every(([u]) => !String(u).includes('.mp4') || String(u).endsWith('?list'))).toBe(true)
  })

  it('a video Studio replaced opens the project again with a new video URL; an unchanged one keeps its URL', async () => {
    const { useSceneStore, sceneVideoUrl, root } = await openPage()
    const first = await sceneVideoUrl(root, 'a b+c.mp4')
    write('Saved/HapticViewer/viewer-lib.json', disk.get('Saved/HapticViewer/viewer-lib.json')!.text)
    await useSceneStore.getState().checkDisk()
    expect(useSceneStore.getState().root).toBe(root)
    expect(await sceneVideoUrl(root, 'a b+c.mp4')).toBe(first)
    write('Saved/HapticViewer/a b+c.mp4', 'video, new take')
    await useSceneStore.getState().checkDisk()
    const second = await sceneVideoUrl(root, 'a b+c.mp4')
    expect(second).not.toBe(first)
    expect(second).toContain('?v=')
    expect(useSceneStore.getState().items[useSceneStore.getState().cur].kind).toBe('full')
  })

  it('a save landing while the project opens is read on the next check (stamped before it was read)', async () => {
    const file = viewerData()
    file.events[0].gain = 0.3
    // viewer-data.json is rewritten just after the open read it.
    afterServe = path => { if (path === VIEWER_DATA) { afterServe = null; write(VIEWER_DATA, JSON.stringify(file)) } }
    const { useSceneStore } = await openPage()
    expect(useSceneStore.getState().recorded?.full.events[0].gain).not.toBe(0.3)
    await useSceneStore.getState().checkDisk()
    expect(useSceneStore.getState().recorded?.full.events[0].gain).toBe(0.3)
  })

  it('a cue table saved just after it was read is read on the next check (one read for the table and its base)', async () => {
    const table = sampleTable()
    table.cues.button.haptics![0].gain = 0.35
    let reads = 0
    afterServe = path => { if (path === lib.paths.cues && ++reads === 1) write(lib.paths.cues, serializeCueTable(table)) }
    const { useSceneStore } = await openPage()
    afterServe = null
    expect(useSceneStore.getState().table?.cues.button.haptics?.[0].gain).not.toBe(0.35)
    await useSceneStore.getState().checkDisk()
    expect(useSceneStore.getState().table?.cues.button.haptics?.[0].gain).toBe(0.35)
  })

  it('a project whose table did not read at open goes on being checked, and reads once Studio fixed it', async () => {
    const good = disk.get(lib.paths.cues)!.text
    write(lib.paths.cues, '{"broken": ')
    const { useSceneStore } = await openPage()
    expect(useSceneStore.getState().table).toBeNull()
    expect(useSceneStore.getState().notice?.error).toBe(true)
    await useSceneStore.getState().checkDisk()
    expect(useSceneStore.getState().table).toBeNull()
    write(lib.paths.cues, good)
    await useSceneStore.getState().checkDisk()
    expect(useSceneStore.getState().table).not.toBeNull()
    // Detection goes on afterwards (a recording change is read).
    const file = viewerData()
    file.events[0].gain = 0.45
    write(VIEWER_DATA, JSON.stringify(file))
    await useSceneStore.getState().checkDisk()
    expect(useSceneStore.getState().recorded?.full.events[0].gain).toBe(0.45)
  })

  it('a folder chosen while another opens is opened after it, not dropped', async () => {
    vi.resetModules()
    vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} })
    vi.doMock('@/utils/localDirectory', async original => ({ ...await original<typeof import('@/utils/localDirectory')>(), saveDirectoryHandle: saved }))
    vi.doMock('@/utils/sceneRegistry', async original => ({ ...await original<typeof import('@/utils/sceneRegistry')>(), registerSceneProject: registered }))
    const { useSceneStore } = await import('@/stores/sceneStore')
    const app = await import('./appProject')
    const first = await app.openAppProject('first', BASE), second = await app.openAppProject('second', BASE)
    const opening = useSceneStore.getState().openAppProject(first)
    expect(useSceneStore.getState().busy).toBe(true)
    await useSceneStore.getState().openAppProject(second)
    await opening
    await vi.waitFor(() => { expect(useSceneStore.getState().root).toBe(second) })
    await vi.waitFor(() => { expect(useSceneStore.getState().busy).toBe(false) })
    expect(useSceneStore.getState().table).not.toBeNull()
  })

  it('reads nothing again while nothing changed on disk', async () => {
    const { useSceneStore } = await openPage()
    const { table, recorded, pcm, projectKit } = useSceneStore.getState()
    await vi.advanceTimersByTimeAsync(6000)
    await useSceneStore.getState().checkDisk()
    const now = useSceneStore.getState()
    expect(now.table).toBe(table)
    expect(now.recorded).toBe(recorded)
    expect(now.pcm).toBe(pcm)
    expect(now.projectKit).toBe(projectKit)
    expect(now.dirty).toBe(false)
  })

  it('a cue table Studio saved is read at once on checkDisk (and on the 2 s check)', async () => {
    const { useSceneStore } = await openPage()
    const table = sampleTable()
    table.cues.button.haptics![0].gain = 0.25
    write(lib.paths.cues, serializeCueTable(table))
    await useSceneStore.getState().checkDisk()
    expect(useSceneStore.getState().table?.cues.button.haptics?.[0].gain).toBe(0.25)
    table.cues.button.haptics![0].gain = 0.75
    write(lib.paths.cues, serializeCueTable(table))
    await vi.advanceTimersByTimeAsync(2100)
    expect(useSceneStore.getState().table?.cues.button.haptics?.[0].gain).toBe(0.75)
    expect(useSceneStore.getState().dirty).toBe(false)
  })

  it('firing gains Studio saved replace the old ones without a new recording (playback goes on)', async () => {
    const { useSceneStore } = await openPage()
    const before = useSceneStore.getState()
    const file = viewerData()
    file.events[0].gain = 0.4
    write(VIEWER_DATA, JSON.stringify(file))
    await useSceneStore.getState().checkDisk()
    const after = useSceneStore.getState()
    expect(after.recorded?.full.events[0].gain).toBe(0.4)
    expect(after.data?.full.events.find(e => e.t === file.events[0].t && e.name === file.events[0].name)?.gain).toBe(0.4)
    // The same levels and items: the runtime keeps its video, position and selection.
    expect(after.recorded?.full.levels).toBe(before.recorded?.full.levels)
    expect(after.items).toBe(before.items)
    expect(after.recordingFrom).toBe('open')
  })

  it('a recording changed otherwise replaces the old one at the full replay, keeping the position (refresh)', async () => {
    const { useSceneStore } = await openPage()
    const before = useSceneStore.getState()
    const file = viewerData()
    file.events[0].t += 0.25
    write(VIEWER_DATA, JSON.stringify(file))
    await useSceneStore.getState().checkDisk()
    const after = useSceneStore.getState()
    expect(after.recorded).not.toBe(before.recorded)
    expect(after.recorded?.full.events[0].t).toBeCloseTo(file.events[0].t)
    expect(after.recordingFrom).toBe('refresh')
    expect(after.items[after.cur].kind).toBe('full')
    expect(after.root).toBe(before.root)
  })

  it('a broken viewer-data.json (still being written) is read again on the next check', async () => {
    const { useSceneStore } = await openPage()
    const recorded = useSceneStore.getState().recorded
    write(VIEWER_DATA, '{"schema_version": 1, "ev')
    await useSceneStore.getState().checkDisk()
    expect(useSceneStore.getState().recorded).toBe(recorded)
    const file = JSON.parse(JSON.stringify(sampleViewerDataFile())) as { events: { gain?: number }[] }
    file.events[0].gain = 0.6
    write(VIEWER_DATA, JSON.stringify(file))
    await useSceneStore.getState().checkDisk()
    expect(useSceneStore.getState().recorded?.full.events[0].gain).toBe(0.6)
  })

  it('a clip WAV Studio rewrote is decoded again', async () => {
    const { useSceneStore } = await openPage()
    const pcm = useSceneStore.getState().pcm
    write(`${lib.paths.clips}/click.wav`, 'xx')
    await useSceneStore.getState().checkDisk()
    expect(useSceneStore.getState().pcm).not.toBe(pcm)
  })
})
