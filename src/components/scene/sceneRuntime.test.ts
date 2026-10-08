import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/utils/sceneSegments', async orig => { const m = await orig<typeof import('@/utils/sceneSegments')>(); return { ...m, runPosition: vi.fn(m.runPosition) } })
vi.mock('@/utils/sceneProject', async orig => ({ ...(await orig<typeof import('@/utils/sceneProject')>()), readProjectFile: async (_root: unknown, path: string) => new File(['x'], path) }))

/** A silent stand-in for the <video> element: a new src loads (metadata) on the next tick; play() only flips `paused`. */
class FakeVideo {
  paused = true; currentTime = 0; duration = 0; readyState = 0; loop = false; muted = false; playsInline = false; preload = ''; className = ''; playbackRate = 1; seeking = false; ended = false
  onloadedmetadata: (() => void) | null = null
  played = 0
  private _src = ''
  get src() { return this._src }
  set src(v: string) { this._src = v; this.readyState = 0; setTimeout(() => { this.duration = 60; this.readyState = 1; this.onloadedmetadata?.() }, 0) }
  removeAttribute() { this._src = '' }
  load() {}
  play() { this.paused = false; this.played++; return Promise.resolve() }
  pause() { this.paused = true }
  addEventListener() {}
  removeEventListener() {}
}
let video: FakeVideo
vi.stubGlobal('document', { createElement: () => (video = new FakeVideo()), addEventListener() {}, removeEventListener() {}, visibilityState: 'visible', hidden: false })
vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} })
const flush = async () => { for (let i = 0; i < 5; i++) { await new Promise(r => setTimeout(r, 0)) } }

afterEach(() => vi.clearAllTimers())

describe('Scene playback starts only on a user action, the full replay included', () => {
  it('opening does not play; the full replay row, ▶ and Space play it', async () => {
    const { useSceneStore } = await import('@/stores/sceneStore')
    const { SceneRuntime } = await import('./sceneRuntime')
    const { buildItems } = await import('@/utils/sceneData')
    const data = { fps: 30, full: { file: 'full.mp4', levels: [], events: [] }, clips: [{ file: '01.mp4', name: 'roar', names: ['roar'], hand: 'both', at: 7.9, note: '', event: 1, levels: [] }] }
    useSceneStore.setState({ root: {} as FileSystemDirectoryHandle, lib: null, data, recorded: data, items: buildItems(data), cur: 1, table: null })
    const runtime = new SceneRuntime()
    runtime.start()
    await flush()
    expect(video.src).toContain('blob:'); expect(video.paused).toBe(true) // loaded, not played
    // The full replay row (moment 0): loads it and plays from its start.
    runtime.playMoment(0, 1)
    await flush()
    expect(useSceneStore.getState().cur).toBe(0); expect(video.paused).toBe(false); expect(video.currentTime).toBe(0)
    // ▶ / Space (togglePlay): pause, then play again.
    runtime.togglePlay(); expect(video.paused).toBe(true)
    runtime.togglePlay(); expect(video.paused).toBe(false)
    // The row again while it is shown: plays on from where it is (R restarts).
    video.currentTime = 30; runtime.playMoment(0, 1); expect(video.currentTime).toBe(30); expect(video.paused).toBe(false)
    runtime.restart(); expect(video.currentTime).toBe(0)
    // A clip moment: from the lead-in before its mark.
    runtime.playMoment(1, 1); await flush()
    expect(useSceneStore.getState().cur).toBe(1); expect(video.currentTime).toBe(0); expect(video.paused).toBe(false)
    runtime.stop()
  })

  it('a re-opened project (new folder, same file names) loads its video again, so the full replay still plays', async () => {
    const { useSceneStore } = await import('@/stores/sceneStore')
    const { SceneRuntime } = await import('./sceneRuntime')
    const { buildItems } = await import('@/utils/sceneData')
    // A recording with only the full replay (no cut clips): the full replay is moment 0 and stays selected.
    const data = { fps: 30, full: { file: 'full.mp4', levels: [], events: [] }, clips: [] }
    useSceneStore.setState({ root: {} as FileSystemDirectoryHandle, lib: null, data, recorded: data, items: buildItems(data), cur: 0, table: null })
    const runtime = new SceneRuntime()
    runtime.start(); await flush()
    const first = video.src
    expect(first).toContain('blob:'); expect(video.paused).toBe(true)
    // Re-opened (the folder's video URLs are revoked and made again): the same moment 0 must load the new URL.
    URL.revokeObjectURL(first)
    const load = vi.spyOn(runtime as unknown as { loadItem: () => void }, 'loadItem')
    const again = structuredClone(data)
    useSceneStore.setState({ root: {} as FileSystemDirectoryHandle, recorded: again, data: again, items: buildItems(again), cur: 0 })
    await flush()
    expect(load).toHaveBeenCalled() // the moment is loaded again (a new video URL), not left on the revoked one
    runtime.playMoment(0, 1); await flush()
    expect(video.paused).toBe(false); expect(video.currentTime).toBe(0)
    runtime.stop()
  })
})

