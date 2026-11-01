import { describe, expect, it } from 'vitest'
import { AT_VALUES, StaleClipGainKeyError, newCueTable, positionsForCue, clipsForCue, SceneFormatError, encodePcm16Wav, parseCueTable, serializeCueTable, setClipGain, setSoundClipGain, soundClipGain, materialClipGain, validateCueTable, alignClipGains, clipGainOf, kitBucketsDiffer, kitCopyDiffers, kitGainsFor, kitHolds, type CueTableContext } from './sceneCueTable'
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
    t.clips['Bad Name'] = { clip_gain: 2, loop: 'yes' as unknown as boolean }
    t.cues.button.sfx = { sound: 'Motor', volume: 3 }
    t.cues.feed_loop.sfx = { sound: 'Click', volume: 1 }
    t.cues.grab.haptics = [{ clip: 'hum', at: 'pos_head', gain: -1 }, { clip: 'missing', at: 'hand', gain: 1 }]
    delete (t.cues as Record<string, unknown>).detent
    const err = validateCueTable(t, ctx())
    expect(err).toEqual(expect.arrayContaining([
      'schema_version must be 1',
      'kit must be mill-kit',
      'clip name Bad Name must match ^[a-z][a-z0-9_-]*$',
      'clip Bad Name: clip_gain must be 0..1',
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
    let t = setSoundClipGain(sampleTable(), 'Click', 0.4)
    expect(t.sounds).toEqual({ Click: { clip_gain: 0.4 } })
    expect(validateCueTable(t, ctx())).toEqual([])
    expect(soundClipGain(t, 'Click')).toBe(0.4)
    expect(soundClipGain(sampleTable(), 'Click')).toBe(1) // absent = 1
    expect(materialClipGain(t, 'haptic', 'thump')).toBe(0.5)
    expect(setSoundClipGain(t, 'Click', 3).sounds!.Click.clip_gain).toBe(1)
    t = { ...t, sounds: { Click: { clip_gain: 2 }, '9bad': { clip_gain: 0.5 }, Ghost: { clip_gain: 0.5 } } }
    expect(validateCueTable(t, ctx())).toEqual(expect.arrayContaining(['sound Click: clip_gain must be 0..1', 'sound name 9bad must match ^[A-Za-z][A-Za-z0-9_]*$', 'sound Ghost: Content/Audio/Ghost.wav missing']))
    expect(parseCueTable(serializeCueTable(setSoundClipGain(sampleTable(), 'Click', 0.4))).sounds).toEqual({ Click: { clip_gain: 0.4 } })
  })
})

describe('clip gains of a project with a Kit (DEC-103, contracts cue-table §9.1)', () => {
  it("the Kit's value for a clip the Kit has, else the cue table's; sounds always from the cue table", () => {
    const t = setSoundClipGain(sampleTable(), 'Click', 0.4), kit = { thump: 0.2, ghost: 0.9 }
    expect(clipGainOf(t, 'thump', kit)).toBe(0.2)
    expect(clipGainOf(t, 'thump', null)).toBe(0.5)
    expect(clipGainOf(t, 'click', kit)).toBe(1)
    expect(clipGainOf(t, 'unknown', null)).toBe(1)
    expect(materialClipGain(t, 'haptic', 'thump', kit)).toBe(0.2)
    expect(materialClipGain(t, 'sound', 'Click', kit)).toBe(0.4)
    expect(kitHolds(kit, 'thump')).toBe(true)
    expect(kitHolds(kit, 'click')).toBe(false)
    expect(kitHolds(null, 'thump')).toBe(false)
  })

  it('the copy: which clips differ from the Kit, and the table aligned to it (unchanged object when nothing differs)', () => {
    const one = { thump: 0.2, click: 1, ghost: 0.9 }, kit = { fire: one, clip: one }, t = sampleTable()
    expect(kitCopyDiffers(t, kit)).toEqual(['thump'])
    expect(kitCopyDiffers(t, null)).toEqual([])
    const aligned = alignClipGains(t, kit)
    expect(aligned.clips.thump).toEqual({ clip_gain: 0.2, loop: false })
    expect(aligned.clips.click).toBe(t.clips.click)
    expect(aligned.clips.ghost).toBeUndefined() // a Kit clip the table does not have is not added
    expect(aligned.cues).toBe(t.cues)
    expect(t.clips.thump.clip_gain).toBe(0.5)
    expect(alignClipGains(aligned, kit)).toBe(aligned)
    expect(alignClipGains(t, null)).toBe(t)
  })

  it('a clip with another clip_gain in FIRE (events) than in CLIP (stream_events) is not aligned and is named', () => {
    const t = sampleTable(), kit = { fire: { thump: 0.2, click: 0.9 }, clip: { thump: 0.4, click: 0.9 } }
    expect(kitGainsFor(kit, 'fire')).toBe(kit.fire)
    expect(kitGainsFor(null, 'clip')).toBeNull()
    expect(kitBucketsDiffer(t, kit)).toEqual(['thump'])
    expect(kitCopyDiffers(t, kit)).toEqual(['click'])
    const aligned = alignClipGains(t, kit)
    expect(aligned.clips.thump.clip_gain).toBe(0.5)
    expect(aligned.clips.click.clip_gain).toBe(0.9)
  })
})

describe('scene cue table edits', () => {
  it('clamps a clip gain and lists the clips that fit a cue', () => {
    const t = sampleTable()
    expect(setClipGain(t, 'click', -1).clips.click.clip_gain).toBe(0)
    expect(t.clips.click.clip_gain).toBe(1)
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

  it('a cue table whose clips / sounds still carry intensity (no clip_gain) is not read (DEC-103)', () => {
    const text = (clips: unknown, sounds: unknown) => JSON.stringify({ schema_version: 1, clips, sounds, cues: {} })
    expect(() => parseCueTable(text({ a: { intensity: 0.4, loop: false } }, {}))).toThrow(StaleClipGainKeyError)
    expect(() => parseCueTable(text({ a: { clip_gain: 0.4, loop: false } }, { S: { intensity: 0.5 } }))).toThrow(/sounds\.S/)
    // clip_gain (also beside the old key) and entries with neither are read as before.
    expect(parseCueTable(text({ a: { clip_gain: 0.4, intensity: 0.4, loop: false }, b: { loop: false } }, { S: {} })).clips.b).toEqual({ loop: false })
  })

  it('writes PCM16 WAV headers', () => {
    const buf = encodePcm16Wav(new Float32Array([0, 1, -1, 2]), 16000, 1)
    const dv = new DataView(buf)
    expect(buf.byteLength).toBe(44 + 8)
    expect(dv.getUint32(24, true)).toBe(16000)
    expect([dv.getInt16(44, true), dv.getInt16(46, true), dv.getInt16(48, true), dv.getInt16(50, true)]).toEqual([0, 32767, -32767, 32767])
  })
})
