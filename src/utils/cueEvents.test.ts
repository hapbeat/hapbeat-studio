import { describe, expect, it } from 'vitest'
import {
  addEventMark, addOwnRoute, addVariant, allEventKeys, applyHapticDecision, applySoundDecision, defaultAt, defaultClipName, defaultSoundName,
  effectiveEvent, eventSceneCues, jitterGain, listEvents, MaterialPicker, matchesName, materialUsers, needsRouteForm, overwriteUsers,
  parseEventKey, removeVariant, resolveEventName, setOverride, setRouteClips, setSfxSounds, setVariation, trialEvent, trialsForEvent,
} from './cueEvents'
import { validateCueTable, type CueTable, type CueTableContext } from './sceneCueTable'
import { cueVoices, tableTargets } from './sceneHaptics'
import { sampleLib, sampleTable } from './sceneTestFixtures'

const ctx = (patch: Partial<CueTableContext> = {}): CueTableContext => ({
  lib: sampleLib(), kit: 'mill-kit', cueNames: ['button', 'grab', 'detent', 'feed_loop'],
  clipFiles: new Set(['click', 'thump', 'hum']), soundFiles: new Set(['Click', 'Clack']), ...patch,
})

/** sampleTable + v2: button has a "soft" variant (own sfx + haptics) and an inheriting "plain" one. */
function v2Table(): CueTable {
  const t = sampleTable()
  t.cues.button.variation = { gainJitterDb: 2, pick: 'roundRobin' }
  t.cues.button.variants = {
    soft: { description: 'softer press', sfx: { sound: 'Click', volume: 0.3 }, haptics: [{ clips: ['click', 'thump'], at: 'pos_neck', gain: 0.4 }] },
    plain: {},
  }
  return t
}

describe('cue table v2 validation', () => {
  it('accepts variants, variation and multi-material fields', () => {
    const t = v2Table()
    t.cues.grab.sfx = { sounds: ['Click', 'Clack'], volume: 1 }
    expect(validateCueTable(t, ctx())).toEqual([])
  })

  it('reports bad variants, variation and clip / sound lists', () => {
    const t = v2Table()
    t.cues.button.variants!['Bad-Name'] = {}
    t.cues.button.variants!.soft.haptics = [{ clip: 'click', clips: ['thump'], at: 'hand', gain: 1 }, { clips: [], at: 'hand', gain: 1 }, { clips: ['hum'], at: 'hand', gain: 1 }]
    t.cues.button.variants!.soft.sfx = { sound: 'Click', sounds: ['Clack'], volume: 1 }
    t.cues.button.variants!.plain.variation = { gainJitterDb: 13, rateJitterPct: 60, pick: 'shuffle' as never }
    t.cues.grab.sfx = { sounds: ['Missing'], volume: 1 }
    t.cues.feed_loop.variants = { slow: { sfx: { sound: 'Click', volume: 1 } } }
    expect(validateCueTable(t, ctx())).toEqual(expect.arrayContaining([
      'button: variant name Bad-Name must match ^[a-z][a-z0-9_]*$',
      'button:soft: a route needs exactly one of clip / clips',
      'button:soft: route clips must be a non-empty list',
      'button:soft: clip hum loop=true does not fit this cue',
      'button:soft: sfx needs exactly one of sound / sounds',
      'button:plain: variation.gainJitterDb must be 0..12',
      'button:plain: variation.rateJitterPct must be 0..50',
      'button:plain: variation.pick must be random or roundRobin',
      'grab: Content/Audio/Missing.wav missing',
      'feed_loop:slow: continuous layers have no cue sound',
    ]))
  })

  it('allows only-gain-relevant variation fields on loop cues without error (they are ignored)', () => {
    const t = sampleTable()
    t.cues.feed_loop.variation = { gainJitterDb: 3, pitchJitterSt: 2 }
    expect(validateCueTable(t, ctx())).toEqual([])
  })
})