describe('Back to the full replay after tuning a moment or a span (「全編に戻って続ける」, F)', () => {
  const setup = async () => {
    const { useSceneStore } = await import('@/stores/sceneStore')
    const { useSceneSettings } = await import('@/stores/sceneSettings')
    const { SceneRuntime } = await import('./sceneRuntime')
    const { buildItems } = await import('@/utils/sceneData')
    // Clip 1: its mark is 1 s into the clip and 7.9 s into the full replay (offset 6.9 s).
    const data = { fps: 30, full: { file: 'full.mp4', levels: [], events: [] }, clips: [{ file: '01.mp4', name: 'roar', names: ['roar'], hand: 'both', at: 7.9, note: '', event: 1, levels: [] }] }
    useSceneStore.setState({ root: {} as FileSystemDirectoryHandle, lib: null, data, recorded: data, items: buildItems(data), cur: 0, table: null, span: null })
    useSceneSettings.getState().update({ leadSec: 1 })
    const runtime = new SceneRuntime()
    runtime.start(); await flush()
    const tick = () => (runtime as unknown as { tick: () => void }).tick()
    return { runtime, useSceneStore, tick }
  }

  it('a clip: the full replay at clip time + (at − event), still playing; the 全編 row resumes there, R still goes to 0', async () => {
    const { runtime, useSceneStore, tick } = await setup()
    runtime.playMoment(0, 1); await flush()
    video.currentTime = 20; tick() // watching the full replay at 20 s
    runtime.playMoment(1, 1); await flush() // tune the clip
    expect(useSceneStore.getState().cur).toBe(1); expect(runtime.fullTime).toBe(20)
    video.currentTime = 2.5; tick() // played inside the clip, 1.5 s after its mark
    runtime.returnToFull(); await flush()
    expect(useSceneStore.getState().cur).toBe(0); expect(video.currentTime).toBeCloseTo(9.4); expect(video.paused).toBe(false)
    expect(runtime.part).toBe(false); expect(runtime.partAB).toBeNull()
    // Back to the clip and the 全編 row again: resumes at the remembered 9.4 s, not 0.
    tick(); runtime.playMoment(1, 1); await flush()
    runtime.playMoment(0, 1); await flush()
    expect(useSceneStore.getState().cur).toBe(0); expect(video.currentTime).toBeCloseTo(9.4); expect(video.paused).toBe(false)
    runtime.restart(); expect(video.currentTime).toBe(0)
    runtime.stop()
  })

  it('a clip not played yet: its mark − the lead-in, and paused stays paused', async () => {
    const { runtime, useSceneStore, tick } = await setup()
    useSceneStore.getState().select(1); await flush() // shown (↓), not played
    tick()
    expect(video.paused).toBe(true)
    runtime.returnToFull(); await flush()
    expect(useSceneStore.getState().cur).toBe(0); expect(video.currentTime).toBeCloseTo(6.9); expect(video.paused).toBe(true)
    expect(runtime.fullTime).toBeCloseTo(6.9)
    runtime.stop()
  })

  it('a span: its play range is cleared and the full replay goes on from the same time; unplayed: the span start − lead', async () => {
    const { runtime, useSceneStore, tick } = await setup()
    runtime.playMoment(0, 1); await flush()
    video.currentTime = 12; tick()
    runtime.playSpan([30, 34], 1, 1)
    expect(useSceneStore.getState().span).toEqual([30, 34]); expect(video.currentTime).toBe(29); expect(runtime.fullTime).toBe(12)
    video.currentTime = 31.5; tick()
    runtime.returnToFull()
    expect(useSceneStore.getState().span).toBeNull(); expect(runtime.part).toBe(false); expect(runtime.partAB).toBeNull()
    expect(video.currentTime).toBe(31.5); expect(video.paused).toBe(false); expect(runtime.fullTime).toBe(31.5)
    // A span left before it played (paused at once): its start − the lead-in, paused.
    runtime.playSpan([40, 44], 1, 1); video.pause(); video.currentTime = 41
    runtime.returnToFull()
    expect(video.currentTime).toBe(39); expect(video.paused).toBe(true); expect(useSceneStore.getState().span).toBeNull()
    runtime.stop()
  })

  it('the 全編 row after a span resumes where the full replay was left for it', async () => {
    const { runtime, useSceneStore, tick } = await setup()
    runtime.playMoment(0, 1); await flush()
    video.currentTime = 12; tick()
    runtime.playSpan([30, 34], 1, 1); video.currentTime = 31; tick()
    runtime.playMoment(0, 1)
    expect(useSceneStore.getState().span).toBeNull(); expect(video.currentTime).toBe(12); expect(video.paused).toBe(false)
    runtime.stop()
  })
})

