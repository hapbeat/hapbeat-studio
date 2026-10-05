import { describe, expect, it } from 'vitest'
import { effectiveEvent, fireShot, hasOwnMaterials, MaterialPicker, setRouteClips, setVariantKind, setVariantScale } from './cueEvents'
import { parseCueTable, serializeCueTable, validateCueTable, type CueTable, type CueTableContext } from './sceneCueTable'
import { mergeCueTables } from './cueTableSync'
import { runProgress } from './sceneSegments'
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
    expect(e.scale).toEqual({ sfx: 0.3, haptics: 0.35, rampTo: 1 })
    expect(hasOwnMaterials(approach(), ref)).toBe(false) // not in the editor's Events panel
    const shot = (progress: number) => fireShot(e, false, new MaterialPicker(() => 0), () => 0.5, progress)
    expect(shot(0).soundGain).toBeCloseTo(0.6 * 0.3); expect(shot(0).routes[0].gain).toBeCloseTo(1 * 0.35)
    expect(shot(0.5).soundGain).toBeCloseTo(0.6 * 0.65); expect(shot(0.5).routes[0].gain).toBeCloseTo(0.675)
    expect(shot(1).soundGain).toBeCloseTo(0.6); expect(shot(1).routes[0].gain).toBeCloseTo(1)
    // The cue itself is not scaled.
    expect(fireShot(effectiveEvent(approach(), { cue: 'button', variant: null })!, false, new MaterialPicker(() => 0), () => 0.5, 1).soundGain).toBeCloseTo(0.6)
    // Which firing of the run (the same name again within 2.5 s); a lone firing is 0.
    const events = [0, 1, 2, 3, 20].map(t => ({ t, name: 'button:approach', hand: 'both' }))
    expect(events.map(ev => runProgress(events, ev))).toEqual([0, 1 / 3, 2 / 3, 1, 0])
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
