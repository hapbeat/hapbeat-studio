import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditorPlayback } from './editorPlayback'
import type { StreamOptions } from './audioStreamer'
import type { ManagerMessage } from '@/types/manager'
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => {resolve = r}); return {promise, resolve} }
const player = () => ({play: vi.fn().mockResolvedValue(undefined), pause: vi.fn(), isPlaying: () => false, getCurrentTime: () => 2, getDuration: () => 10})
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
afterEach(() => vi.useRealTimers())
describe('editor playback routing without physical output', () => {
  it.each([2.1, 3, 3.9])('always starts at the selection head even with the cursor at %s', async time => {
    const pc = player(); pc.getCurrentTime = () => time
    const playback = new EditorPlayback(pc, vi.fn(), [], vi.fn(), vi.fn())
    playback.configure({start: 4, end: 2}, false); await playback.toggle()
    expect(pc.play).toHaveBeenLastCalledWith(2, 4); playback.stop()
  })
  it('waits exactly the configured silent interval and cancels repeats on Stop', async () => {
    vi.useFakeTimers(); const pc = player(); let time = 2; pc.getCurrentTime = () => time
    const playback = new EditorPlayback(pc, vi.fn(), [], vi.fn(), vi.fn())
    playback.configure({start: 2, end: 4}, true, 1); await playback.toggle()
    time = 4; playback.paused()
    expect(playback.pending).toBe(true)
    await vi.advanceTimersByTimeAsync(999); expect(pc.play).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1); expect(pc.play).toHaveBeenCalledTimes(2)
    playback.paused(); playback.stop(); await vi.advanceTimersByTimeAsync(2000)
    expect(pc.play).toHaveBeenCalledTimes(2); expect(playback.pending).toBe(false)
  })
  it('cancels the silence wait when repeat is unchecked', async () => {
    vi.useFakeTimers(); const pc = player(); pc.getCurrentTime = () => 4
    const playback = new EditorPlayback(pc, vi.fn(), [], vi.fn(), vi.fn())
    playback.configure({start: 2, end: 4}, true, 1); await playback.toggle(); playback.paused()
    playback.configure({start: 2, end: 4}, false, 1); await vi.advanceTimersByTimeAsync(2000)
    expect(pc.play).toHaveBeenCalledTimes(1); expect(playback.pending).toBe(false)
  })

  it('enforces the end even after seeking clears the player scheduled stop', async () => {
    const pc = player(), playback = new EditorPlayback(pc, vi.fn(), [], vi.fn(), vi.fn())
    playback.configure({start: 2, end: 4}, false); await playback.toggle()
    pc.isPlaying = () => true
    pc.pause.mockClear()
    playback.seek(3); playback.timeUpdated(3.5)
    expect(pc.pause).not.toHaveBeenCalled()
    playback.timeUpdated(4.01)
    expect(pc.pause).toHaveBeenCalledTimes(1)
    playback.stop()
  })

  it('uses the selection for ordinary playback, stops at its boundary and loops only that range', async () => {
    const pc = player(); let time = 0; pc.getCurrentTime = () => time
    const playback = new EditorPlayback(pc, vi.fn(), [], vi.fn(), vi.fn())
    playback.configure({start: 3, end: 4}, false)
    await playback.toggle()
    expect(pc.play).toHaveBeenLastCalledWith(3, 4)
    time = 4; playback.paused(); await tick()
    expect(pc.play).toHaveBeenCalledTimes(1)
    playback.configure({start: 3, end: 4}, true)
    await playback.toggle(); playback.paused(); playback.paused(); await tick()
    expect(pc.play).toHaveBeenCalledTimes(3)
    expect(pc.play).toHaveBeenLastCalledWith(3, 4)
    playback.stop()
  })
  it('does not restart a queued loop after explicit Stop or clip cleanup', async () => {
    const pc = player(); let time = 3; pc.getCurrentTime = () => time
    const playback = new EditorPlayback(pc, vi.fn(), [], vi.fn(), vi.fn())
    playback.configure({start: 3, end: 4}, true); await playback.toggle()
    time = 4; playback.paused(); playback.stop(); await tick()
    expect(pc.play).toHaveBeenCalledTimes(1)
  })

  it('plays PC only when no connected target is selected', async () => {
    const pc = player(), encode = vi.fn(), send = vi.fn(), stream = vi.fn()
    await new EditorPlayback(pc, encode, [], send, stream).toggle()
    expect(pc.play).toHaveBeenCalledWith(2, 10)
    expect(encode).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled(); expect(stream).not.toHaveBeenCalled()
  })
  it('starts PC at stream begin and routes every packet to explicit targets, including selection seek', async () => {
    const pc = player(), send = vi.fn()
    const stream = vi.fn(async (_: Blob, route: (m: ManagerMessage) => void, options: StreamOptions) => {
      expect(pc.play).not.toHaveBeenCalled()
      route({type: 'stream_begin', payload: {sample_rate: 16000}})
      expect(pc.play).toHaveBeenCalledWith(2, 4)
      expect(options.control?.consumeSeek?.()).toBe(0)
      expect(options.control?.consumeSeek?.()).toBeNull()
      route({type: 'stream_data', payload: {data: 'mock'}})
      route({type: 'stream_end', payload: {}})
    })
    const encode = vi.fn(async () => new Blob())
    await new EditorPlayback(pc, encode, ['192.0.2.1'], send, stream).play(2, 4)
    expect(encode).toHaveBeenCalledWith(2, 4)
    expect(send).toHaveBeenCalledTimes(3)
    for (const [message] of send.mock.calls) expect(message.payload.targets).toEqual(['192.0.2.1'])
  })
  it('cancels preparation without a late PC or haptic start', async () => {
    const pc = player(), encoded = deferred<Blob>(), stream = vi.fn(), send = vi.fn()
    const playback = new EditorPlayback(pc, () => encoded.promise, ['192.0.2.1'], send, stream)
    const task = playback.play(); await tick(); playback.stop(); encoded.resolve(new Blob()); await task
    expect(pc.play).not.toHaveBeenCalled(); expect(stream).not.toHaveBeenCalled(); expect(playback.pending).toBe(false)
  })
  it('finishes an aborted stream before a new instance sends begin', async () => {
    const events: string[] = [], ended = deferred<void>()
    const stream = async (_: Blob, send: (m: ManagerMessage) => void, options: StreamOptions) => {
      send({type: 'stream_begin', payload: {}})
      await new Promise<void>(resolve => options.signal?.addEventListener('abort', () => resolve(), {once: true}))
      await ended.promise
      send({type: 'stream_data', payload: {}}) // A late data callback must be suppressed.
      send({type: 'stream_end', payload: {}})
    }
    const first = new EditorPlayback(player(), async () => new Blob(), ['192.0.2.1'], m => events.push(`first:${m.type}`), stream)
    const task = first.play(); await tick(); first.stop()
    const second = new EditorPlayback(player(), async () => new Blob(), ['192.0.2.2'], m => events.push(`second:${m.type}`), async (_, send) => {send({type: 'stream_begin', payload: {}}); send({type: 'stream_end', payload: {}})})
    const next = second.play(); await tick()
    expect(events).toEqual(['first:stream_begin'])
    ended.resolve(); await Promise.all([task, next])
    expect(events).toEqual(['first:stream_begin', 'first:stream_end', 'second:stream_begin', 'second:stream_end'])
  })
})
