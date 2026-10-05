import { describe, expect, it } from 'vitest'
import { effectiveEvent, falloffGain, fireShot, MaterialPicker, setDistanceFalloff } from './cueEvents'
import { parseCueTable, serializeCueTable, validateCueTable, type CueTableContext } from './sceneCueTable'
import { mergeCueTables } from './cueTableSync'
import { sampleLib, sampleTable } from './sceneTestFixtures'

const ctx = (): CueTableContext => ({ lib: sampleLib(), kit: 'mill-kit', cueNames: ['button', 'grab', 'detent', 'feed_loop'], clipFiles: new Set(['click', 'thump', 'hum']), soundFiles: new Set(['Click']) })
const falloff = { nearCm: 560, farCm: 2000, farGain: 0.15 }

describe('distanceFalloff', () => {
  it('gain = 1 + (farGain − 1) × curve(t), 1 without a falloff or a recorded distance', () => {
    expect(falloffGain(falloff, 300)).toBe(1)
    expect(falloffGain(falloff, 1280)).toBeCloseTo(0.575)
    expect(falloffGain(falloff, 5000)).toBeCloseTo(0.15)
    expect(falloffGain({ ...falloff, curve: 'easeIn' }, 1280)).toBeCloseTo(1 - 0.85 * 0.25)
    expect(falloffGain(falloff, undefined)).toBe(1)
    expect(falloffGain(null, 5000)).toBe(1)
  })

  it('cue / variant (own, null = fixed, absent = the cue’s), validated, saved, merged and played', () => {
    let t = setDistanceFalloff(sampleTable(), { cue: 'button', variant: null }, falloff)
    t.cues.button.variants = { subtle: { distanceFalloff: null }, near: {} }
    expect(validateCueTable(t, ctx())).toEqual([])
    expect(effectiveEvent(t, { cue: 'button', variant: 'near' })!.falloff).toEqual(falloff)
    expect(effectiveEvent(t, { cue: 'button', variant: 'subtle' })!.falloff).toBeNull()
    expect(parseCueTable(serializeCueTable(t)).cues.button.variants!.subtle).toEqual({ distanceFalloff: null })
    const shot = fireShot(effectiveEvent(t, { cue: 'button', variant: null })!, false, new MaterialPicker(() => 0), () => 0.5, undefined, 5000)
    expect(shot.soundGain).toBeCloseTo(0.6 * 0.15); expect(shot.routes[0].gain).toBeCloseTo(0.15)
    expect(fireShot(effectiveEvent(t, { cue: 'button', variant: 'subtle' })!, false, new MaterialPicker(() => 0), () => 0.5, undefined, 5000).soundGain).toBeCloseTo(0.6)
    const bad = setDistanceFalloff(sampleTable(), { cue: 'button', variant: null }, { nearCm: 2000, farCm: 500, farGain: 3, curve: 'wobble' as never })
    expect(validateCueTable(bad, ctx())).toEqual(expect.arrayContaining(['button: distanceFalloff needs 0 <= nearCm < farCm', 'button: distanceFalloff.farGain must be 0..2', 'button: distanceFalloff.curve must be one of linear, easeIn, easeOut, easeInOut, sigmoid']))
    expect(() => parseCueTable(JSON.stringify({ ...sampleTable(), cues: { button: { distanceFalloff: 3 } } }))).toThrow(/distanceFalloff/)
    // Off on the cue removes the key; back to the cue's on a variant removes it there.
    expect('distanceFalloff' in setDistanceFalloff(t, { cue: 'button', variant: null }, null).cues.button).toBe(false)
    expect('distanceFalloff' in setDistanceFalloff(t, { cue: 'button', variant: 'subtle' }, undefined).cues.button.variants!.subtle).toBe(false)
    // Merge: Studio changes the falloff while the file changed the sfx volume.
    const base = sampleTable(), ours = setDistanceFalloff(base, { cue: 'button', variant: null }, falloff), theirs = structuredClone(base); theirs.cues.button.sfx!.volume = 0.9
    expect(mergeCueTables(base, ours, theirs).table.cues.button).toMatchObject({ distanceFalloff: falloff, sfx: { volume: 0.9 } })
  })
})
