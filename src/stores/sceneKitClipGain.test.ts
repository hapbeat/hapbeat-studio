import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { kitCopyDiffers, parseCueTable, serializeCueTable, type CueTable } from '@/utils/sceneCueTable'
import { memoryFolder, sampleTable, sampleViewerDataFile, sampleViewerLibFile } from '@/utils/sceneTestFixtures'
import { recordingFiringStrength, firingKey } from '@/utils/sceneFiringGain'
import { SceneKitFire } from '@/utils/sceneKitFire'
import { shotVoices } from '@/utils/sceneHaptics'
import type { KitDefinition, KitEvent } from '@/types/library'

/**
 * DEC-103 / contracts cue-table §9.1 end to end on an in-memory copy of a haptic-sports-like project (a Kit folder
 * `kits/sports-kit/` holding the manifest, the cue table `haptics/cues.json` holding the copy): the Scene plays the
 * Kit's clip_gain, an edit in the Kit editor (libraryStore update → Save Folder) reaches the Scene without touching the
 * cue table, a copy that differs is shown and aligned. Nothing is sent to a device (FIRE runs on a fake send).
 */

const storage = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, v) }, removeItem: (k: string) => { storage.delete(k) },
})
/** Decoding is not what these tests check: every WAV decodes to one silent sample. */
vi.stubGlobal('OfflineAudioContext', class { decodeAudioData() { return Promise.resolve({ length: 1, numberOfChannels: 1, getChannelData: () => new Float32Array(1) }) } })

const paths = { cues: 'haptics/cues.json', clips: 'kits/sports-kit/stream-clips', sounds: 'haptics/sounds' }
const table = (): CueTable => ({ ...sampleTable(), kit: 'sports-kit' })
/** A 16 kHz mono PCM16 WAV (Save Folder resamples nothing for it). */
function wav(): Uint8Array {
  const bytes = new Uint8Array(46), view = new DataView(bytes.buffer)
  const ascii = (o: number, v: string) => { for (let i = 0; i < v.length; i++) bytes[o + i] = v.charCodeAt(i) }
  ascii(0, 'RIFF'); view.setUint32(4, 38, true); ascii(8, 'WAVE'); ascii(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true)
  view.setUint16(22, 1, true); view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  ascii(36, 'data'); view.setUint32(40, 2, true); view.setInt16(44, 1000, true)
  return bytes
}
const manifest = (thump: number) => JSON.stringify({
  schema_version: '2.0.0', name: 'sports-kit', version: '1.0.0',
  events: { 'sports-kit.thump': { clip: 'thump.wav', parameters: { clip_gain: thump, loop: false } }, 'sports-kit.click': { clip: 'click.wav', parameters: { clip_gain: 1, loop: false } } },
  stream_events: { 'sports-kit.hum': { clip: 'hum.wav', parameters: { clip_gain: 1, loop: true } } },
})
const project = (withKit: boolean, thump = 0.5) => memoryFolder({
  'Saved/HapticViewer/viewer-lib.json': JSON.stringify({ ...sampleViewerLibFile(), title: 'Haptic Sports', project_name: 'haptic-sports', paths }),
  'Saved/HapticViewer/viewer-data.json': JSON.stringify(sampleViewerDataFile()),
  [paths.cues]: serializeCueTable(table()),
  [`${paths.clips}/click.wav`]: 'x', [`${paths.clips}/thump.wav`]: 'x', [`${paths.clips}/hum.wav`]: 'x',
  [`${paths.sounds}/Click.wav`]: 'x', [`${paths.sounds}/Motor.wav`]: 'x',
  ...(withKit ? {
    'kits/sports-kit/sports-kit-manifest.json': manifest(thump),
    'kits/sports-kit/source/thump.wav': wav(), 'kits/sports-kit/source/click.wav': wav(),
  } : {}),
}, 'haptic-sports')

/** Opens `folder` in fresh stores (a page load) through the folder picker. */
async function openPage(folder: ReturnType<typeof memoryFolder>) {
  vi.resetModules()
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout, showDirectoryPicker: async () => folder.handle })
  const { useSceneStore } = await import('./sceneStore')
  const { useLibraryStore } = await import('./libraryStore')
  await useSceneStore.getState().pick()
  return { useSceneStore, useLibraryStore }
}
/** Lets the in-memory folder reads that a notification started finish (no timers: the 2 s poll does not run). */
const settle = async () => { for (let i = 0; i < 200; i++) await Promise.resolve() }

/** The Kit as the Kit editor holds it (libraryStore), for the same folder. */
function kitDefinition(thump: number): KitDefinition {
  const event = (id: string, clip: string, clipGain: number): KitEvent => ({
    id, eventId: `sports-kit.${clip}`, clipName: clip, clipSourceFilename: `${clip}.wav`, clipDuration: 1 / 16000, clipChannels: 1, clipSampleRate: 16000,
    clipFileSize: 46, modes: ['command'], loop: false, clipGain, deviceWiper: null,
  })
  return { id: 'kit-sports', name: 'sports-kit', version: '1.0.0', description: '', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z',
    events: [event('ev-thump', 'thump', thump), event('ev-click', 'click', 1)] }
}

