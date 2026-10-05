import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditorPlayback } from './editorPlayback'
import { EditorBufferPlayer } from './editorBufferPlayer'
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