/** A silent Web Audio stand-in: records the looping sources the runtime starts and stops. */
class FakeParam { value = 0; target: number | null = null; setValueAtTime(v: number) { this.value = v } setTargetAtTime(v: number) { this.target = v } }
class FakeSource {
  buffer: unknown = null; loop = false; playbackRate = new FakeParam(); onended: (() => void) | null = null; started = false; stopped = false
  connect<T>(node: T) { return node }
  disconnect() {}
  start() { this.started = true }
  stop() { this.stopped = true }
}
class FakeAudioContext {
  static last: FakeAudioContext | null = null
  state = 'running'; currentTime = 0; destination = {}; sources: FakeSource[] = []; gains: { gain: FakeParam }[] = []
  constructor() { FakeAudioContext.last = this }
  createBufferSource() { const s = new FakeSource(); this.sources.push(s); return s }
  createGain() { const g = { gain: new FakeParam(), connect: <T>(node: T) => node, disconnect() {} }; this.gains.push(g); return g }
  resume() { return Promise.resolve() }
  close() { return Promise.resolve() }
}

describe('Scene loop-cue sounds follow the recorded layer level', () => {
  it('plays while the replay plays at level × sfx.volume × intensity; stops at level 0, on pause, seek and with PC sound off', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext)
    const { useSceneStore } = await import('@/stores/sceneStore')
    const { useSceneSettings } = await import('@/stores/sceneSettings')
    const { SceneRuntime } = await import('./sceneRuntime')
    const { buildItems } = await import('@/utils/sceneData')
    // Spindle (gain col 0, rate col 1) off for 1 s, then on at 0.9 rate; a haptic-only layer (cols 2, 3) whose cue has no sound.
    const levels = Array.from({ length: 90 }, (_, i) => i < 30 ? [0, 0, 1, 1] : [1, 0.9, 1, 1])
    const lib = {
      layers: [{ cue: 'spindle_loop', gain: [0, 0], rate: [1, 1], colors: [] }, { cue: 'feed_loop', gain: [2, 3], rate: null, colors: [] }],
      loop_cues: ['spindle_loop', 'feed_loop'], loop_cue_sounds: true, ticks: [],
    }
    const table = { clips: {}, sounds: { Motor: { intensity: 0.5 } }, cues: { spindle_loop: { sfx: { sound: 'Motor', volume: 0.8 }, haptics: [] }, feed_loop: { sfx: null, haptics: [] } } }
    const data = { fps: 30, full: { file: 'full.mp4', levels, events: [] }, clips: [] }
    const motor = {} as AudioBuffer
    useSceneSettings.setState({ pcSound: true, sendHaptics: false })
    useSceneStore.setState({ root: {} as FileSystemDirectoryHandle, lib: lib as never, table: table as never, data, recorded: data, items: buildItems(data), cur: 0, sfx: { Motor: motor } })
    const runtime = new SceneRuntime(), tick = () => (runtime as unknown as { tick(): void }).tick()
    runtime.start(); await flush()
    const playAt = (t: number) => { video.readyState = 2; video.paused = false; video.seeking = false; video.currentTime = t; tick() }
    playAt(0.5)
    expect(FakeAudioContext.last?.sources ?? []).toHaveLength(0) // level 0: silent (feed_loop has no sound at any level)
    playAt(1.5)
    const ctx = FakeAudioContext.last!, [src] = ctx.sources
    expect(ctx.sources).toHaveLength(1); expect(src.buffer).toBe(motor); expect(src.loop).toBe(true); expect(src.started).toBe(true)
    expect(src.playbackRate.value).toBeCloseTo(0.9); expect(ctx.gains[0].gain.target).toBeCloseTo(1 * 0.8 * 0.5)
    // Pause: faded out and stopped; playing again starts a new source.
    video.pause(); tick(); expect(src.stopped).toBe(true)
    playAt(1.6); expect(ctx.sources).toHaveLength(2)
    // Seek: stopped while the video seeks.
    video.seeking = true; tick(); expect(ctx.sources[1].stopped).toBe(true)
    // PC sound off: no loop sound even while playing.
    playAt(1.7); expect(ctx.sources).toHaveLength(3)
    useSceneSettings.setState({ pcSound: false }); tick(); expect(ctx.sources[2].stopped).toBe(true)
    playAt(1.8); expect(ctx.sources).toHaveLength(3)
    // Past the recording (the end): silent.
    useSceneSettings.setState({ pcSound: true }); playAt(10); expect(ctx.sources).toHaveLength(3)
    // Closing the tab while it sounds: stopped.
    playAt(1.9); expect(ctx.sources).toHaveLength(4)
    runtime.dispose(); expect(ctx.sources[3].stopped).toBe(true)
    // Without lib.loop_cue_sounds: no loop sound at any level.
    useSceneStore.setState({ lib: { ...lib, loop_cue_sounds: false } as never })
    const quiet = new SceneRuntime(), quietTick = () => (quiet as unknown as { tick(): void }).tick()
    quiet.start(); await flush()
    video.readyState = 2; video.paused = false; video.seeking = false; video.currentTime = 1.5; quietTick()
    expect(FakeAudioContext.last).toBe(ctx); expect(ctx.sources).toHaveLength(4)
    quiet.stop()
  })
})

