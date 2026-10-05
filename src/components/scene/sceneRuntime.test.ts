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
