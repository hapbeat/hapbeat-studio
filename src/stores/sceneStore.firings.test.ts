import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { serializeCueTable } from '@/utils/sceneCueTable'
import { memoryFolder, sampleLib, sampleTable, sampleViewerDataFile, sampleViewerLibFile } from '@/utils/sceneTestFixtures'

const storage = new Map<string, string>()
vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, v) }, removeItem: (k: string) => { storage.delete(k) } })
vi.stubGlobal('OfflineAudioContext', class { decodeAudioData() { return Promise.resolve({ length: 1, numberOfChannels: 1, getChannelData: () => new Float32Array(1) }) } })

const lib = sampleLib()
const VIEWER_DATA = 'Saved/HapticViewer/viewer-data.json'
const project = () => memoryFolder({
  'Saved/HapticViewer/viewer-lib.json': JSON.stringify(sampleViewerLibFile()),
  [VIEWER_DATA]: `${JSON.stringify(sampleViewerDataFile(), null, 2)}\n`,
  [lib.paths.cues]: serializeCueTable(sampleTable()),
  [`${lib.paths.clips}/click.wav`]: 'x', [`${lib.paths.clips}/thump.wav`]: 'x', [`${lib.paths.clips}/hum.wav`]: 'x',
  [`${lib.paths.sounds}/Click.wav`]: 'x', [`${lib.paths.sounds}/Motor.wav`]: 'x',
})
async function openPage(folder: ReturnType<typeof memoryFolder>) {
  vi.resetModules()
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {}, showDirectoryPicker: async () => folder.handle })
  const { useSceneStore } = await import('./sceneStore')
  await useSceneStore.getState().pick()
  return useSceneStore
}

beforeEach(() => { storage.clear(); vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] }) })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

describe('firing gains (strength panel) → viewer-data.json', () => {
  it('the recording and the data change at once, the file 300 ms later (only the gain), the levels stay the same', async () => {
    const folder = project(), store = await openPage(folder)
    const before = store.getState().recorded!, text = folder.read(VIEWER_DATA)!
    store.getState().setFiringGains(new Map([[1, 0.25]]))
    const s = store.getState()
    expect(s.recorded!.full.events[1].gain).toBe(0.25)
    expect(s.data!.full.events.find(e => e.name === 'button')!.gain).toBe(0.25)
    // The same recording to the runtime (levels kept): the video is not reloaded.
    expect(s.recorded!.full.levels).toBe(before.full.levels)
    expect(folder.read(VIEWER_DATA)).toBe(text)
    await vi.advanceTimersByTimeAsync(400)
    expect(folder.read(VIEWER_DATA)).toBe(text.replace(/("t": 3,\n\s+"name": "button",\n\s+"hand": "right",\n\s+"gain": )1/, '$10.25'))
  })
  it('refuses to write when the file no longer has that firing at the index', async () => {
    const folder = project(), store = await openPage(folder)
    const changed = sampleViewerDataFile() as { events: { name: string }[] }
    changed.events[1].name = 'other'
    const dir = await (await folder.handle.getDirectoryHandle('Saved')).getDirectoryHandle('HapticViewer')
    const w = await (await dir.getFileHandle('viewer-data.json')).createWritable()
    await w.write(JSON.stringify(changed)); await w.close()
    store.getState().setFiringGains(new Map([[1, 0.25]]))
    await vi.advanceTimersByTimeAsync(400)
    expect(JSON.parse(folder.read(VIEWER_DATA)!).events[1]).toMatchObject({ name: 'other', gain: 1 })
    expect(store.getState().notice).toMatchObject({ id: 'scene.firings.mismatch', params: { index: 1 } })
  })
})
