import { describe, expect, it } from 'vitest'
import { positionsForCue, clipsForCue, encodePcm16Wav, parseCueTable, serializeCueTable, setClipIntensity, setSoundIntensity, soundIntensity, materialIntensity, validateCueTable, type CueTableContext } from './sceneCueTable'
import { sampleLib, sampleTable } from './sceneTestFixtures'

const ctx = (patch: Partial<CueTableContext> = {}): CueTableContext => ({
  lib: sampleLib(), kit: 'mill-kit', cueNames: ['button', 'grab', 'detent', 'feed_loop'],
  clipFiles: new Set(['click', 'thump', 'hum']), soundFiles: new Set(['Click']), ...patch,
})

describe('scene cue table validation (the demos\' validate())', () => {
  it('accepts the table as loaded', () => {
    expect(validateCueTable(sampleTable(), ctx())).toEqual([])
  })

  it('reports every rule the import scripts enforce', () => {
    const t = sampleTable()
    t.kit = 'other'
    t.clips['Bad Name'] = { intensity: 2, loop: 'yes' as unknown as boolean }
    t.cues.button.sfx = { sound: 'Motor', volume: 3 }
    t.cues.feed_loop.sfx = { sound: 'Click', volume: 1 }
    t.cues.grab.haptics = [{ clip: 'hum', at: 'pos_head', gain: -1 }, { clip: 'missing', at: 'hand', gain: 1 }]
    delete (t.cues as Record<string, unknown>).detent
    const err = validateCueTable(t, ctx())
    expect(err).toEqual(expect.arrayContaining([
      'kit must be mill-kit',
      'clip name Bad Name must match ^[a-z][a-z0-9_-]*$',
      'clip Bad Name: intensity must be 0..1',
      'clip Bad Name: loop must be true/false',
      'clip Bad Name: Content/Kit/stream-clips/Bad Name.wav missing',
      'cues must be exactly button, grab, detent, feed_loop',
      'button: bad sound Motor',
      'button: sfx volume must be 0..2',
      'feed_loop: continuous layers have no cue sound',
      'grab: clip hum loop=true does not fit this cue',
      'grab: at must be one of hand, both, pos_neck, pos_chest, pos_l_wrist, pos_r_wrist',
      'grab: gain must be 0..2',
      'grab: unknown clip missing',
    ]))
  })

  it('limits loop-cue positions when the lib has loop_at', () => {
    const t = sampleTable(); t.cues.feed_loop.haptics![0].at = 'both'
    expect(validateCueTable(t, ctx())).toEqual([])
    const lib = { ...sampleLib(), loop_at: ['hand'] }
    expect(validateCueTable(t, ctx({ lib }))).toEqual(['feed_loop: continuous layers allow at = hand'])
    expect(positionsForCue(lib, 'feed_loop')).toEqual(['hand'])
    expect(positionsForCue(lib, 'button')).toEqual(lib.at)
  })

  it('requires the WAV of every clip and cue sound', () => {
    const t = sampleTable(); t.cues.grab.sfx = { sound: 'Whoosh', volume: 0.6 }
    expect(validateCueTable(t, ctx({ clipFiles: new Set(['click', 'hum']) }))).toEqual([
      'clip thump: Content/Kit/stream-clips/thump.wav missing',
      'grab: Content/Audio/Whoosh.wav missing',
    ])
  })

  it('reads and checks the sounds map (base levels, DEC-086)', () => {
    let t = setSoundIntensity(sampleTable(), 'Click', 0.4)
    expect(t.sounds).toEqual({ Click: { intensity: 0.4 } })
    expect(validateCueTable(t, ctx())).toEqual([])
    expect(soundIntensity(t, 'Click')).toBe(0.4)
    expect(soundIntensity(sampleTable(), 'Click')).toBe(1) // absent = 1
    expect(materialIntensity(t, 'haptic', 'thump')).toBe(0.5)
    expect(setSoundIntensity(t, 'Click', 3).sounds!.Click.intensity).toBe(1)
    t = { ...t, sounds: { Click: { intensity: 2 }, '9bad': { intensity: 0.5 }, Ghost: { intensity: 0.5 } } }
    expect(validateCueTable(t, ctx())).toEqual(expect.arrayContaining(['sound Click: intensity must be 0..1', 'sound name 9bad must match ^[A-Za-z][A-Za-z0-9_]*$', 'sound Ghost: Content/Audio/Ghost.wav missing']))
    expect(parseCueTable(serializeCueTable(setSoundIntensity(sampleTable(), 'Click', 0.4))).sounds).toEqual({ Click: { intensity: 0.4 } })
  })
})

describe('scene cue table edits', () => {
  it('clamps a clip intensity and lists the clips that fit a cue', () => {
    const t = sampleTable()
    expect(setClipIntensity(t, 'click', -1).clips.click.intensity).toBe(0)
    expect(t.clips.click.intensity).toBe(1)
    expect(clipsForCue(sampleTable(), sampleLib(), 'button')).toEqual(['click', 'thump'])
  })

  it('round-trips the table text like the standalone viewer writes it', () => {
    const text = serializeCueTable(sampleTable())
    expect(text.endsWith('}\n')).toBe(true)
    expect(text).toContain('\n  "kit": "mill-kit"')
    expect(parseCueTable(text)).toEqual(sampleTable())
    expect(() => parseCueTable('{"clips":[]}')).toThrow(/clips and cues/)
    // Missing sfx / haptics stay missing (undecided), and serialize back as missing.
    expect(parseCueTable('{"clips":{},"cues":{"a":{}}}').cues.a).toEqual({})
  })

  it('writes PCM16 WAV headers', () => {
    const buf = encodePcm16Wav(new Float32Array([0, 1, -1, 2]), 16000, 1)
    const dv = new DataView(buf)
    expect(buf.byteLength).toBe(44 + 8)
    expect(dv.getUint32(24, true)).toBe(16000)
    expect([dv.getInt16(44, true), dv.getInt16(46, true), dv.getInt16(48, true), dv.getInt16(50, true)]).toEqual([0, 32767, -32767, 32767])
  })
})
