import { describe, expect, it } from 'vitest'
import { buildLoopSounds, LOOP_SOUND_FADE, LOOP_SOUND_FADE_IN, LOOP_SOUND_STOP, LOOP_SOUND_TAU, LoopSoundPlayer, loopSoundLevel, type LoopAudio } from './sceneLoopSounds'
import type { CueTable } from './sceneCueTable'
import type { SceneLayer, SceneLib } from './sceneData'

/** Silent stand-ins for the Web Audio nodes: they record what was scheduled. */
class FakeParam {
  value = 0
  targets: { v: number; at: number; tau: number }[] = []
  setValueAtTime(v: number) { this.value = v; return this }
  setTargetAtTime(v: number, at: number, tau: number) { this.targets.push({ v, at, tau }); return this }
  get target() { return this.targets[this.targets.length - 1]?.v }
}
class FakeSource {
  buffer: unknown = null; loop = false; playbackRate = new FakeParam(); onended: (() => void) | null = null
  started: number | null = null; stopped: number | null = null
  connect<T>(node: T) { return node }
  disconnect() {}
  start(at: number) { this.started = at }
  stop(at: number) { this.stopped = at }
}
class FakeGain { gain = new FakeParam(); connect<T>(node: T) { return node } disconnect() {} }
class FakeCtx {
  currentTime = 10; destination = {}; sources: FakeSource[] = []; gains: FakeGain[] = []
  createBufferSource() { const s = new FakeSource(); this.sources.push(s); return s }
  createGain() { const g = new FakeGain(); this.gains.push(g); return g }
}
const audioOf = (ctx: FakeCtx) => () => ctx as unknown as LoopAudio
const buf = (name: string) => ({ name }) as unknown as AudioBuffer

const lib = (layers: SceneLayer[], loopCueSounds = true) => ({ layers, loop_cues: layers.map(l => l.cue), loop_cue_sounds: loopCueSounds }) as unknown as SceneLib
const layer = (cue: string, gain: number[], rate: number[] | null = null): SceneLayer => ({ cue, gain, rate, colors: [] })
// Safety Mill's shape: a haptic-only layer, a hand layer with a sound, one sound-only layer and one with a rate column.
const MILL = lib([layer('feed_loop', [0, 1], [2, 3]), layer('brush_loop', [4, 5]), layer('cut_loop', [6, 6]), layer('spindle_loop', [7, 7], [8, 8])])
const TABLE = {
  clips: {}, sounds: { BrushLoop: { intensity: 0.5 }, Cutting: { intensity: 0.1 } },
  cues: {
    feed_loop: { sfx: null, haptics: [] },
    brush_loop: { sfx: { sound: 'BrushLoop', volume: 1 } },
    cut_loop: { sfx: { sound: 'Cutting', volume: 0.8 } },
    spindle_loop: { sfx: { sounds: ['Motor', 'MotorB'], volume: 1 } },
  },
} as unknown as CueTable