describe('events and effective resolution', () => {
  it('resolves cue:variant names like the game', () => {
    const t = v2Table()
    expect(resolveEventName(t, 'button:soft')).toEqual({ ref: { cue: 'button', variant: 'soft' }, unknownVariant: null })
    expect(resolveEventName(t, 'button:loud')).toEqual({ ref: { cue: 'button', variant: null }, unknownVariant: 'loud' })
    expect(resolveEventName(t, 'nope')).toBeNull()
    expect(parseEventKey('a:b')).toEqual({ cue: 'a', variant: 'b' })
  })

  it('inherits what a variant does not write', () => {
    const t = v2Table()
    const soft = effectiveEvent(t, { cue: 'button', variant: 'soft' })!
    expect(soft.sfx).toEqual({ sound: 'Click', volume: 0.3 })
    expect(soft.variation).toEqual({ gainJitterDb: 2, pick: 'roundRobin' })
    expect(soft.own).toEqual({ sfx: true, haptics: true, variation: false })
    const plain = effectiveEvent(t, { cue: 'button', variant: 'plain' })!
    expect(plain.haptics).toEqual(t.cues.button.haptics)
    expect(plain.description).toBe('press')
    // An explicit null sfx overrides with "no sound".
    t.cues.button.variants!.plain.sfx = null
    expect(effectiveEvent(t, { cue: 'button', variant: 'plain' })!.sfx).toBeNull()
  })

  it('lists cues with nested variants and their status', () => {
    const rows = listEvents(v2Table(), sampleLib())
    expect(rows.map(r => [r.key, r.sound, r.haptic])).toEqual([['button', 'set', 'set'], ['grab', 'unset', 'unset'], ['detent', 'unset', 'set'], ['feed_loop', 'na', 'set']])
    expect(rows[0].variants.map(v => v.key)).toEqual(['button:soft', 'button:plain'])
    expect(allEventKeys(v2Table())).toEqual(['button', 'button:soft', 'button:plain', 'grab', 'detent', 'feed_loop'])
    expect(eventSceneCues(v2Table(), 'button')).toEqual(['button', 'button:soft', 'button:plain'])
    expect(eventSceneCues(v2Table(), 'button:soft')).toEqual(['button:soft'])
  })

  it('plays variant routes in the Scene tab and covers their targets', () => {
    const pcm = { click: new Float32Array(4).fill(0.5), thump: new Float32Array(4).fill(0.5) }
    const t = v2Table()
    const v = cueVoices(t, pcm, { name: 'button:soft', hand: 'right' }, 0, { picker: new MaterialPicker(() => 0), jitter: 0.5 })
    expect(v).toHaveLength(1)
    expect(v[0].targets).toEqual(['*/pos_neck'])
    expect(v[0].gain).toBeCloseTo(1.0 * 0.4 * 0.5) // roundRobin starts with click (intensity 1)
    expect(cueVoices(t, pcm, { name: 'button:loud', hand: 'right' }, 0)[0].targets).toEqual(['*/pos_r_wrist'])
    expect(tableTargets(t)).toContain('*/pos_neck')
  })
})

