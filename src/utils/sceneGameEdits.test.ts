import { describe, expect, it } from 'vitest'
import { boundedRatio, changeTargets, gainTarget, parseTargetKey, scaledValues, targetKey, targetsOf, targetValues, valuesAt } from './sceneGameEdits'
import { parseViewerLib } from './sceneData'
import { sampleTable, sampleViewerLibFile } from './sceneTestFixtures'
import { CONTRACT_SCENE_RECORDING } from './sceneContractFixtures'
import type { CueTable } from './sceneCueTable'

/** A T-Rex-like table: footstep with two routes, a variant sharing them (subtle) and one with its own (heavy). */
function table(): CueTable {
  const t = sampleTable()
  t.cues.footstep = {
    sfx: { sound: 'Click', volume: 0.6 },
    haptics: [{ clip: 'click', at: 'pos_neck', gain: 0.8 }, { clip: 'thump', at: 'hand', gain: 0.4 }],
    variants: { subtle: { hapticsGain: 0.5, sfxVolume: 0.5 }, heavy: { haptics: [{ clip: 'thump', at: 'pos_neck', gain: 1.5 }], sfx: { sound: 'Click', volume: 1 } } },
  }
  return t
}
const text = (v: unknown) => JSON.stringify(v)

describe('the project kind (scene-recording section 3.1, DEC-114)', () => {
  it('absent = game, video, anything else refused', () => {
    expect(parseViewerLib(text(sampleViewerLibFile('game'))).kind).toBe('game')
    expect(parseViewerLib(text(sampleViewerLibFile('video'))).kind).toBe('video')
    expect(() => parseViewerLib(text({ ...sampleViewerLibFile(), kind: 'movie' }))).toThrow(/kind/)
    expect(parseViewerLib(text(CONTRACT_SCENE_RECORDING.viewer_lib_minimal)).kind).toBe('game')
    expect(parseViewerLib(text(CONTRACT_SCENE_RECORDING.viewer_lib_layers)).kind).toBe('game')
    expect(parseViewerLib(text(CONTRACT_SCENE_RECORDING.viewer_lib_video)).kind).toBe('video')
  })
})

describe('which multiplier a bar moves (gainTarget)', () => {
  it('haptics: a cue / a variant with its own haptics → its routes; a sharing variant → its hapticsGain', () => {
    const t = table()
    expect(gainTarget(t, 'footstep', 'haptics')).toEqual({ kind: 'routes', ref: { cue: 'footstep', variant: null } })
    expect(gainTarget(t, 'footstep:subtle', 'haptics')).toEqual({ kind: 'hapticsGain', ref: { cue: 'footstep', variant: 'subtle' } })
    expect(gainTarget(t, 'footstep:heavy', 'haptics')).toEqual({ kind: 'routes', ref: { cue: 'footstep', variant: 'heavy' } })
    // A variant the cue does not have plays the cue (as the game does).
    expect(gainTarget(t, 'footstep:nope', 'haptics')).toEqual({ kind: 'routes', ref: { cue: 'footstep', variant: null } })
    // A loop cue (strength from the game's input), no haptics, an unknown cue: none.
    expect(gainTarget(t, 'feed_loop', 'haptics')).toBeNull()
    expect(gainTarget(t, 'grab', 'haptics')).toBeNull()
    expect(gainTarget(t, 'nothing', 'haptics')).toBeNull()
  })
  it('sound: sfx.volume of a cue / a variant with its own sound; a sharing variant → its sfxVolume', () => {
    const t = table()
    expect(gainTarget(t, 'footstep', 'sound')).toEqual({ kind: 'sfx', ref: { cue: 'footstep', variant: null } })
    expect(gainTarget(t, 'footstep:subtle', 'sound')).toEqual({ kind: 'sfxVolume', ref: { cue: 'footstep', variant: 'subtle' } })
    expect(gainTarget(t, 'footstep:heavy', 'sound')).toEqual({ kind: 'sfx', ref: { cue: 'footstep', variant: 'heavy' } })
    expect(gainTarget(t, 'grab', 'sound')).toBeNull()
  })
  it('keys go both ways; each multiplier once in a selection', () => {
    const t = table(), target = gainTarget(t, 'footstep:subtle', 'haptics')!
    expect(parseTargetKey(targetKey(target))).toEqual(target)
    expect(targetsOf(t, ['footstep', 'footstep', 'footstep:nope', 'footstep:subtle'], 'haptics').map(targetKey)).toEqual(['routes:footstep', 'hapticsGain:footstep:subtle'])
  })
})

describe('scaling a multiplier', () => {
  it('a ratio past the top stops there, keeping the routes\' proportions; a value above 0 never reaches 0', () => {
    expect(boundedRatio([0.8, 0.4], 2)).toBe(2)
    expect(boundedRatio([0.8, 0.4], 4)).toBe(2.5)
    expect(scaledValues([0.8, 0.4], 4)).toEqual([2, 1])
    expect(scaledValues([0.8, 0.4], 0.5)).toEqual([0.4, 0.2])
    expect(scaledValues([0.002], 0.0001)).toEqual([0.001])
    expect(scaledValues([0], 3)).toEqual([0])
    expect(valuesAt([0.8, 0.4], 1.2)).toEqual([1.2, 0.6])
    expect(valuesAt([0, 0], 0.7)).toEqual([0.7, 0.7])
    expect(valuesAt([1], 5)).toEqual([2])
  })
  it('footstep:subtle changes only its hapticsGain; footstep its routes; each once', () => {
    const t = table()
    const subtle = changeTargets(t, targetsOf(t, ['footstep:subtle'], 'haptics'), v => scaledValues(v, 2))
    expect(subtle.table.cues.footstep.variants!.subtle.hapticsGain).toBe(1)
    expect(subtle.table.cues.footstep.haptics!.map(r => r.gain)).toEqual([0.8, 0.4])
    expect(subtle.changes).toEqual([{ key: 'hapticsGain:footstep:subtle', before: [0.5], after: [1] }])
    const cue = changeTargets(t, targetsOf(t, ['footstep', 'footstep:nope'], 'haptics'), v => scaledValues(v, 2))
    expect(cue.table.cues.footstep.haptics!.map(r => r.gain)).toEqual([1.6, 0.8])
    expect(cue.table.cues.footstep.variants!.subtle.hapticsGain).toBe(0.5)
    expect(cue.table.cues.footstep.variants!.heavy.haptics![0].gain).toBe(1.5)
    // The input table is not changed; nothing changed gives it back.
    expect(t.cues.footstep.haptics![0].gain).toBe(0.8)
    expect(changeTargets(t, targetsOf(t, ['footstep'], 'haptics'), v => v).table).toBe(t)
  })
  it('sound: sfx.volume and sfxVolume, 0..2', () => {
    const t = table()
    const out = changeTargets(t, targetsOf(t, ['footstep', 'footstep:subtle'], 'sound'), v => scaledValues(v, 4)).table
    expect(out.cues.footstep.sfx!.volume).toBe(2)
    expect(out.cues.footstep.variants!.subtle.sfxVolume).toBe(2)
    expect(targetValues(out, { kind: 'sfxVolume', ref: { cue: 'footstep', variant: 'heavy' } })).toBeNull()
  })
})
