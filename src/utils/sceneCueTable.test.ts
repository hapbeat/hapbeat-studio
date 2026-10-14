import { describe, expect, it } from 'vitest'
import { AT_VALUES, newCueTable, positionsForCue, clipsForCue, SceneFormatError, encodePcm16Wav, parseCueTable, serializeCueTable, setClipIntensity, setSoundIntensity, soundIntensity, materialIntensity, validateCueTable, type CueTableContext } from './sceneCueTable'
import { sampleLib, sampleTable } from './sceneTestFixtures'

const ctx = (patch: Partial<CueTableContext> = {}): CueTableContext => ({
  lib: sampleLib(), kit: 'mill-kit', cueNames: ['button', 'grab', 'detent', 'feed_loop'],
  clipFiles: new Set(['click', 'thump', 'hum']), soundFiles: new Set(['Click']), ...patch,
})

describe('scene cue table validation (the demos\' validate())', () => {
  it('accepts the table as loaded', () => {
    expect(validateCueTable(sampleTable(), ctx())).toEqual([])
  })

  it('reports every rule of the specification (cue-table section 6)', () => {
    const t = sampleTable()
    t.kit = 'other'
    t.schema_version = 2
    t.cues.button.variants = { soft: { loop: true, emit: { during: 'feed_loop', intervalSec: 1 } } }
    t.cues.button.loop = 'yes' as unknown as boolean
    t.clips['Bad Name'] = { intensity: 2, loop: 'yes' as unknown as boolean }
    t.cues.button.sfx = { sound: 'Motor', volume: 3 }
    t.cues.feed_loop.sfx = { sound: 'Click', volume: 1 }
    t.cues.grab.haptics = [{ clip: 'hum', at: 'pos_head', gain: -1 }, { clip: 'missing', at: 'hand', gain: 1 }]
    delete (t.cues as Record<string, unknown>).detent
    const err = validateCueTable(t, ctx())
    expect(err).toEqual(expect.arrayContaining([
      'schema_version must be 1',
      'kit must be mill-kit',
      'clip name Bad Name must match ^[a-z][a-z0-9_-]*$',
      'clip Bad Name: intensity must be 0..1',
      'clip Bad Name: loop must be true/false',
      'clip Bad Name: Content/Kit/stream-clips/Bad Name.wav missing',
      'cues must be exactly button, grab, detent, feed_loop',
      'button: Content/Audio/Motor.wav missing',
      'button: sfx volume must be 0..2',
      'button: loop must be true/false',
      'button:soft: a variant cannot have loop (it belongs to the cue)',
      'button:soft: a variant cannot have emit (it belongs to the cue)',
      'grab: clip hum loop=true does not fit this cue',
      `grab: at must be one of ${AT_VALUES.join(', ')}`,
      'grab: gain must be 0..2',
      'grab: unknown clip missing',
    ]))
    // A loop cue may have a sound (v1); a bad sound name is reported.
    expect(err.some(e => e.startsWith('feed_loop'))).toBe(false)
    t.cues.button.sfx = { sound: 'bad name', volume: 1 }
    expect(validateCueTable(t, ctx())).toContain('button: bad sound bad name')
  })

  it('makes a new table from the recording (none decided, layer cues as loop cues)', () => {
    expect(newCueTable({ project_name: 'mill', layers: sampleLib().layers }, [{ name: 'grab:hard' }, { name: 'button' }, { name: 'grab' }]))
      .toEqual({ schema_version: 1, kit: 'mill-kit', clips: {}, sounds: {}, cues: { button: {}, feed_loop: { loop: true }, grab: {} } })
  })

  it('narrows the offered loop-cue positions with lib.loop_at (the table may use any position)', () => {
    const t = sampleTable(); t.cues.feed_loop.haptics![0].at = 'both'
    const lib = { ...sampleLib(), loop_at: ['hand'] }
    expect(validateCueTable(t, ctx({ lib }))).toEqual([])
    expect(positionsForCue(lib, t, 'feed_loop')).toEqual(['hand'])
    expect(positionsForCue(lib, t, 'button')).toEqual(lib.at)
    t.cues.feed_loop.haptics![0].at = 'pos_nose'
    expect(validateCueTable(t, ctx({ lib }))[0]).toMatch(/^feed_loop: at must be one of hand, both, pos_neck/)
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
    expect(clipsForCue(sampleTable(), 'button')).toEqual(['click', 'thump'])
  })

  it('round-trips the table text like the standalone viewer writes it', () => {
    const text = serializeCueTable(sampleTable())
    expect(text.endsWith('}\n')).toBe(true)
    expect(text).toContain('\n  "kit": "mill-kit"')
    expect(parseCueTable(text)).toEqual(sampleTable())
    expect(() => parseCueTable('{"schema_version":1,"clips":[]}')).toThrow(/clips and cues/)
    expect(() => parseCueTable('{"clips":{},"cues":{}}')).toThrow(SceneFormatError)
    // Missing sfx / haptics stay missing (undecided), and serialize back as missing.
    expect(parseCueTable('{"schema_version":1,"clips":{},"cues":{"a":{}}}').cues.a).toEqual({})
  })

  it('writes PCM16 WAV headers', () => {
    const buf = encodePcm16Wav(new Float32Array([0, 1, -1, 2]), 16000, 1)
    const dv = new DataView(buf)
    expect(buf.byteLength).toBe(44 + 8)
    expect(dv.getUint32(24, true)).toBe(16000)
    expect([dv.getInt16(44, true), dv.getInt16(46, true), dv.getInt16(48, true), dv.getInt16(50, true)]).toEqual([0, 32767, -32767, 32767])
  })
})
