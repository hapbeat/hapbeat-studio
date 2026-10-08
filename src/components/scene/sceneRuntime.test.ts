import { afterEach, describe, expect, it, vi } from 'vitest'

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
    // The row again while it is shown: from the start.
    video.currentTime = 30; runtime.playMoment(0, 1); expect(video.currentTime).toBe(0); expect(video.paused).toBe(false)
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
