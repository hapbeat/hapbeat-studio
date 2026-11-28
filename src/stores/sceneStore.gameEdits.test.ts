import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { serializeCueTable, type CueTable } from '@/utils/sceneCueTable'
import { memoryFolder, sampleLib, sampleTable, sampleViewerDataFile, sampleViewerLibFile } from '@/utils/sceneTestFixtures'
import { VERSIONS_DIR } from '@/utils/sceneVersions'

/** DEC-114: in a game project the Scene's strength edits are the cue table's multipliers; viewer-edits.json is not used. */

const storage = new Map<string, string>()
vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, v) }, removeItem: (k: string) => { storage.delete(k) } })
vi.stubGlobal('OfflineAudioContext', class { decodeAudioData() { return Promise.resolve({ length: 1, numberOfChannels: 1, getChannelData: () => new Float32Array(1) }) } })

const lib = sampleLib('game')
const VIEWER_DATA = 'Saved/HapticViewer/viewer-data.json'
const EDITS = 'Saved/HapticViewer/viewer-edits.json'
const EDITS_TEXT = `${JSON.stringify({ schema_version: 1, firings: [{ of: { name: 'button', t: 3, hand: 'right' }, gain: 0.5 }, { of: { name: 'detent', t: 1, hand: 'right' }, gain: 0.2, t: 1.5 }] }, null, 2)}\n`

/** sampleTable with button's variants: soft shares its haptics and sound (multipliers), hard has its own haptics. */
function table(): CueTable {
  const t = sampleTable()
  t.cues.button.variants = { soft: { hapticsGain: 0.5, sfxVolume: 0.5 }, hard: { haptics: [{ clip: 'click', at: 'hand', gain: 1.5 }] } }
  return t
}
/** The recording with a button:soft firing at 2 s (index 1; the others after it shift by one). */
function viewerData() {
  const d = sampleViewerDataFile() as { events: { t: number; name: string; hand: string; gain: number }[] }
  return { ...d, events: [d.events[0], { t: 2, name: 'button:soft', hand: 'right', gain: 1 }, ...d.events.slice(1)] }
}
const files = (extra: Record<string, string> = {}) => ({
  'Saved/HapticViewer/viewer-lib.json': JSON.stringify(sampleViewerLibFile('game')),
  [VIEWER_DATA]: `${JSON.stringify(viewerData(), null, 2)}\n`,
  [lib.paths.cues]: serializeCueTable(table()),
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
  return { store: useSceneStore, st: () => strength.useSceneStrength.getState() }
}
const versionFolders = async (folder: Folder) => {
  const dir = await (await (await folder.handle.getDirectoryHandle('Saved')).getDirectoryHandle('HapticViewer')).getDirectoryHandle('versions').catch(() => null)
  const out: string[] = []
  if (dir) for await (const [name] of dir.entries()) out.push(name)
  return out
}

beforeEach(() => { storage.clear(); vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] }) })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