describe('A loop cue span plays in the full replay over its own range', () => {
  it('playSpan switches to the full replay, plays from the lead-in, repeats at the post-roll end; a moment ends it', async () => {
    const { useSceneStore } = await import('@/stores/sceneStore')
    const { SceneRuntime } = await import('./sceneRuntime')
    const { buildItems } = await import('@/utils/sceneData')
    const data = { fps: 30, full: { file: 'full.mp4', levels: [], events: [] }, clips: [{ file: '01.mp4', name: 'grab', names: ['grab', 'feed_loop'], hand: 'right', at: 4.3, note: '', event: 2, levels: [] }] }
    useSceneStore.setState({ root: {} as FileSystemDirectoryHandle, lib: null, data, recorded: data, items: buildItems(data), cur: 1, table: null, span: null })
    const runtime = new SceneRuntime()
    runtime.start()
    await flush()
    // The second active span of feed_loop (38.5–43.8 s), 1 s lead-in and post-roll.
    runtime.playSpan([38.5, 43.8], 1, 1)
    await flush()
    expect(useSceneStore.getState().cur).toBe(0)
    expect(useSceneStore.getState().span).toEqual([38.5, 43.8])
    expect(video.currentTime).toBe(37.5); expect(video.paused).toBe(false)
    expect(runtime.part).toBe(true); expect(runtime.partAB).toEqual([37.5, 44.8])
    // Reaching the end (span end + post-roll) goes back to the lead-in, not on to the rest of the replay.
    video.currentTime = 44.8
    ;(runtime as unknown as { tick: () => void }).tick()
    expect(video.currentTime).toBe(37.5)
    // A moment row ends the span: no part, no span shown.
    runtime.playMoment(1, 1)
    await flush()
    expect(runtime.part).toBe(false); expect(runtime.partAB).toBeNull(); expect(useSceneStore.getState().span).toBeNull()
    runtime.stop()
  })
})