describe('decide', () => {
  it('names default to the current material, else the cue name', () => {
    const t = v2Table()
    expect(defaultClipName(t, { cue: 'button', variant: null })).toBe('click')
    expect(defaultClipName(t, { cue: 'grab', variant: null })).toBe('grab')
    expect(defaultSoundName(t, { cue: 'grab', variant: null })).toBe('Grab')
    expect(defaultSoundName(t, { cue: 'feed_loop', variant: 'slow' })).toBe('FeedLoopSlow')
    expect(defaultSoundName(t, { cue: 'button', variant: 'soft' })).toBe('Click')
    expect(matchesName('grab', sampleLib().clip_name)).toBe(true)
    expect(matchesName('Grab', sampleLib().clip_name)).toBe(false)
  })

  it('lists the other events that use a WAV before it is overwritten', () => {
    const t = v2Table()
    expect(materialUsers(t, 'clip', 'click')).toEqual(['button', 'button:soft'])
    expect(overwriteUsers(t, 'clip', 'click', { cue: 'button', variant: null })).toEqual(['button:soft'])
    expect(overwriteUsers(t, 'sound', 'Click', { cue: 'grab', variant: null })).toEqual(['button', 'button:soft'])
    expect(overwriteUsers(t, 'clip', 'fresh', { cue: 'grab', variant: null })).toEqual([])
  })

  it('haptic: replaces the first route clip keeping at / gain, or adds a route; adds the clip entry', () => {
    const lib = sampleLib()
    const kept = applyHapticDecision(v2Table(), lib, { ref: { cue: 'button', variant: 'soft' }, clip: 'press2', at: 'hand', gain: 1 })
    expect(kept.cues.button.variants!.soft.haptics).toEqual([{ clip: 'press2', at: 'pos_neck', gain: 0.4 }])
    expect(kept.clips.press2).toMatchObject({ intensity: 1, loop: false })
    const added = applyHapticDecision(v2Table(), lib, { ref: { cue: 'grab', variant: null }, clip: 'thump', at: 'pos_chest', gain: 0.7 })
    expect(added.cues.grab.haptics).toEqual([{ clip: 'thump', at: 'pos_chest', gain: 0.7 }])
    expect(added.clips.thump.intensity).toBe(0.5) // an existing entry keeps its intensity
    // An inheriting variant gets its own copy; the cue is untouched.
    const own = applyHapticDecision(v2Table(), lib, { ref: { cue: 'button', variant: 'plain' }, clip: 'thump', at: 'hand', gain: 1 })
    expect(own.cues.button.variants!.plain.haptics).toEqual([{ clip: 'thump', at: 'hand', gain: 1 }])
    expect(own.cues.button.haptics[0].clip).toBe('click')
    expect(needsRouteForm(v2Table(), { cue: 'grab', variant: null })).toBe(true)
    expect(needsRouteForm(v2Table(), { cue: 'button', variant: 'plain' })).toBe(false)
    const table = applyHapticDecision(v2Table(), lib, { ref: { cue: 'grab', variant: null }, clip: 'grab', at: 'hand', gain: 1 })
    expect(validateCueTable(table, ctx({ clipFiles: new Set(['click', 'thump', 'hum', 'grab']) }))).toEqual([])
  })

  it('sound: sets one sound keeping the volume (1.0 when new)', () => {
    expect(applySoundDecision(v2Table(), { cue: 'button', variant: null }, 'Clack').cues.button.sfx).toEqual({ sound: 'Clack', volume: 0.6 })
    expect(applySoundDecision(v2Table(), { cue: 'grab', variant: null }, 'Clack').cues.grab.sfx).toEqual({ sound: 'Clack', volume: 1 })
    const t = v2Table()
    t.cues.grab.sfx = { sounds: ['Click', 'Clack'], volume: 0.8 }
    expect(applySoundDecision(t, { cue: 'grab', variant: null }, 'Click').cues.grab.sfx).toEqual({ sound: 'Click', volume: 0.8 })
  })

  it('default position: the acting hand where the project has it', () => {
    expect(defaultAt(sampleLib(), 'button')).toBe('hand')
    expect(defaultAt({ ...sampleLib(), at: ['pos_neck', 'pos_chest'] }, 'button')).toBe('pos_neck')
  })
})

