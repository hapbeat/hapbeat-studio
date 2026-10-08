import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditorPlayback, MIN_LOOP_PERIOD_MS } from './editorPlayback'
import { EditorBufferPlayer } from './editorBufferPlayer'
import { onUserStop } from './playerStops'
import { FiringScheduler } from './firingScheduler'
const audio = (duration: number) => ({duration}) as AudioBuffer
function engine() {
  const sources: Array<{buffer: AudioBuffer | null; onended: (() => void) | null; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; connect: ReturnType<typeof vi.fn>}> = []
  const gain = {gain: {value: 1}, connect: vi.fn()}
  const context = {currentTime: 0, state: 'running', destination: {}, createGain: () => gain, resume: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined), createBufferSource: () => {
    const source = {buffer: null, onended: null, start: vi.fn(), stop: vi.fn(), disconnect: vi.fn(), connect: vi.fn()}; sources.push(source); return source
  }}
  return {context, sources, gain, create: () => context as unknown as AudioContext}
}
afterEach(() => vi.useRealTimers())
describe('editor buffer player (silent mock context)', () => {
  it('integrates selection looping, silent delay, staged preview and cancellation', async () => {
    vi.useFakeTimers(); const e = engine(), original = audio(5), preview = audio(5)
    const player = new EditorBufferPlayer(original, e.create)
    const playback = new EditorPlayback(player, vi.fn(), [], vi.fn(), vi.fn())
    player.on('pause', () => playback.paused()); player.on('finish', () => playback.paused()); player.on('timeupdate', time => playback.timeUpdated(time))
    playback.configure({start: 2, end: 2.01}, true, 1)
    await playback.toggle(); expect(e.sources[0].start).toHaveBeenCalledWith(0, 2, expect.closeTo(.01))
    player.setBuffer(preview); e.sources[0].onended!()
    await vi.advanceTimersByTimeAsync(999); expect(e.sources).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1); expect(e.sources).toHaveLength(2); expect(e.sources[1].buffer).toBe(preview)
    e.sources[1].onended!(); playback.stop(); await vi.advanceTimersByTimeAsync(1000)
    expect(e.sources).toHaveLength(2); player.dispose()
  })

  it('the tick reaching the end first is the natural end too (pause + finish); the node still sounds its last ms', async () => {
    vi.useFakeTimers(); const e = engine(), player = new EditorBufferPlayer(audio(1), e.create)
    const events: string[] = []; for (const name of ['pause', 'finish'] as const) player.on(name, () => events.push(name))
    const stopped = vi.fn(); onUserStop(player, stopped)
    player.prepare(); await player.play(0, 1)
    e.context.currentTime = 1; await vi.advanceTimersByTimeAsync(16)
    expect(events).toEqual(['pause', 'finish']); expect(player.isPlaying()).toBe(false); expect(player.getCurrentTime()).toBe(1)
    expect(e.sources[0].stop).not.toHaveBeenCalled(); expect(e.sources[0].disconnect).not.toHaveBeenCalled()
    e.sources[0].onended!(); expect(e.sources[0].disconnect).toHaveBeenCalledOnce(); expect(events).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(10); expect(stopped).not.toHaveBeenCalled()
    player.dispose()
  })
  it('loop: each pass re-arms the sounds once (no stacking, no user stop after a repeat); Stop ends it all', async () => {
    vi.useFakeTimers(); const e = engine(), player = new EditorBufferPlayer(audio(1), e.create)
    // The sounds as useDecidedSoundSync wires them: (re)started on play, stopped on a user stop only.
    const voices: Array<{ stopped: boolean }> = []
    const ctx = { currentTime: 0, destination: {}, createGain: () => ({ gain: { value: 1 }, connect: vi.fn() }), createBufferSource: () => {
      const v = { buffer: null as unknown, stopped: false, connect: vi.fn(), start: vi.fn(), stop() { v.stopped = true } }; voices.push(v); return v
    } }
    const scheduler = new FiringScheduler<{ duration: number }>(() => ctx)
    scheduler.setFirings([{ atSec: 0, buffer: { duration: 3 }, gain: 1 }, { atSec: 0.5, buffer: { duration: 3 }, gain: 1 }])
    const userStop = vi.fn(() => scheduler.stop())
    player.on('play', time => scheduler.play(time)); onUserStop(player, userStop)
    const playback = new EditorPlayback(player, vi.fn(), [], vi.fn(), vi.fn())
    player.on('pause', () => playback.paused()); player.on('finish', () => playback.paused()); player.on('timeupdate', time => playback.timeUpdated(time))
    playback.configure(null, true); await playback.toggle()
    for (let pass = 1; pass <= 5; pass++) {
      expect(e.sources).toHaveLength(pass)
      // Alternate which notices the end first: the 16 ms tick or the node's 'ended'.
      e.context.currentTime += 1
      if (pass % 2) await vi.advanceTimersByTimeAsync(16); else e.sources[pass - 1].onended!()
      await vi.advanceTimersByTimeAsync(MIN_LOOP_PERIOD_MS)
      expect(player.isPlaying()).toBe(true)
      expect(voices.filter(v => !v.stopped)).toHaveLength(2)
    }
    expect(userStop).not.toHaveBeenCalled()
    playback.stop(); await vi.advanceTimersByTimeAsync(1000)
    expect(userStop).toHaveBeenCalledOnce(); expect(voices.filter(v => !v.stopped)).toHaveLength(0)
    expect(e.sources).toHaveLength(6); expect(player.isPlaying()).toBe(false); expect(playback.pending).toBe(false)
    player.dispose()
  })

  it('schedules exactly the selected duration, including sub-frame selections', async () => {
    vi.useFakeTimers(); const e = engine(), player = new EditorBufferPlayer(audio(2), e.create)
    const paused = vi.fn(); player.on('pause', paused)
    player.prepare(); await player.play(.2, .205)
    expect(e.sources[0].start).toHaveBeenCalledWith(0, .2, expect.closeTo(.005))
    e.sources[0].onended!()
    expect(player.isPlaying()).toBe(false); expect(player.getCurrentTime()).toBe(.205); expect(paused).toHaveBeenCalledOnce()
    player.dispose()
  })
  it('stages preview buffers without interrupting the current pass and uses them next time', async () => {
    vi.useFakeTimers(); const e = engine(), original = audio(1), preview = audio(1)
    const player = new EditorBufferPlayer(original, e.create); player.prepare(); await player.play(0, 1)
    player.setBuffer(preview)
    expect(e.sources[0].buffer).toBe(original); expect(e.sources[0].stop).not.toHaveBeenCalled()
    e.sources[0].onended!(); player.prepare(); await player.play(0, 1)
    expect(e.sources[1].buffer).toBe(preview); player.dispose()
  })
  it('cancels delayed audio activation and survives a StrictMode lifecycle replay', async () => {
    const e = engine(); e.context.state = 'suspended'
    let resume!: () => void; e.context.resume.mockImplementation(() => new Promise<void>(resolve => {resume = resolve}))
    const player = new EditorBufferPlayer(audio(1), e.create)
    const pending = player.play(); player.pause(); resume(); await pending
    expect(e.sources).toHaveLength(0)
    player.dispose(); player.activate(); e.context.state = 'running'; player.prepare(); await player.play()
    expect(player.isPlaying()).toBe(true); player.dispose()
  })

  it('a haptic audition is not connected to the PC output (playback still runs); reconnects when allowed', async () => {
    const e = engine(), player = new EditorBufferPlayer(audio(2), e.create)
    ;(e.gain as unknown as { disconnect: () => void }).disconnect = vi.fn()
    player.setOutput(false)
    await player.play(0, 1)
    expect(e.gain.connect).not.toHaveBeenCalled()
    expect(e.sources[0].start).toHaveBeenCalled()
    player.setOutput(true)
    expect(e.gain.connect).toHaveBeenCalledWith(e.context.destination)
    player.dispose()
  })
})