/** What each output sends for the recording's detent firing (thump × route 0.5 × its gain 1), from the store's state now. */
function sent(state: { table: CueTable | null; data: { full: { events: { t: number; name: string; hand: string; gain?: number }[] } } | null; projectKit?: { clipGains: Record<string, number> } | null }) {
  const t = state.table!, kit = state.projectKit?.clipGains ?? null
  const bar = recordingFiringStrength(t, state.data!.full.events, kit).get(firingKey('detent', 1))!.sent
  const shot = { sound: null, soundGain: 0, pitchSt: 0, jitterDb: 0, rate: 1, routes: [{ clip: 'thump', at: 'pos_chest', gain: 0.5 }] }
  const clip = shotVoices(t, { thump: new Float32Array(4) }, shot, 'right', 1, 0, false, kit)[0].gain
  const plays: number[] = [], timers: (() => void)[] = []
  const fire = new SceneKitFire({ send: (_type, payload) => plays.push(payload.gain as number), now: () => 0, setTimer: fn => timers.push(fn), clearTimer: () => {} })
  fire.shot({ table: t, kit, shot, hand: 'right', cueGain: 1, delayMs: 0, offsetMs: 0, devices: [{ ipAddress: '10.0.0.9', address: 'p1/pos_chest' }], all: false })
  for (const fn of timers) fn()
  return { bar, clip, fire: plays[0] }
}

beforeEach(() => { storage.clear(); vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] }) })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

describe('Scene clip gains from the project Kit (DEC-103)', () => {
  it('a project with a Kit: FIRE, CLIP and the bar use the Kit\'s clip_gain, not the cue table copy', async () => {
    const folder = project(true, 0.3)
    const { useSceneStore } = await openPage(folder)
    const s = useSceneStore.getState()
    expect(s.projectKit).toMatchObject({ kit: 'sports-kit', folder: 'kits/sports-kit', clipGains: { thump: 0.3, click: 1, hum: 1 } })
    expect(s.table!.clips.thump.clip_gain).toBe(0.5) // the copy, as read
    const v = sent(s)
    expect(v.bar).toBeCloseTo(0.3 * 0.5)
    expect(v.clip).toBeCloseTo(0.3 * 0.5)
    expect(v.fire).toBeCloseTo(0.3 * 0.5)
    expect(kitCopyDiffers(s.table!, s.projectKit!.clipGains)).toEqual(['thump'])
  })

  it('a project without a Kit: the cue table\'s clip_gain', async () => {
    const { useSceneStore } = await openPage(project(false))
    const s = useSceneStore.getState()
    expect(s.projectKit).toBeNull()
    const v = sent(s)
    expect(v.bar).toBeCloseTo(0.5 * 0.5)
    expect(v.clip).toBeCloseTo(0.5 * 0.5)
    expect(v.fire).toBeCloseTo(0.5 * 0.5)
  })

  it('the Kit editor changes an event\'s clip_gain and saves the folder: the Scene sends the new value, the cue table untouched', async () => {
    const folder = project(true, 0.5)
    const { useSceneStore, useLibraryStore } = await openPage(folder)
    expect(sent(useSceneStore.getState()).fire).toBeCloseTo(0.25)
    const kitsDir = await folder.handle.getDirectoryHandle('kits')
    useLibraryStore.setState({ kits: [kitDefinition(0.5)], kitDirHandle: kitsDir, workDirHandle: null })
    await useLibraryStore.getState().updateKitEvent('kit-sports', 'ev-thump', { clipGain: 0.2 })
    expect(await useLibraryStore.getState().flushKitFolderNow('kit-sports')).not.toBeNull()
    const written = JSON.parse(folder.read('kits/sports-kit/sports-kit-manifest.json')!) as { events: Record<string, { parameters: { clip_gain: number } }> }
    expect(written.events['sports-kit.thump'].parameters.clip_gain).toBe(0.2)
    await settle()
    const s = useSceneStore.getState()
    expect(s.projectKit?.clipGains.thump).toBe(0.2)
    const v = sent(s)
    expect(v.fire).toBeCloseTo(0.2 * 0.5)
    expect(v.clip).toBeCloseTo(0.2 * 0.5)
    expect(v.bar).toBeCloseTo(0.2 * 0.5)
    expect(parseCueTable(folder.read(paths.cues)!).clips.thump.clip_gain).toBe(0.5)
    expect(s.dirty).toBe(false)
  })

  it('a differing copy is aligned by 「cue 表をそろえる」 and by any cue table save', async () => {
    const folder = project(true, 0.3)
    const { useSceneStore } = await openPage(folder)
    expect(useSceneStore.getState().alignToKit()).toBe(true)
    expect(useSceneStore.getState().table!.clips.thump.clip_gain).toBe(0.3)
    await vi.advanceTimersByTimeAsync(400)
    expect(parseCueTable(folder.read(paths.cues)!).clips.thump).toMatchObject({ clip_gain: 0.3, loop: false })
    expect(kitCopyDiffers(useSceneStore.getState().table!, useSceneStore.getState().projectKit!.clipGains)).toEqual([])
    expect(useSceneStore.getState().alignToKit()).toBe(false) // nothing differs

    // Another project whose copy differs: an unrelated edit saves the copy aligned too.
    const other = project(true, 0.7)
    const { useSceneStore: next } = await openPage(other)
    expect(next.getState().edit(tb => ({ ...tb, cues: { ...tb.cues, detent: { ...tb.cues.detent, haptics: [{ clip: 'thump', at: 'pos_chest', gain: 0.6 }] } } }))).toBe(true)
    await vi.advanceTimersByTimeAsync(400)
    const saved = parseCueTable(other.read(paths.cues)!)
    expect(saved.clips.thump.clip_gain).toBe(0.7)
    expect(saved.cues.detent.haptics![0].gain).toBe(0.6)
    expect(saved.clips.click.clip_gain).toBe(1)
  })
})
