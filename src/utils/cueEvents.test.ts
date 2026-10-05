import { describe, expect, it } from 'vitest'
import {
  addEventMark, addPositionRoute, fireShot, resetAllReviews, setNone, setReview, setUndecided, addVariant, simultaneousGroups, allEventKeys, applyHapticDecision, applySoundDecision, defaultAt, wavBaseName, safeWavName, nextWavName, assignEventsForTrial,
  effectiveEvent, eventSceneCues, jitterGain, listEvents, MaterialPicker, matchesName, materialUsers, needsRouteForm, overwriteUsers,
  parseEventKey, removeVariant, representativeSound, resolveEventName, cueRoutePositions, materialRoutePositions, setOverride, setRouteClips, setSfxSounds, setVariation, trialEvent, trialsForEvent,
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
    const st = (x: unknown) => typeof x === 'string' ? x : `${(x as { state: string }).state}/${(x as { review: string }).review}`
    expect(rows.map(r => [r.key, st(r.sound), st(r.haptic)])).toEqual([['button', 'set/tentative', 'set/tentative'], ['grab', 'none/tentative', 'none/tentative'], ['detent', 'none/tentative', 'set/tentative'], ['feed_loop', 'na', 'set/tentative']])
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
  it('names a WAV after its source, safely, else after the event', () => {
    const pat = sampleLib().clip_name, snd = sampleLib().sound_name
    expect(safeWavName('Hit Low (v2).wav', 'clip', pat)).toBe('hit_low_v2')
    expect(safeWavName('sources/rain.wav', 'clip', pat)).toBe('rain')
    expect(safeWavName('どしん', 'clip', pat)).toBe('')
    expect(safeWavName('Roar Impact', 'sound', snd)).toBe('Roar_Impact')
    expect(wavBaseName(['どしん', undefined, 'sources/thud-1.wav'], 'clip', pat, { cue: 'grab', variant: null })).toBe('thud-1')
    expect(wavBaseName(['どしん'], 'clip', pat, { cue: 'grab', variant: 'reach' })).toBe('grab_reach')
    expect(wavBaseName([], 'sound', snd, { cue: 'roar_impact', variant: null })).toBe('RoarImpact')
    expect(matchesName('grab', pat)).toBe(true)
    expect(matchesName('Grab', pat)).toBe(false)
  })

  it('numbers a name only when the file differs, and reuses identical files', async () => {
    const a = new Uint8Array([1, 2, 3]).buffer, b = new Uint8Array([9]).buffer
    const disk: Record<string, ArrayBuffer> = { thud: b, thud_2: a }
    const existing = async (n: string) => disk[n] ?? null
    expect(await nextWavName('thud', a, existing)).toEqual({ name: 'thud_2', same: true })
    expect(await nextWavName('thud', new Uint8Array([7]).buffer, existing)).toEqual({ name: 'thud_3', same: false })
    expect(await nextWavName('fresh', a, existing)).toEqual({ name: 'fresh', same: false })
    expect(await nextWavName('fresh', a, existing, n => n === 'fresh')).toEqual({ name: 'fresh_2', same: false })
  })

  it('assigns a rated trial to the cue, or to each listed variant when the cue is not listed', () => {
    const t = v2Table(), lib = sampleLib()
    expect(assignEventsForTrial(t, lib, ['button', 'button:soft', 'grab'], 'haptic')).toEqual(['button', 'grab'])
    expect(assignEventsForTrial(t, lib, ['button:soft', 'button:plain', 'nope', 'button:loud'], 'haptic')).toEqual(['button:soft', 'button:plain'])
    expect(assignEventsForTrial(t, lib, ['feed_loop', 'grab'], 'sound')).toEqual(['grab'])
    // A loop cue's sound (rub in the T-Rex project) is assigned where the project plays loop-cue sounds.
    const loopSounds = { ...lib, loop_cue_sounds: true }
    expect(assignEventsForTrial(t, loopSounds, ['feed_loop'], 'sound')).toEqual(['feed_loop'])
    const saved = applySoundDecision(t, { cue: 'feed_loop', variant: null }, 'Motor_rub')
    expect(saved.cues.feed_loop.sfx).toEqual({ sound: 'Motor_rub', volume: 1 })
  })

  it('lists the other events that use a WAV before it is overwritten', () => {
    const t = v2Table()
    expect(materialUsers(t, 'clip', 'click')).toEqual(['button', 'button:soft'])
    expect(overwriteUsers(t, 'clip', 'click', ['button'])).toEqual(['button:soft'])
    expect(overwriteUsers(t, 'sound', 'Click', ['grab'])).toEqual(['button', 'button:soft'])
    expect(overwriteUsers(t, 'clip', 'fresh', ['grab'])).toEqual([])
  })

  it('haptic: adds to the first route candidates keeping at / gain (no duplicates), or adds a route; adds the clip entry', () => {
    const lib = sampleLib()
    const kept = applyHapticDecision(v2Table(), lib, { ref: { cue: 'button', variant: 'soft' }, clip: 'press2', at: 'hand', gain: 1 })
    expect(kept.cues.button.variants!.soft.haptics).toEqual([{ clips: ['click', 'thump', 'press2'], at: 'pos_neck', gain: 0.4 }])
    const again = applyHapticDecision(kept, lib, { ref: { cue: 'button', variant: 'soft' }, clip: 'thump', at: 'hand', gain: 1 })
    expect(again.cues.button.variants!.soft.haptics![0].clips).toEqual(['click', 'thump', 'press2'])
    expect(kept.clips.press2).toMatchObject({ intensity: 1, loop: false })
    const added = applyHapticDecision(v2Table(), lib, { ref: { cue: 'grab', variant: null }, clip: 'thump', at: 'pos_chest', gain: 0.7 })
    expect(added.cues.grab.haptics).toEqual([{ clip: 'thump', at: 'pos_chest', gain: 0.7 }])
    expect(added.clips.thump.intensity).toBe(0.5) // an existing entry keeps its intensity
    // An inheriting variant gets its own copy; the cue is untouched.
    const own = applyHapticDecision(v2Table(), lib, { ref: { cue: 'button', variant: 'plain' }, clip: 'thump', at: 'hand', gain: 1 })
    expect(own.cues.button.variants!.plain.haptics).toEqual([{ clips: ['click', 'thump'], at: 'hand', gain: 1 }])
    expect(own.cues.button.haptics![0].clip).toBe('click')
    expect(needsRouteForm(v2Table(), { cue: 'grab', variant: null })).toBe(true)
    expect(needsRouteForm(v2Table(), { cue: 'button', variant: 'plain' })).toBe(false)
    const table = applyHapticDecision(v2Table(), lib, { ref: { cue: 'grab', variant: null }, clip: 'grab', at: 'hand', gain: 1 })
    expect(validateCueTable(table, ctx({ clipFiles: new Set(['click', 'thump', 'hum', 'grab']) }))).toEqual([])
  })

  it('sound: adds to the candidate list (first = representative, no duplicates), keeping the volume (1.0 when new)', () => {
    const button = v2Table().cues.button.sfx!
    expect(applySoundDecision(v2Table(), { cue: 'button', variant: null }, 'Clack').cues.button.sfx).toEqual({ sounds: [...button.sound ? [button.sound] : button.sounds!, 'Clack'], volume: button.volume })
    expect(applySoundDecision(v2Table(), { cue: 'grab', variant: null }, 'Clack').cues.grab.sfx).toEqual({ sound: 'Clack', volume: 1 })
    const t = v2Table()
    t.cues.grab.sfx = { sounds: ['Click', 'Clack'], volume: 0.8 }
    expect(applySoundDecision(t, { cue: 'grab', variant: null }, 'Click').cues.grab.sfx).toEqual({ sounds: ['Click', 'Clack'], volume: 0.8 })
    t.cues.grab.sfx = { sound: 'Click', volume: 0.8 }
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
    t = addPositionRoute(t, sampleLib(), { cue: 'grab', variant: 'reach' })!
    expect(t.cues.grab.variants!.reach.haptics).toEqual([{ clip: 'click', at: 'hand', gain: 1 }])
    // "+ add position": same clip and gain, next unused position.
    t = addPositionRoute(t, sampleLib(), { cue: 'grab', variant: 'reach' })!
    expect(t.cues.grab.variants!.reach.haptics![1]).toEqual({ clip: 'click', at: 'both', gain: 1 })
    expect(t.cues.grab.haptics).toEqual([])
    t = setOverride(t, { cue: 'grab', variant: 'reach' }, 'haptics', false)
    expect(t.cues.grab.variants!.reach).toEqual({})
    expect(removeVariant(t, 'grab', 'reach').cues.grab.variants).toBeUndefined()
  })

  it('edits multi-material lists and variation', () => {
    const ref = { cue: 'button', variant: null }
    let t = setRouteClips(sampleTable(), ref, 0, ['click', 'thump'])
    expect(t.cues.button.haptics![0]).toEqual({ clips: ['click', 'thump'], at: 'hand', gain: 1 })
    t = setRouteClips(t, ref, 0, ['thump'])
    expect(t.cues.button.haptics![0]).toEqual({ clip: 'thump', at: 'hand', gain: 1 })
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

describe('recording: simultaneous groups', () => {
  it('groups cues of the same moment', () => {
    const t = v2Table()
    const moments = [{ names: ['button', 'grab'] }, { names: ['detent', 'grab'] }, { names: ['feed_loop'] }, { names: ['button:soft', 'nope'] }]
    // detent is a tick: left out; grab joins button.
    expect(simultaneousGroups(t, moments, ['detent'])).toEqual([['button', 'grab']])
    expect(simultaneousGroups(t, moments, [])).toEqual([['button', 'grab', 'detent']])
  })
})

describe('review (tentative / approved)', () => {
  it('decisions are tentative; approve / back per field; variants inheriting write to the cue; reset all', () => {
    const lib = sampleLib()
    let t = applySoundDecision(v2Table(), { cue: 'grab', variant: null }, 'Clack')
    t = applyHapticDecision(t, lib, { ref: { cue: 'grab', variant: null }, clip: 'thump', at: 'hand', gain: 1 })
    expect(t.cues.grab.review).toEqual({ sfx: 'tentative', haptics: 'tentative' })
    t = setReview(t, { cue: 'button', variant: null }, 'haptics', 'approved')
    expect(listEvents(t, lib).find(r => r.key === 'button')).toMatchObject({ sound: { state: 'set', review: 'tentative' }, haptic: { state: 'set', review: 'approved' } })
    // plain inherits button's haptics: its review follows the cue, and approving it writes to the cue.
    expect(effectiveEvent(t, { cue: 'button', variant: 'plain' })!.review.haptics).toBe('approved')
    t = setReview(t, { cue: 'button', variant: 'plain' }, 'sfx', 'approved')
    expect(t.cues.button.review).toEqual({ haptics: 'approved', sfx: 'approved' })
    // soft writes its own haptics: its own review.
    t = setReview(t, { cue: 'button', variant: 'soft' }, 'haptics', 'approved')
    expect(t.cues.button.variants!.soft.review).toEqual({ haptics: 'approved' })
    t = setReview(t, { cue: 'button', variant: null }, 'haptics', 'tentative')
    expect(t.cues.button.review).toEqual({ sfx: 'approved' })
    expect(validateCueTable(t, ctx({ clipFiles: new Set(['click', 'thump', 'hum']) }))).toEqual([])
    const reset = resetAllReviews(t)
    expect(reset.cues.button.review).toBeUndefined()
    expect(reset.cues.button.variants!.soft.review).toBeUndefined()
  })

  it('validates review', () => {
    const t = v2Table()
    t.cues.grab.review = { sfx: 'ok' as never, other: 'approved' } as never
    expect(validateCueTable(t, ctx())).toEqual(expect.arrayContaining(['grab: review.sfx must be tentative or approved', 'grab: review.other is not a field (sfx / haptics)']))
  })
})

describe('undecided vs none, loop cue sounds, preview sequences', () => {
  it('a missing key is undecided, null / [] is none; none and undecided are set per field', () => {
    const t = v2Table()
    delete t.cues.grab.sfx; delete t.cues.grab.haptics
    const lib = sampleLib()
    const row = (tb: CueTable) => listEvents(tb, lib).find(r => r.key === 'grab')!
    expect(row(t)).toMatchObject({ sound: { state: 'undecided' }, haptic: { state: 'undecided' } })
    expect(validateCueTable(t, ctx())).toEqual([])
    let n = setNone(t, { cue: 'grab', variant: null }, 'sfx')
    expect(n.cues.grab.sfx).toBeNull()
    expect(row(n)).toMatchObject({ sound: { state: 'none', review: 'tentative' } })
    n = setReview(n, { cue: 'grab', variant: null }, 'sfx', 'approved')
    expect(row(n).sound).toEqual({ state: 'none', review: 'approved' })
    n = setUndecided(n, 'grab', 'sfx')
    expect('sfx' in n.cues.grab).toBe(false)
    expect(n.cues.grab.review).toBeUndefined()
    // A variant: missing = inherit, null / [] = silent in this situation.
    const v = setNone(v2Table(), { cue: 'button', variant: 'plain' }, 'haptics')
    expect(effectiveEvent(v, { cue: 'button', variant: 'plain' })).toMatchObject({ haptics: [], decided: { haptics: true } })
    expect(effectiveEvent(v2Table(), { cue: 'button', variant: 'plain' })!.decided).toEqual({ sfx: true, haptics: true })
  })

  it('loop cue sounds only where the project allows them', () => {
    const t = sampleTable()
    t.cues.feed_loop.sfx = { sound: 'Click', volume: 1 }
    expect(validateCueTable(t, ctx())).toContain('feed_loop: continuous layers have no cue sound')
    expect(validateCueTable(t, ctx({ lib: { ...sampleLib(), loop_cue_sounds: true } }))).toEqual([])
    expect(listEvents(sampleTable(), { ...sampleLib(), loop_cue_sounds: true }).find(r => r.key === 'feed_loop')!.sound).toMatchObject({ state: 'none' })
  })

  it('preview was removed (DEC-085): rejected by the validator; fireShot draws one firing\'s variation', () => {
    const bad = v2Table(); (bad.cues.button as Record<string, unknown>).preview = { repeat: 6 }
    expect(validateCueTable(bad, ctx())).toEqual(expect.arrayContaining([expect.stringMatching(/^button: preview is not a field/)]))
    const t = v2Table()
    t.cues.button.variants!.soft.variation = { gainJitterDb: 3, pitchJitterSt: 2, rateJitterPct: 10, pick: 'random' }
    const e = effectiveEvent(t, { cue: 'button', variant: 'soft' })!
    let k = 0
    const random = () => [0.9, 0.1, 0.5, 0.3, 0.7][k++ % 5]
    const picker = new MaterialPicker(random)
    const shots = Array.from({ length: 6 }, () => fireShot(e, false, picker, random))
    for (let i = 1; i < shots.length; i++) expect(shots[i].routes[0].clip).not.toBe(shots[i - 1].routes[0].clip) // click / thump, never twice
    for (const sh of shots) { expect(Math.abs(sh.jitterDb)).toBeLessThanOrEqual(3); expect(Math.abs(sh.pitchSt)).toBeLessThanOrEqual(2); expect(Math.abs(sh.rate - 1)).toBeLessThanOrEqual(0.1) }
    expect(fireShot(e, true, new MaterialPicker(random), random)).toMatchObject({ pitchSt: 0, rate: 1 }) // loop: gain jitter only
    expect(fireShot(e, false, new MaterialPicker(() => 0), () => 0.5)).toMatchObject({ jitterDb: 0, pitchSt: 0, rate: 1 })
  })

})

describe('the sound played with a haptic audition', () => {
  it('is always the representative (first of a pool of 4), whichever candidate is auditioned', () => {
    const t = v2Table()
    t.cues.grab.sfx = { sounds: ['GrowlA', 'GrowlB', 'GrowlC', 'GrowlD'], volume: 0.7 }
    const buffers = { GrowlA: { id: 'A' }, GrowlB: { id: 'B' }, GrowlC: { id: 'C' }, GrowlD: { id: 'D' } }
    const picks = ['candidate A', 'candidate B', 'candidate A'].map(() => representativeSound(t, sampleLib(), ['grab'], buffers))
    expect(picks.every(p => p?.buffer === buffers.GrowlA && p.volume === 0.7)).toBe(true)
    expect(representativeSound(t, sampleLib(), ['nope'], buffers)).toBeNull()
  })
})

describe('audition routing of an event', () => {
  it('footstep routed to pos_neck reaches only the neck device, not the wrists', async () => {
    const { routePlaybackTargets } = await import('./playbackDevices')
    const t = v2Table()
    t.cues.footstep = { sfx: null, haptics: [{ clip: 'thump', at: 'pos_neck', gain: 1 }] }
    const dev = (ip: string, address: string) => ({ name: ip, ipAddress: ip, address, firmwareVersion: '', online: true, serialConnected: false, volumeWiper: null, volumeLevel: null, volumeSteps: null })
    const all = [dev('neck', 'player_1/pos_neck/group_1'), dev('lw', 'player_1/pos_l_wrist/group_1'), dev('rw', 'player_1/pos_r_wrist/group_1')]
    const ats = cueRoutePositions(t, sampleLib(), 'footstep')
    expect(ats).toEqual(['pos_neck'])
    expect(routePlaybackTargets(all, ats).devices.map(d => d.ipAddress)).toEqual(['neck'])
  })
})

describe('routing of an adjusted material', () => {
  it('a footstep material adjusted in the editor goes to the neck only (every event using it counts)', async () => {
    const { routePlaybackTargets } = await import('./playbackDevices')
    const t = v2Table()
    t.cues.footstep = { sfx: null, haptics: [{ clip: 'thump', at: 'pos_neck', gain: 1 }] }
    delete t.cues.detent // thump is also used by detent at pos_chest in the fixture: keep the case to footstep
    const dev = (ip: string, address: string) => ({ name: ip, ipAddress: ip, address, firmwareVersion: '', online: true, serialConnected: false, volumeWiper: null, volumeLevel: null, volumeSteps: null })
    const all = [dev('neck', 'player_1/pos_neck/group_1'), dev('lw', 'player_1/pos_l_wrist/group_1'), dev('rw', 'player_1/pos_r_wrist/group_1')]
    const ats = materialRoutePositions(t, sampleLib(), 'haptic', 'thump', 'footstep')
    expect(ats).toEqual(['pos_neck'])
    expect(routePlaybackTargets(all, ats).devices.map(d => d.ipAddress)).toEqual(['neck'])
    // Used by another cue too: the union of their positions.
    const shared = v2Table(); shared.cues.footstep = { sfx: null, haptics: [{ clip: 'thump', at: 'pos_neck', gain: 1 }] }
    expect(materialRoutePositions(shared, sampleLib(), 'haptic', 'thump', 'footstep')).toEqual(expect.arrayContaining(['pos_neck', 'pos_chest']))
  })
})
