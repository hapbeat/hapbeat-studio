import { describe, expect, it } from 'vitest'
import { effectiveEvent, fireShot, hasOwnMaterials, scaleAt, MaterialPicker, setRouteClips, setVariantKind, setVariantScale } from './cueEvents'
import { curveAt } from './rampCurve'
import { parseCueTable, serializeCueTable, validateCueTable, type CueTable, type CueTableContext } from './sceneCueTable'
import { mergeCueTables } from './cueTableSync'
import { longestRun, runPosition } from './sceneSegments'
import { sampleLib, sampleTable } from './sceneTestFixtures'

const ctx = (): CueTableContext => ({ lib: sampleLib(), kit: 'mill-kit', cueNames: ['button', 'grab', 'detent', 'feed_loop'], clipFiles: new Set(['click', 'thump', 'hum']), soundFiles: new Set(['Click']) })
/** button:approach — the materials of button, quieter, ramping up to full (like footstep:approach). */
const approach = (): CueTable => { const t = sampleTable(); t.cues.button.variants = { approach: { sfxVolume: 0.3, hapticsGain: 0.35, rampTo: 1 } }; return t }
const ref = { cue: 'button', variant: 'approach' }

describe('multiplier-only variants (sfxVolume / hapticsGain / rampTo)', () => {
  it('validate, read back and survive a save / merge', () => {
    expect(validateCueTable(approach(), ctx())).toEqual([])
    expect(parseCueTable(serializeCueTable(approach())).cues.button.variants!.approach).toEqual({ sfxVolume: 0.3, hapticsGain: 0.35, rampTo: 1 })
    const bad = approach(); bad.cues.button.variants!.approach = { sfx: { sound: 'Click', volume: 1 }, sfxVolume: 3, haptics: [], hapticsGain: 1, rampTo: 1 }
    expect(validateCueTable(bad, ctx())).toEqual(expect.arrayContaining([
      'button:approach: sfxVolume must be 0..2', 'button:approach: sfxVolume is for an inherited sfx (this variant has its own sfx)',
      'button:approach: hapticsGain is for inherited haptics (this variant has its own haptics)', 'button:approach: rampTo needs an inherited sfx or haptics']))
    expect(() => parseCueTable(JSON.stringify({ ...approach(), cues: { button: { variants: { approach: { sfxVolume: 'x' } } } } }))).toThrow(/sfxVolume must be a number/)
    // Studio changes hapticsGain while an agent changes sfxVolume in the file: both kept.
    const base = approach(), ours = setVariantScale(base, ref, { hapticsGain: 0.5 }), theirs = setVariantScale(base, ref, { sfxVolume: 0.2 })
    expect(mergeCueTables(base, ours, theirs).table.cues.button.variants!.approach).toMatchObject({ sfxVolume: 0.2, hapticsGain: 0.5, rampTo: 1 })
  })

  it('play the inherited materials × the multipliers, ramped by the firing of the run (game computation)', () => {
    const e = effectiveEvent(approach(), ref)!
    expect(e.scale).toEqual({ sfx: 0.3, haptics: 0.35, rampTo: 1, curve: 'linear', steps: null })
    // The occurrences list's per-firing multiplier: the 2nd of 4 firings.
    expect(scaleAt(e, { index: 1, count: 4 }).sfx).toBeCloseTo(0.5333, 3); expect(scaleAt(e, { index: 1, count: 4 }).haptics).toBeCloseTo(0.5667, 3)
    expect(hasOwnMaterials(approach(), ref)).toBe(false) // not in the editor's Events panel
    const shot = (progress: number) => fireShot(e, false, new MaterialPicker(() => 0), () => 0.5, { index: progress * 2, count: 3 })
    expect(shot(0).soundGain).toBeCloseTo(0.6 * 0.3); expect(shot(0).routes[0].gain).toBeCloseTo(1 * 0.35)
    expect(shot(0.5).soundGain).toBeCloseTo(0.6 * 0.65); expect(shot(0.5).routes[0].gain).toBeCloseTo(0.675)
    expect(shot(1).soundGain).toBeCloseTo(0.6); expect(shot(1).routes[0].gain).toBeCloseTo(1)
    // The cue itself is not scaled.
    expect(fireShot(effectiveEvent(approach(), { cue: 'button', variant: null })!, false, new MaterialPicker(() => 0), () => 0.5, { index: 2, count: 3 }).soundGain).toBeCloseTo(0.6)
    // Which firing of the run (the same name again within 2.5 s); a lone firing is 0 of 1.
    const events = [0, 1, 2, 3, 20].map(t => ({ t, name: 'button:approach', hand: 'both' }))
    expect(events.map(ev => runPosition(events, ev))).toEqual([0, 1, 2, 3].map(index => ({ index, count: 4 })).concat({ index: 0, count: 1 }))
    expect(longestRun(events, 'button:approach')).toBe(4)
  })

  it('ramp curves and per-firing steps (rampCurve / rampSteps)', () => {
    expect([0, 0.5, 1].map(t => curveAt('easeIn', t))).toEqual([0, 0.25, 1])
    expect([0, 0.5, 1].map(t => curveAt('easeOut', t))).toEqual([0, 0.75, 1])
    expect(curveAt('easeInOut', 0.25)).toBeCloseTo(0.15625)
    expect(curveAt('sigmoid', 0)).toBeCloseTo(0); expect(curveAt('sigmoid', 0.5)).toBeCloseTo(0.5); expect(curveAt('sigmoid', 1)).toBeCloseTo(1)
    expect(curveAt('sigmoid', 0.25)).toBeLessThan(curveAt('easeInOut', 0.25))
    // easeIn on 0.3 → 1.0 over 5 firings: the 3rd (t = 0.5) is 0.3 + 0.7 × 0.25.
    const t = approach(); t.cues.button.variants!.approach.rampCurve = 'easeIn'
    expect(validateCueTable(t, ctx())).toEqual([])
    expect(scaleAt(effectiveEvent(t, ref)!, { index: 2, count: 5 }).sfx).toBeCloseTo(0.475)
    // Steps: one value per firing (both multipliers), the last one past the end.
    const s = approach(); s.cues.button.variants!.approach = { rampSteps: [0.2, 0.5, 1] }
    expect(validateCueTable(s, ctx())).toEqual([])
    const e = effectiveEvent(s, ref)!
    expect([0, 1, 2, 3].map(index => scaleAt(e, { index, count: 4 }).haptics)).toEqual([0.2, 0.5, 1, 1])
    expect(parseCueTable(serializeCueTable(s)).cues.button.variants!.approach.rampSteps).toEqual([0.2, 0.5, 1])
    const bad = approach(); bad.cues.button.variants!.approach = { rampTo: 1, rampSteps: [3], rampCurve: 'wobble' as never }
    expect(validateCueTable(bad, ctx())).toEqual(expect.arrayContaining(['button:approach: rampSteps must be 1-64 numbers 0..2',
      'button:approach: rampSteps replaces rampTo / rampCurve (not both)', 'button:approach: rampCurve must be one of linear, easeIn, easeOut, easeInOut, sigmoid']))
    const noTo = approach(); noTo.cues.button.variants!.approach = { rampCurve: 'easeIn' }
    expect(validateCueTable(noTo, ctx())).toEqual(['button:approach: rampCurve needs rampTo'])
    // Merge: Studio sets steps while the file changed sfxVolume.
    const base = approach(), ours = setVariantScale(base, ref, { rampTo: undefined, rampSteps: [0.3, 1] }), theirs = setVariantScale(base, ref, { sfxVolume: 0.25 })
    expect(mergeCueTables(base, ours, theirs).table.cues.button.variants!.approach).toEqual({ sfxVolume: 0.25, hapticsGain: 0.35, rampSteps: [0.3, 1] })
  })

  it('switching kinds: own materials keep how it sounded (multipliers baked in), back to multipliers only', () => {
    const own = setVariantKind(approach(), ref, 'materials')
    const v = own.cues.button.variants!.approach
    expect(v.sfx).toEqual({ sound: 'Click', volume: 0.18 }); expect(v.haptics![0].gain).toBeCloseTo(0.35)
    expect(v.sfxVolume).toBeUndefined(); expect(v.hapticsGain).toBeUndefined(); expect(v.rampTo).toBeUndefined()
    expect(validateCueTable(own, ctx())).toEqual([])
    const back = setVariantKind(own, ref, 'scale')
    expect(back.cues.button.variants!.approach).toEqual({})
    // Any edit that gives a variant its own haptics drops hapticsGain (never both).
    const t = approach(); t.cues.button.variants!.approach.haptics = [{ clip: 'click', at: 'hand', gain: 1 }]
    expect(setRouteClips(t, ref, 0, ['click', 'thump']).cues.button.variants!.approach.hapticsGain).toBeUndefined()
  })
})