describe('A levelMap edit reaches the haptic stream at once (DEC-090)', () => {
  it('the next chunk after an unsaved Scene edit uses the new map for the route (hand route, right wrist)', async () => {
    const { useSceneStore } = await import('@/stores/sceneStore')
    const { useSceneSettings } = await import('@/stores/sceneSettings')
    const { SceneRuntime } = await import('./sceneRuntime')
    const { buildItems } = await import('@/utils/sceneData')
    const { setLevelMap } = await import('@/utils/cueEvents')
    const { mapLevel } = await import('@/utils/levelMap')
    const { CHUNK } = await import('@/utils/sceneHaptics')
    // Safety Mill's feed_loop: right hand at input 1.225 (its recorded max), the left hand still; rate 1.
    const levels = Array.from({ length: 300 }, () => [0, 1.225, 1, 1])
    const lib = { project_name: 'mill', paths: { cues: 'cues.json', clips: 'clips', sounds: 'sounds' }, layers: [{ cue: 'feed_loop', gain: [0, 1], rate: [2, 3], colors: [] }], loop_cues: ['feed_loop'], ticks: [] }
    const table = { clips: { feed_loop: { intensity: 0.4202, loop: true } }, sounds: {},
      cues: { feed_loop: { sfx: null, haptics: [{ clip: 'feed_loop', at: 'hand', gain: 1, levelMap: { points: [[0.08, 0.08], [1.225, 0.5]] } }] } } }
    const data = { fps: 30, full: { file: 'full.mp4', levels, events: [] }, clips: [] }
    useSceneSettings.setState({ pcSound: false, sendHaptics: true, hapticLeadMs: 0 })
    useSceneStore.setState({ root: {} as FileSystemDirectoryHandle, lib: lib as never, table: table as never, loaded: null, data, recorded: data, items: buildItems(data), cur: 0,
      pcm: { feed_loop: new Float32Array(4000).fill(1) }, sfx: {} })
    let now = 1000
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
    const sent: { type: string; payload: Record<string, unknown> }[] = []
    const runtime = new SceneRuntime(), tick = () => (runtime as unknown as { tick(): void }).tick()
    runtime.setHelper({ send: (type, payload) => sent.push({ type, payload }), connected: true, devices: [{ ipAddress: '10.0.0.2', address: 'p1/pos_r_wrist' }] })
    runtime.start(); await flush()
    video.readyState = 2; video.paused = false; video.seeking = false; video.currentTime = 3
    const lastGain = () => {
      const d = [...sent].reverse().find(x => x.type === 'stream_data')!
      const pcm16 = new Int16Array(Uint8Array.from(atob(d.payload.data as string), c => c.charCodeAt(0)).buffer)
      return pcm16[CHUNK] / 32767 // mid-chunk sample (L = R)
    }
    tick() // starts the clock (the stream may already be open, sending silence while paused)
    now += 20; tick()
    expect(lastGain()).toBeCloseTo(0.4202 * 0.5, 3)
    // Unsaved edit (the 300 ms autosave has not run): 1.225 → 0.30.
    useSceneStore.getState().edit(tb => setLevelMap(tb, 'feed_loop', 0, { points: [[0.08, 0.08], [1.225, 0.3]] }))
    const before = sent.length
    now += 20; tick() // one 10 ms tick later (plus slack): new chunks are rendered
    expect(sent.length).toBeGreaterThan(before)
    expect(lastGain()).toBeCloseTo(0.4202 * mapLevel({ points: [[0.08, 0.08], [1.225, 0.3]] }, 1.225), 3)
    expect(lastGain()).toBeCloseTo(0.4202 * 0.3, 3)
    runtime.stop(); clock.mockRestore()
  })
})

