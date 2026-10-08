import { describe, expect, it } from 'vitest'
import { auditionContext, contextHapticParts, contextLoopSounds, contextPlan, contextReplayTime, contextSoundFirings, renderContextLoops, unknownContextCues } from './trialContext'
import { mixGroupHaptics } from './groupPlayback'
import { RATE } from './sceneHaptics'
import type { CueTable } from './sceneCueTable'
import type { SceneData, SceneLib } from './sceneData'

// Safety Mill's engage: the cutter's first bite, then cut_loop (a sound-only loop cue) and feed_loop (a haptic layer).
const LIB = {
  loop_cues: ['cut_loop', 'feed_loop'], loop_cue_sounds: true,
  layers: [{ cue: 'feed_loop', gain: [0, 1], rate: null, colors: [] }, { cue: 'cut_loop', gain: [2, 2], rate: null, colors: [] }],
} as unknown as SceneLib
const TABLE = {
  clips: { feed: { intensity: 0.5, loop: true }, chip_h: { intensity: 1 } },
  cues: {
    engage: { sfx: { sound: 'Engage', volume: 1 } },
    chip: { sfx: { sound: 'Chip', volume: 1 }, haptics: [{ clip: 'chip_h', at: 'both', gain: 1 }], variants: { big: {} } },
    cut_loop: { sfx: { sound: 'Cutting', volume: 0.8 } },
    feed_loop: { haptics: [{ clip: 'feed', at: 'hand', gain: 0.5 }] },
  },
} as unknown as CueTable
// 30 fps; feed_loop's right hand at 1 from frame 30 (1 s), cut_loop on from the start.
const levels = Array.from({ length: 120 }, (_, i) => [0, i >= 30 ? 1 : 0, 1])
const DATA = { fps: 30, full: { file: 'full.mp4', levels, events: [
  { t: 0.5, name: 'chip', hand: 'both' }, { t: 1, name: 'engage', hand: 'both' }, { t: 1.2, name: 'chip:big', hand: 'both' },
  { t: 1.3, name: 'cut_loop', hand: 'both' }, { t: 2.5, name: 'chip', hand: 'both' }, { t: 9, name: 'chip', hand: 'both' },
] } } as unknown as SceneData