describe('events panel edits', () => {
  it('adds / removes variants and overrides fields', () => {
    let t = addVariant(sampleTable(), 'grab', 'reach')
    expect(t.cues.grab.variants).toEqual({ reach: {} })
    expect(() => addVariant(t, 'grab', 'reach')).toThrow(/already exists/)
    expect(() => addVariant(t, 'grab', 'Reach')).toThrow(/must match/)
    t = setOverride(t, { cue: 'grab', variant: 'reach' }, 'haptics', true)
    expect(t.cues.grab.variants!.reach.haptics).toEqual([])
    t = addOwnRoute(t, sampleLib(), { cue: 'grab', variant: 'reach' })!
    expect(t.cues.grab.variants!.reach.haptics).toEqual([{ clip: 'click', at: 'hand', gain: 1 }])
    expect(t.cues.grab.haptics).toEqual([])
    t = setOverride(t, { cue: 'grab', variant: 'reach' }, 'haptics', false)
    expect(t.cues.grab.variants!.reach).toEqual({})
    expect(removeVariant(t, 'grab', 'reach').cues.grab.variants).toBeUndefined()
  })

  it('edits multi-material lists and variation', () => {
    const ref = { cue: 'button', variant: null }
    let t = setRouteClips(sampleTable(), ref, 0, ['click', 'thump'])
    expect(t.cues.button.haptics[0]).toEqual({ clips: ['click', 'thump'], at: 'hand', gain: 1 })
    t = setRouteClips(t, ref, 0, ['thump'])
    expect(t.cues.button.haptics[0]).toEqual({ clip: 'thump', at: 'hand', gain: 1 })
    t = setSfxSounds(t, ref, ['Click', 'Clack'])
    expect(t.cues.button.sfx).toEqual({ sounds: ['Click', 'Clack'], volume: 0.6 })
    expect(setSfxSounds(t, ref, []).cues.button.sfx).toBeNull()
    t = setVariation(t, ref, { gainJitterDb: 3 })
    expect(t.cues.button.variation).toEqual({ gainJitterDb: 3 })
    expect(setVariation(t, ref, { gainJitterDb: undefined }).cues.button.variation).toBeUndefined()
    expect(validateCueTable(t, ctx())).toEqual([])
  })
})

describe('playback picks and links', () => {
  it('random never repeats the previous pick; round robin cycles', () => {
    const seq = [0.99, 0.99, 0, 0]
    const random = new MaterialPicker(() => seq.shift() ?? 0)
    const picks = [random.pick('k', ['a', 'b', 'c']), random.pick('k', ['a', 'b', 'c']), random.pick('k', ['a', 'b', 'c']), random.pick('k', ['a', 'b', 'c'])]
    for (let i = 1; i < picks.length; i++) expect(picks[i]).not.toBe(picks[i - 1])
    const rr = new MaterialPicker()
    expect([0, 1, 2, 3].map(() => rr.pick('k', ['a', 'b', 'c'], 'roundRobin'))).toEqual(['a', 'b', 'c', 'a'])
    expect(rr.pick('one', ['x'])).toBe('x')
    expect(jitterGain(undefined)).toBe(1)
    expect(jitterGain(6, () => 1)).toBeCloseTo(10 ** (6 / 20))
    expect(jitterGain(6, () => 0)).toBeCloseTo(10 ** (-6 / 20))
  })

  it('links AI trials and clip marks to events', () => {
    const trials = [
      { trial: { id: 's1', target: 'sound' as const, scene: { project: 'mill', cues: ['button'] } } },
      { trial: { id: 'h1', scene: { project: 'mill', cues: ['button', 'grab'] } } },
      { trial: { id: 'v1', scene: { project: 'mill', cues: ['button:soft'] } } },
      { trial: { id: 'o1', scene: { project: 'other', cues: ['button'] } } },
    ]
    const linked = trialsForEvent(trials, 'mill', 'button')
    expect(linked.sound.map(r => r.trial.id)).toEqual(['s1'])
    expect(linked.haptic.map(r => r.trial.id)).toEqual(['h1'])
    expect(trialsForEvent(trials, 'mill', 'button:soft').haptic.map(r => r.trial.id)).toEqual(['v1'])
    expect(trialEvent(v2Table(), { cues: ['nope', 'button:soft'] })).toBe('button:soft')
    expect(trialEvent(v2Table(), { cues: ['button:loud'] })).toBeNull()
    const mark = { project: 'mill', event: 'button', target: 'haptic' as const }
    const marks = addEventMark(addEventMark({}, 'c1', mark), 'c1', { ...mark, target: 'sound' })
    expect(addEventMark(marks, 'c1', mark).c1.map(m => m.target)).toEqual(['sound', 'haptic'])
  })
})