describe('Scene haptic streams end when the page goes away', () => {
  it('endStreams (pagehide / beforeunload) sends stream_end for the open device stream', async () => {
    const { useSceneStore } = await import('@/stores/sceneStore')
    const { useSceneSettings } = await import('@/stores/sceneSettings')
    const { SceneRuntime } = await import('./sceneRuntime')
    const { buildItems } = await import('@/utils/sceneData')
    const data = { fps: 30, full: { file: 'full.mp4', levels: [], events: [] }, clips: [] }
    useSceneSettings.setState({ pcSound: false, sendHaptics: true, hapticLeadMs: 0 })
    useSceneStore.setState({ root: {} as FileSystemDirectoryHandle, lib: null, table: { clips: {}, sounds: {}, cues: {} } as never, data, recorded: data, items: buildItems(data), cur: 0, pcm: {}, sfx: {} })
    const sent: { type: string; payload: Record<string, unknown> }[] = []
    const runtime = new SceneRuntime(), tick = () => (runtime as unknown as { tick(): void }).tick()
    runtime.setHelper({ send: (type, payload) => sent.push({ type, payload }), connected: true, devices: [{ ipAddress: '10.0.0.2', address: 'p1/pos_r_wrist' }] })
    runtime.start(); await flush()
    video.readyState = 2; video.paused = false; video.seeking = false; video.currentTime = 1
    tick()
    const begin = sent.find(m => m.type === 'stream_begin')!
    expect(runtime.ownsStream(begin.payload.stream_id as string)).toBe(true)
    runtime.endStreams()
    expect(sent[sent.length - 1]).toEqual({ type: 'stream_end', payload: { stream_id: begin.payload.stream_id, targets: ['10.0.0.2'] } })
    expect(runtime.streaming).toBe(false)
    runtime.stop()
  })
})

describe('A variant ramp counts firings in replay time while a clip moment plays', () => {
  it('fire() looks up the run position with the full-replay time, not the clip-relative one', async () => {
    const { useSceneStore } = await import('@/stores/sceneStore')
    const { useSceneSettings } = await import('@/stores/sceneSettings')
    const { SceneRuntime } = await import('./sceneRuntime')
    const { buildItems } = await import('@/utils/sceneData')
    const segments = await import('@/utils/sceneSegments')
    const runPosition = vi.mocked(segments.runPosition)
    // Two hits 0.1 s apart (one run) in the replay; the clip moment starts 9.9 s into the replay.
    const events = [{ t: 10.9, name: 'hit', hand: 'right' }, { t: 11.0, name: 'hit', hand: 'right' }]
    const data = { fps: 30, full: { file: 'full.mp4', levels: [], events }, clips: [{ file: '01.mp4', name: 'hit', names: ['hit'], hand: 'right', at: 10.9, note: '', event: 1, levels: Array.from({ length: 90 }, () => [0]) }] }
    useSceneSettings.setState({ pcSound: false, sendHaptics: false })
    useSceneStore.setState({ root: {} as FileSystemDirectoryHandle, lib: { layers: [], loop_cues: [], ticks: [] } as never, table: { clips: {}, sounds: {}, cues: { hit: { sfx: null, haptics: [] } } } as never,
      data: data as never, recorded: data as never, items: buildItems(data as never), cur: 1, pcm: {}, sfx: {} })
    const runtime = new SceneRuntime(), tick = () => (runtime as unknown as { tick(): void }).tick()
    runtime.start(); await flush()
    runPosition.mockClear()
    const playAt = (vt: number) => { video.readyState = 2; video.paused = false; video.seeking = false; video.currentTime = vt; tick() }
    playAt(0.95); playAt(1.05)
    expect(runPosition.mock.calls.map(c => c[1].t)).toEqual([10.9, 11.0])
    expect(runPosition.mock.results.map(r => r.value)).toEqual([{ index: 0, count: 2 }, { index: 1, count: 2 }])
    runtime.stop()
  })
})