describe('audition context (scene.context, simultaneous groups)', () => {
  it('names the context cues the open project does not know', () => {
    expect(unknownContextCues(TABLE, ['cut_loop', 'chip:big', 'feed_loop'])).toEqual([])
    expect(unknownContextCues(TABLE, ['cutloop', 'chip:huge'])).toEqual(['cutloop', 'chip:huge'])
  })

  it('plays one-shot context firings from the mark to the stretch end, loop cues as layers', () => {
    const plan = contextPlan(DATA, LIB, ['chip', 'cut_loop', 'feed_loop'], 1, 3)
    // Not the chip in the lead-in (0.5 s) nor the one after the stretch (9 s); a bare cue takes its variants; cut_loop's logged firing is a layer.
    expect(plan.firings.map(f => [Number(f.atSec.toFixed(3)), f.name])).toEqual([[0.2, 'chip:big'], [1.5, 'chip']])
    expect(plan.layers).toEqual([0, 1])
    expect(plan.mark).toBe(1)
    expect(plan.endSec).toBe(2)
  })

  it('a variant entry plays that variant only', () => {
    expect(contextPlan(DATA, LIB, ['chip:big'], 0, 3).firings.map(f => f.name)).toEqual(['chip:big'])
  })

  it('renders the loop layers at their recorded level (one voice per route, the louder hand)', () => {
    const pcm = { feed: new Float32Array([1, 1, 1, 1]) }
    const out = renderContextLoops(TABLE, LIB, DATA, { layers: [0], mark: 0.5 }, pcm, 1)!
    expect(out.length).toBe(RATE)
    // Before 1 s of the replay (0.5 s of the playback) the layer is off; after it, clip × level 1 × intensity 0.5 (no route gain, like the one-shots).
    expect(out[Math.round(0.2 * RATE)]).toBe(0)
    expect(out[Math.round(0.8 * RATE)]).toBeCloseTo(0.5)
    // A sound-only loop cue has no haptic.
    expect(renderContextLoops(TABLE, LIB, DATA, { layers: [1], mark: 0 }, pcm, 1)).toBeNull()
  })

  it('an audition plays the trial context and the target group, never the family of the targets; nothing with the toggle off', () => {
    const o = { own: ['cut_loop'], groups: [['engage', 'chip', 'feed_loop']], targets: ['engage'], on: true, data: DATA, lib: LIB, mark: 1, end: 3 }
    const on = auditionContext(o)
    expect(on.contextCues).toEqual(['cut_loop', 'chip', 'feed_loop'])
    expect(on.context?.layers).toEqual([0, 1])
    expect(on.context?.firings.map(f => f.name)).toEqual(['chip:big', 'chip'])
    const off = auditionContext({ ...o, on: false })
    expect(off).toEqual({ contextCues: ['cut_loop', 'chip', 'feed_loop'], context: null })
    // A cue of the targets' family (engage:x for engage) is left out; nothing named = no context.
    expect(auditionContext({ ...o, own: ['engage:late'], groups: [] })).toEqual({ contextCues: [], context: null })
    // An event in no group, without a trial context.
    expect(auditionContext({ ...o, own: [], targets: ['chip'], groups: [['engage', 'cut_loop']] }).context).toBeNull()
  })

  it('schedules the decided sounds and haptics, and the loop sounds at the recorded levels', () => {
    const plan = contextPlan(DATA, LIB, ['chip', 'cut_loop'], 1, 3)
    expect(contextSoundFirings(TABLE, plan).map(f => [f.sound, Number(f.atSec.toFixed(3))])).toEqual([['Chip', 0.2], ['Chip', 1.5]])
    expect(contextHapticParts(TABLE, plan).map(p => [p.clip, Number(p.atSec.toFixed(3)), p.gain])).toEqual([['chip_h', 0.2, 1], ['chip_h', 1.5, 1]])
    // cut_loop's sound (sfx.volume × intensity 1); feed_loop has none.
    expect(contextLoopSounds(TABLE, { ...LIB, loop_cue_sounds: true } as SceneLib, { layers: [0, 1] })).toEqual([{ layer: 1, sound: 'Cutting', gain: 1 }])  // the sound's intensity only (sfx.volume 0.8 not applied)
    expect(contextLoopSounds(TABLE, LIB, { layers: [0] })).toEqual([])
    // Playback 0.5 s with the PC sounds 0.1 s late: the levels of replay time 1.4 s.
    expect(contextReplayTime(plan, 0.5, 0.1)).toBeCloseTo(1.4)
  })

  it('adds the rendered loops to the device stream', () => {
    const loops = new Float32Array(RATE).fill(0.25)
    const out = mixGroupHaptics(null, [], {}, 1, loops)
    expect(out[100]).toBeCloseTo(0.25)
  })

  it('a candidate over a context loop: the stream is their sum while the candidate plays (no ducking, no gap)', () => {
    // feed_loop rendered over 2 s (a ramp like the recorded layer level), the candidate (strength 0.4) at 0.5–1.0 s.
    const loops = Float32Array.from({ length: 2 * RATE }, (_, i) => 0.1 + 0.3 * i / (2 * RATE))
    const candidate = new Float32Array(2 * RATE)
    for (let i = Math.round(0.5 * RATE); i < RATE; i++) candidate[i] = i % 2 ? 0.6 : -0.6
    const out = mixGroupHaptics({ data: candidate, rate: RATE, gain: 0.4 }, [], {}, 2, loops)
    for (let i = 0; i < out.length; i += 37) expect(out[i]).toBeCloseTo(loops[i] + candidate[i] * 0.4, 6)
    // Clipped to ±1 only at the end of the sum.
    const loud = mixGroupHaptics({ data: new Float32Array(RATE).fill(0.9), rate: RATE }, [], {}, 1, new Float32Array(RATE).fill(0.5))
    expect(loud[10]).toBe(1)
  })
})
