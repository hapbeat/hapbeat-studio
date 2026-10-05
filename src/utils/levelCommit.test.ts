import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditorPlayback } from './editorPlayback'
import { EditorBufferPlayer } from './editorBufferPlayer'
import { LevelCommit, levelText } from './levelCommit'
import { setClipIntensity, type CueTable } from './sceneCueTable'
import type { StreamControl, StreamOptions } from './audioStreamer'
import type { ManagerMessage } from '@/types/manager'

/** A silent mock AudioContext: sources and the one output gain are recorded, nothing is heard. */
function engine() {
  const sources: Array<{ start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; connect: ReturnType<typeof vi.fn>; buffer: AudioBuffer | null; onended: (() => void) | null }> = []
  const gain = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }
  const context = { currentTime: 0, state: 'running', destination: {}, createGain: () => gain, resume: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined), createBufferSource: () => {
    const source = { buffer: null, onended: null, start: vi.fn(), stop: vi.fn(), disconnect: vi.fn(), connect: vi.fn() }; sources.push(source); return source
  } }
  return { sources, gain, create: () => context as unknown as AudioContext }
}
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }
afterEach(() => vi.useRealTimers())

describe('strength slider (DEC-086 intensity) during loop playback', () => {
  it('ten moves change the PC gain and the device stream gain live, never stop or restart, and save once debounced', async () => {
    vi.useFakeTimers()
    const e = engine(), player = new EditorBufferPlayer({ duration: 2 } as AudioBuffer, e.create)
    // One device target: the stream is the haptic path; it keeps running (never resolves) like a long stream.
    let control: StreamControl | undefined
    const stream = vi.fn((_blob: Blob, send: (message: ManagerMessage) => void, options: StreamOptions) => {
      control = options.control
      send({ type: 'stream_begin', payload: {} } as ManagerMessage)
      return new Promise<void>(() => {})
    })
    const playback = new EditorPlayback(player, vi.fn().mockResolvedValue(new Blob()), ['10.0.0.9'], vi.fn(), stream)
    player.on('pause', () => playback.paused()); player.on('finish', () => playback.paused())
    playback.configure(null, true)
    // The editor's wiring (WaveformEditor): the shown level is the PC gain and the stream's per-chunk gain.
    let level = 1
    playback.level = () => level
    let table = { kit: 'k', clips: { step: { intensity: 1 } }, cues: { footstep: { haptics: [] } } } as unknown as CueTable
    const cues = table.cues
    const save = vi.fn((value: number) => { table = setClipIntensity(table, 'step', value) })
    const commit = new LevelCommit(save)
    const move = (value: number) => { level = value; player.setLevel(value); commit.input(value) }

    void playback.play(); await flush()
    expect(e.sources).toHaveLength(1); expect(player.isPlaying()).toBe(true)
    const sent: number[] = []
    for (let i = 1; i <= 10; i++) {
      move(1 - i * 0.05)
      sent.push(control!.getIntensity!()) // the next chunk the stream sends
      expect(e.gain.gain.value).toBeCloseTo(1 - i * 0.05)
      await vi.advanceTimersByTimeAsync(100)
    }
    // Nothing stopped or restarted: one source, never stopped; one stream; still playing, no loop wait pending.
    expect(e.sources).toHaveLength(1); expect(e.sources[0].stop).not.toHaveBeenCalled()
    expect(stream).toHaveBeenCalledTimes(1); expect(player.isPlaying()).toBe(true); expect(playback.pending).toBe(false)
    expect(sent.map(x => Math.round(x * 100) / 100)).toEqual([0.95, 0.9, 0.85, 0.8, 0.75, 0.7, 0.65, 0.6, 0.55, 0.5])
    // Saved only 500 ms after the last move, once, with the last value; the cues stay the same object (no scene re-resolve).
    expect(save).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(400)
    expect(save).toHaveBeenCalledOnce(); expect(save).toHaveBeenLastCalledWith(0.5)
    expect(table.clips.step.intensity).toBe(0.5); expect(table.cues).toBe(cues)
    expect(e.sources).toHaveLength(1); expect(player.isPlaying()).toBe(true)
    playback.stop(); player.dispose()
  })

  it('a release saves at once; muting keeps the level for later', async () => {
    vi.useFakeTimers()
    const save = vi.fn(), commit = new LevelCommit(save)
    commit.input(0.3); commit.input(0.4); commit.flush()
    expect(save).toHaveBeenCalledOnce(); expect(save).toHaveBeenLastCalledWith(0.4)
    await vi.advanceTimersByTimeAsync(1000); expect(save).toHaveBeenCalledOnce()
    commit.flush(); expect(save).toHaveBeenCalledOnce()
    const e = engine(), player = new EditorBufferPlayer({ duration: 1 } as AudioBuffer, e.create)
    player.prepare(); await player.play(0, 1)
    player.setLevel(0.25); expect(e.gain.gain.value).toBe(0.25)
    player.setMuted(true); expect(e.gain.gain.value).toBe(0)
    player.setMuted(false); expect(e.gain.gain.value).toBe(0.25)
    player.dispose()
  })

  it('shows the level with dB', () => {
    expect(levelText(1)).toBe('1.00 · 0.0 dB')
    expect(levelText(0.5)).toBe('0.50 · -6.0 dB')
    expect(levelText(0)).toBe('0.00 · −∞ dB')
  })
})