describe('loop-cue sounds (lib.loop_cue_sounds)', () => {
  it('takes each layer cue with a sound: its first sound, sfx.volume × the sound intensity; none without loop_cue_sounds', () => {
    expect(buildLoopSounds(TABLE, MILL)).toEqual([
      { layer: 1, sound: 'BrushLoop', gain: 0.5 },
      { layer: 2, sound: 'Cutting', gain: 0.8 * 0.1 },
      { layer: 3, sound: 'Motor', gain: 1 }, // no re-pick: the first of `sounds`; no `sounds` entry = intensity 1
    ])
    expect(buildLoopSounds(TABLE, lib(MILL.layers, false))).toEqual([])
    // A layer cue missing from the table, or with no sfx key, stays silent.
    expect(buildLoopSounds({ clips: {}, cues: { hold: {} } } as unknown as CueTable, lib([layer('hold', [0, 1]), layer('gone', [2, 3])]))).toEqual([])
  })

  it('maps the recorded level: the louder hand, interpolated between frames, and its rate column', () => {
    const fps = 10, hand = layer('rub', [0, 1], [2, 3]), levels = [[0.2, 0.6, 0.9, 1.1], [0.4, 0.2, 0.7, 1.3], [0, 0, 0, 0]]
    // t = 0: right hand louder → its gain and rate.
    expect(loopSoundLevel(levels, fps, hand, 0)).toEqual({ gain: 0.6, rate: 1.1 })
    // Halfway between frames 0 and 1: right 0.4 > left 0.3 → right gain 0.4, rate 1.2.
    const mid = loopSoundLevel(levels, fps, hand, 0.05)
    expect(mid.gain).toBeCloseTo(0.4); expect(mid.rate).toBeCloseTo(1.2)
    // No rate column → rate 1; outside the recording → silent.
    expect(loopSoundLevel(levels, fps, layer('rub', [0, 1]), 0).rate).toBe(1)
    expect(loopSoundLevel(levels, fps, hand, 5).gain).toBe(0)
    expect(loopSoundLevel(levels, fps, hand, -1).gain).toBe(0)
  })

  it('keeps the rate of the frame that is on next to one that is off (the rate column reads 0 there)', () => {
    // Safety Mill's spindle: [gain, rate] off → on at 0.2 / 0.88 → on → off.
    const fps = 10, spindle = layer('spindle_loop', [0, 0], [1, 1]), levels = [[0, 0], [0.2, 0.88], [1, 1], [0, 0], [0, 0]]
    const rising = loopSoundLevel(levels, fps, spindle, 0.05)
    expect(rising.gain).toBeCloseTo(0.1); expect(rising.rate).toBe(0.88)
    const falling = loopSoundLevel(levels, fps, spindle, 0.25)
    expect(falling.gain).toBeCloseTo(0.5); expect(falling.rate).toBe(1)
    const on = loopSoundLevel(levels, fps, spindle, 0.15)
    expect(on.rate).toBeCloseTo(0.94) // both frames on: interpolated
    expect(loopSoundLevel(levels, fps, spindle, 0.35)).toEqual({ gain: 0, rate: 0 })
  })

  it('starts a looping source when the level rises above 0, glides gain and rate, fades out and stops at 0', () => {
    const ctx = new FakeCtx(), player = new LoopSoundPlayer(), sounds = [{ layer: 3, sound: 'Motor', gain: 0.5 }]
    const buffers = { Motor: buf('Motor') }
    let level = { gain: 0, rate: 1 }
    player.update(audioOf(ctx), sounds, buffers, () => level)
    expect(ctx.sources).toHaveLength(0) // level 0: nothing plays
    level = { gain: 0.8, rate: 0.9 }
    player.update(audioOf(ctx), sounds, buffers, () => level)
    const [src] = ctx.sources, [g] = ctx.gains
    expect(src.buffer).toBe(buffers.Motor); expect(src.loop).toBe(true); expect(src.started).toBe(10)
    expect(src.playbackRate.value).toBe(0.9)
    expect(g.gain.value).toBe(0); expect(g.gain.target).toBeCloseTo(0.8 * 0.5) // fades in from 0 to level × gain
    expect(g.gain.targets[0].tau).toBeCloseTo(LOOP_SOUND_FADE_IN / 3); expect(LOOP_SOUND_FADE_IN).toBeCloseTo(0.08)
    expect(player.active).toEqual([3])
    // The level moves: the same source glides (τ ≈ 30 ms), no restart.
    ctx.currentTime = 10.01; level = { gain: 1, rate: 1 }
    player.update(audioOf(ctx), sounds, buffers, () => level)
    expect(ctx.sources).toHaveLength(1)
    expect(g.gain.targets[g.gain.targets.length - 1]).toEqual({ v: 0.5, at: 10.01, tau: LOOP_SOUND_TAU })
    expect(src.playbackRate.target).toBe(1)
    expect(LOOP_SOUND_TAU).toBeCloseTo(0.03)
    // An unchanged level schedules nothing new.
    const scheduled = g.gain.targets.length
    player.update(audioOf(ctx), sounds, buffers, () => level)
    expect(g.gain.targets.length).toBe(scheduled)
    // Back to 0: fades out over ~200 ms, then stops.
    ctx.currentTime = 11; level = { gain: 0, rate: 0 }
    player.update(audioOf(ctx), sounds, buffers, () => level)
    expect(g.gain.target).toBe(0); expect(g.gain.targets[g.gain.targets.length - 1].tau).toBeCloseTo(LOOP_SOUND_FADE / 6)
    expect(LOOP_SOUND_FADE).toBeCloseTo(0.2); expect(src.stopped).toBeCloseTo(11 + LOOP_SOUND_FADE)
    expect(player.active).toEqual([])
    // Up again: a new source.
    level = { gain: 1, rate: 1 }
    player.update(audioOf(ctx), sounds, buffers, () => level)
    expect(ctx.sources).toHaveLength(2)
  })

  it('stops everything on stopAll (pause, seek, another moment, end), stays silent without a decoded buffer, restarts on another sound', () => {
    const ctx = new FakeCtx(), player = new LoopSoundPlayer(), on = () => ({ gain: 1, rate: 1 })
    const buffers = { BrushLoop: buf('BrushLoop'), Cutting: buf('Cutting'), Other: buf('Other') }
    player.update(audioOf(ctx), [{ layer: 1, sound: 'BrushLoop', gain: 1 }, { layer: 2, sound: 'Cutting', gain: 1 }, { layer: 3, sound: 'Motor', gain: 1 }], buffers, on)
    expect(player.active).toEqual([1, 2]) // Motor is not decoded (yet): silent
    player.stopAll(ctx as unknown as LoopAudio)
    expect(player.active).toEqual([]); expect(ctx.sources.every(s => s.stopped === 10 + LOOP_SOUND_STOP)).toBe(true) // at once, not the 200 ms fade
    // A table edit changes layer 1's sound: the old one stops, the new one starts; a layer that left the list stops.
    player.update(audioOf(ctx), [{ layer: 1, sound: 'BrushLoop', gain: 1 }, { layer: 2, sound: 'Cutting', gain: 1 }], buffers, on)
    const [brush, cut] = ctx.sources.slice(2)
    player.update(audioOf(ctx), [{ layer: 1, sound: 'Other', gain: 1 }], buffers, on)
    expect(brush.stopped).not.toBeNull(); expect(cut.stopped).not.toBeNull()
    expect(ctx.sources[ctx.sources.length - 1].buffer).toBe(buffers.Other); expect(player.active).toEqual([1])
  })

  it('maps the level through the sfx levelMap (DEC-090): buildLoopSounds carries it, the player applies it', () => {
    const map = { points: [[0.5, 2], [1, 1]] as [number, number][] }
    const table = { ...TABLE, cues: { ...TABLE.cues, brush_loop: { sfx: { sound: 'BrushLoop', volume: 1, levelMap: map } } } } as unknown as CueTable
    const sounds = buildLoopSounds(table, MILL)
    expect(sounds[0]).toEqual({ layer: 1, sound: 'BrushLoop', gain: 0.5, levelMap: map })
    const ctx = new FakeCtx(), player = new LoopSoundPlayer(), buffers = { BrushLoop: buf('BrushLoop') }
    player.update(audioOf(ctx), [sounds[0]], buffers, () => ({ gain: 0.25, rate: 1 }))
    expect(ctx.gains[0].gain.target).toBeCloseTo(1 * 0.5) // below the first point: from the origin to it (0.25 → 1), not the input 0.25
    ctx.currentTime = 10.01
    player.update(audioOf(ctx), [sounds[0]], buffers, () => ({ gain: 0.75, rate: 1 }))
    expect(ctx.gains[0].gain.target).toBeCloseTo(1.5 * 0.5) // halfway between the points
  })
})
