import { describe, expect, it } from 'vitest'
import { addClipEntry, addRoute, assignSound, clipNameFromFile, clipsForCue, encodePcm16Wav, parseCueTable, removeRoute, serializeCueTable, setClipIntensity, setSoundVolume, soundNameFromFile, updateRoute, validateCueTable, type CueTableContext } from './sceneCueTable'
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

  it('requires the WAV of every clip and cue sound', () => {
    const t = assignSound(sampleTable(), 'grab', 'Whoosh')
    expect(validateCueTable(t, ctx({ clipFiles: new Set(['click', 'hum']) }))).toEqual([
      'clip thump: Content/Kit/stream-clips/thump.wav missing',
      'grab: Content/Audio/Whoosh.wav missing',
    ])
  })
})

describe('scene cue table edits', () => {
  it('edits immutably and clamps values', () => {
    const t = sampleTable()
    const a = updateRoute(t, 'button', 0, { gain: 5, at: 'both' })
    expect(a.cues.button.haptics[0]).toEqual({ clip: 'click', at: 'both', gain: 2 })
    expect(t.cues.button.haptics[0].gain).toBe(1)
    expect(setClipIntensity(t, 'click', -1).clips.click.intensity).toBe(0)
    expect(setSoundVolume(t, 'button', 1.5).cues.button.sfx).toEqual({ sound: 'Click', volume: 1.5 })
    expect(removeRoute(t, 'button', 0).cues.button.haptics).toEqual([])
  })

  it('adds routes with a clip that fits the cue', () => {
    const lib = sampleLib()
    expect(addRoute(sampleTable(), lib, 'grab')?.cues.grab.haptics).toEqual([{ clip: 'click', at: 'hand', gain: 1 }])
    expect(addRoute(sampleTable(), lib, 'feed_loop')?.cues.feed_loop.haptics[1].clip).toBe('hum')
    const noLoops = sampleTable(); delete noLoops.clips.hum
    expect(addRoute(noLoops, lib, 'feed_loop')).toBeNull()
    expect(clipsForCue(sampleTable(), lib, 'button')).toEqual(['click', 'thump'])
  })

  it('keeps the volume when a sound is swapped and defaults it to 0.6', () => {
    expect(assignSound(sampleTable(), 'button', 'Bell').cues.button.sfx).toEqual({ sound: 'Bell', volume: 0.6 })
    const t = setSoundVolume(sampleTable(), 'button', 1.2)
    expect(assignSound(t, 'button', 'Bell').cues.button.sfx).toEqual({ sound: 'Bell', volume: 1.2 })
    expect(assignSound(t, 'button', null).cues.button.sfx).toBeNull()
  })

  it('derives clip / sound names from dropped files', () => {
    expect(clipNameFromFile('My Hit 01.WAV', new Set(['my_hit_01']), '^[a-z][a-z0-9_-]*$')).toBe('my_hit_01_2')
    expect(clipNameFromFile('123.wav', new Set(), '^[a-z][a-z0-9_-]*$')).toBe('clip')
    expect(clipNameFromFile('a.wav', new Set(), '^b')).toBeNull()
    expect(soundNameFromFile('door-slam.wav', new Set(), '^[A-Za-z][A-Za-z0-9_]*$')).toBe('door_slam')
    const t = addClipEntry(sampleTable(), 'new_hit', false, 'New Hit.wav')
    expect(t.clips.new_hit).toEqual({ intensity: 1, loop: false, description: 'Imported from New Hit.wav' })
  })

  it('round-trips the table text like the standalone viewer writes it', () => {
    const text = serializeCueTable(sampleTable())
    expect(text.endsWith('}\n')).toBe(true)
    expect(text).toContain('\n  "kit": "mill-kit"')
    expect(parseCueTable(text)).toEqual(sampleTable())
    expect(() => parseCueTable('{"clips":[]}')).toThrow(/clips and cues/)
    expect(parseCueTable('{"clips":{},"cues":{"a":{}}}').cues.a).toEqual({ haptics: [], sfx: null })
  })

  it('writes PCM16 WAV headers', () => {
    const buf = encodePcm16Wav(new Float32Array([0, 1, -1, 2]), 16000, 1)
    const dv = new DataView(buf)
    expect(buf.byteLength).toBe(44 + 8)
    expect(dv.getUint32(24, true)).toBe(16000)
    expect([dv.getInt16(44, true), dv.getInt16(46, true), dv.getInt16(48, true), dv.getInt16(50, true)]).toEqual([0, 32767, -32767, 32767])
  })
})