describe('a game project (lib.kind game)', () => {
  it('viewer-edits.json is not read (counted only), never written and never removed', async () => {
    const folder = memoryFolder(files({ [EDITS]: EDITS_TEXT })), { store } = await openPage(folder)
    const s = store.getState()
    expect(s.lib!.kind).toBe('game')
    expect(s.ignoredEdits).toBe(2)
    expect(s.edits.firings).toEqual([])
    // The recorded values play: no gain 0.5 on button, detent stays at 1 s.
    expect(s.data!.full.events.find(e => e.name === 'button')!.gain).toBe(1)
    expect(s.data!.full.events.filter(e => e.name === 'detent').map(e => e.t)).toEqual([1, 3.15])
    s.setFiringEdits(new Map([[2, { gain: 0.25 }]]))
    s.replaceEdits({ schema_version: 1, firings: [{ of: { name: 'button', t: 3 }, gain: 0.1 }] })
    expect(store.getState().edits.firings).toEqual([])
    await vi.advanceTimersByTimeAsync(2100)
    expect(folder.read(EDITS)).toBe(EDITS_TEXT)
  })

  it('a bar edit changes the cue table multiplier of its name (each name once); the firing times never move; no viewer-edits.json', async () => {
    const folder = memoryFolder(files()), { store, st } = await openPage(folder)
    const detent = () => store.getState().table!.cues.detent.haptics![0].gain
    // Both detent firings selected (0 and 4): their route gain 0.5 is scaled once (×2 → 1), not twice (→ 2).
    st().select([0, 4], 'replace')
    expect(st().scaleSelected(2)).toBe(true)
    expect(detent()).toBe(1)
    expect(store.getState().edits.firings).toEqual([])
    // Time: refused, every firing where it was recorded.
    expect(st().moveSelected(0.5)).toBe(false)
    expect(st().resetSelected()).toBe(false)
    expect(store.getState().data!.full.events.map(e => e.t)).toEqual([1, 2, 3, 3.1, 3.15, 4.5])
    await vi.advanceTimersByTimeAsync(400)
    expect(folder.exists(EDITS)).toBe(false)
    // The cue table is saved (it is what the game imports).
    expect(JSON.parse(folder.read(lib.paths.cues)!).cues.detent.haptics[0].gain).toBe(1)
    // One undo step back, one forward.
    st().undoLast()
    expect(detent()).toBe(0.5)
    st().redoLast()
    expect(detent()).toBe(1)
  })

  it('button:soft (sharing the haptics) changes its hapticsGain only; button its route; both selected: each once', async () => {
    const folder = memoryFolder(files()), { store, st } = await openPage(folder)
    const cue = () => store.getState().table!.cues.button
    st().select([1], 'replace')
    st().scaleSelected(2)
    expect(cue().variants!.soft.hapticsGain).toBe(1)
    expect(cue().haptics![0].gain).toBe(1)
    st().select([1, 2], 'replace')
    st().scaleSelected(0.5)
    expect(cue().variants!.soft.hapticsGain).toBe(0.5)
    expect(cue().haptics![0].gain).toBe(0.5)
    // The number box sets each one's value (the routes' largest).
    st().setSelected(1.2)
    expect(cue().variants!.soft.hapticsGain).toBe(1.2)
    expect(cue().haptics![0].gain).toBe(1.2)
  })

  it('stops at the top of the range; a live drag shows each multiplier\'s bounded ratio', async () => {
    const folder = memoryFolder(files()), { store, st } = await openPage(folder)
    st().select([1, 2], 'replace')
    st().setDragRatio(3)
    expect(Object.fromEntries(st().dragTargets!)).toEqual({ 'routes:button': 2, 'hapticsGain:button:soft': 3 })
    st().setDragRatio(null)
    expect(st().dragTargets).toBeNull()
    st().scaleSelected(3)
    expect(store.getState().table!.cues.button.haptics![0].gain).toBe(2)
    expect(store.getState().table!.cues.button.variants!.soft.hapticsGain).toBe(1.5)
  })

  it('a sound bar: sfx.volume of the cue, sfxVolume of a sharing variant', async () => {
    const folder = memoryFolder(files()), { store, st } = await openPage(folder)
    expect(st().scaleNames(['button'], 'sound', 0.5)).toBe(true)
    expect(store.getState().table!.cues.button.sfx!.volume).toBe(0.3)
    expect(st().scaleNames(['button:soft', 'button:soft'], 'sound', 2)).toBe(true)
    expect(store.getState().table!.cues.button.variants!.soft.sfxVolume).toBe(1)
    // grab has no sound: nothing to change.
    expect(st().scaleNames(['grab'], 'sound', 2)).toBe(false)
  })

  it('a version keeps viewer-edits.json as it is on disk; restoring one never writes it', async () => {
    const folder = memoryFolder(files({ [EDITS]: EDITS_TEXT })), { store, st } = await openPage(folder)
    const id = (await store.getState().saveVersion('Mix A'))!
    expect(JSON.parse(folder.read(`${VERSIONS_DIR}/${id}/version.json`)!)).toMatchObject({ firings: 2 })
    expect(folder.read(`${VERSIONS_DIR}/${id}/viewer-edits.json`)).toBe(EDITS_TEXT)
    st().select([2], 'replace')
    st().scaleSelected(0.5)
    const result = await (await import('./sceneStrength')).restoreVersion(id)
    expect(result).toMatchObject({ ok: true })
    expect(store.getState().table!.cues.button.haptics![0].gain).toBe(1)
    expect(store.getState().edits.firings).toEqual([])
    await vi.advanceTimersByTimeAsync(400)
    expect(folder.read(EDITS)).toBe(EDITS_TEXT)
    expect((await versionFolders(folder)).length).toBeGreaterThanOrEqual(2)
  })
})

describe('a video project (lib.kind video) keeps DEC-112', () => {
  it('a firing edit goes to viewer-edits.json; the cue table stays', async () => {
    const folder = memoryFolder(files({ 'Saved/HapticViewer/viewer-lib.json': JSON.stringify(sampleViewerLibFile('video')) })), { store, st } = await openPage(folder)
    const cues = folder.read(lib.paths.cues)
    st().select([2], 'replace')
    expect(st().scaleSelected(0.5)).toBe(true)
    expect(st().moveSelected(0.5)).toBe(true)
    expect(store.getState().ignoredEdits).toBe(0)
    await vi.advanceTimersByTimeAsync(400)
    expect(JSON.parse(folder.read(EDITS)!).firings).toEqual([{ of: { name: 'button', t: 3, hand: 'right' }, gain: 0.5, t: 3.5 }])
    expect(folder.read(lib.paths.cues)).toBe(cues)
  })
})
