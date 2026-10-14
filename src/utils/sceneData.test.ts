import { describe, expect, it } from 'vitest'
import { buildItems, clipEnd, deriveMoments, familyColor, focusEvent, itemEvents, layersFromColumns, levelAt, momentCues, momentStart, parseViewerData, parseViewerLib, withRecordingLayers, type MomentRules, type SceneEvent } from './sceneData'
import { AT_VALUES, parseCueTable, SceneFormatError, validateCueTable } from './sceneCueTable'
import { sampleData, sampleLib, sampleViewerDataFile, sampleViewerLibFile } from './sceneTestFixtures'
import { CONTRACT_CUE_TABLE, CONTRACT_SCENE_RECORDING } from './sceneContractFixtures'

const text = (v: unknown) => JSON.stringify(v)

describe('scene data files (scene-recording v1)', () => {
  it('parses viewer-lib.json: layers by `level`, a missing rate is null, omitted fields get their defaults', () => {
    expect(parseViewerLib(text(sampleViewerLibFile()))).toEqual(sampleLib())
    const lib = parseViewerLib(text({ ...sampleViewerLibFile(), layers: [{ cue: 'feed_loop', level: [0, 1], colors: ['#fff', '#000'] }] }))
    expect(lib.layers[0]).toEqual({ cue: 'feed_loop', gain: [0, 1], rate: null, colors: ['#fff', '#000'] })
    expect(lib.loop_cues).toEqual(['feed_loop'])
  })

  it('names the field a broken lib or recording lacks; another schema_version asks for the migration', () => {
    expect(() => parseViewerLib('{')).toThrow(/viewer-lib.json/)
    expect(() => parseViewerLib(text({ ...sampleViewerLibFile(), paths: { cues: 'a' } }))).toThrow(/paths/)
    expect(() => parseViewerLib(text({ ...sampleViewerLibFile(), loop_at: 'hand' }))).toThrow(/loop_at/)
    expect(() => parseViewerLib(text({ ...sampleViewerLibFile(), at: ['pos_nose'] }))).toThrow(/at/)
    expect(() => parseViewerLib(text({ ...sampleViewerLibFile(), moment_rules: { max: { footstep: 0 } } }))).toThrow(/moment_rules/)
    expect(parseViewerLib(text({ ...sampleViewerLibFile(), loop_at: ['hand'] })).loop_at).toEqual(['hand'])
    expect(() => parseViewerLib(text({ ...sampleViewerLibFile(), schema_version: 2 }))).toThrow(SceneFormatError)
    expect(() => parseViewerLib(text({ ...sampleViewerLibFile(), schema_version: undefined }))).toThrow(/migrate_scene_v1/)
    const lib = sampleLib()
    expect(() => parseViewerData(text({ ...sampleViewerDataFile(), fps: 0 }), lib)).toThrow(/fps/)
    expect(() => parseViewerData(text({ ...sampleViewerDataFile(), levels: { columns: ['a:level'], rows: [[1, 2]] } }), lib)).toThrow(/levels/)
    expect(() => parseViewerData(text({ ...sampleViewerDataFile(), events: [{ t: 1, name: 'x', hand: 'up' }] }), lib)).toThrow(/events/)
    expect(() => parseViewerData(text({ fps: 30, clips: [], full: {} }), lib)).toThrow(SceneFormatError)
  })

  it('reads a recording without levels as frames empty rows, and an event without hand as not given', () => {
    const { levels: _levels, ...file } = sampleViewerDataFile()
    const data = parseViewerData(text({ ...file, events: [{ t: 1, name: 'button' }] }), sampleLib())
    expect(data.full.levels).toHaveLength(150)
    expect(data.full.columns).toEqual([])
    expect(data.full.events).toEqual([{ t: 1, name: 'button', hand: '' }])
  })

  it('lists the full replay first, then every moment as a stretch of the full replay', () => {
    const data = parseViewerData(text(sampleViewerDataFile()), sampleLib())
    const items = buildItems(data)
    expect(items.map(i => [i.kind, i.names.join('+')])).toEqual([['full', ''], ['clip', 'detent'], ['clip', 'button+grab'], ['clip', 'detent'], ['clip', 'feed_loop']])
    expect(items.every(i => i.file === 'full_replay.mp4')).toBe(true)
    expect(items[2]).toMatchObject({ at: 3, event: 3, start: 1, end: 5 })
    // 150 frames at 30 fps: the last moment's stretch ends with the recording.
    expect(items[4]).toMatchObject({ start: 2.5, end: 5 })
    expect(clipEnd(items[2])).toBe(5)
    expect(clipEnd(items[0])).toBe(Infinity)
    expect(momentStart(items[2], 1)).toBe(2)
    expect(momentStart(items[2], 5)).toBe(1)
  })
})

describe('deriveMoments (scene-recording section 3.4)', () => {
  const none: MomentRules = { max: {}, min_gap_s: {}, default_max: null }
  const ev = (t: number, name: string, extra: Partial<SceneEvent> = {}): SceneEvent => ({ t, name, hand: '', ...extra })
  const names = (events: SceneEvent[], ticks: string[] = [], rules: MomentRules = none, duration = 100) =>
    deriveMoments(events, { ticks, moment_rules: rules }, duration).map(m => `${m.at}:${m.names.join('+')}`)

  it('joins cues within 0.2 s of the moment\'s first cue; the first one names it (hand, note)', () => {
    expect(names([ev(1, 'button'), ev(1.2, 'spindle_on'), ev(1.3, 'feed')])).toEqual(['1:button+spindle_on', '1.3:feed'])
    expect(deriveMoments([ev(5, 'grab', { hand: 'right', note: 'take 1' }), ev(5.1, 'grab')], { ticks: [], moment_rules: none }, 100))
      .toEqual([{ name: 'grab', names: ['grab'], hand: 'right', at: 5, note: 'take 1', start: 3, end: 8 }])
  })

  it('keeps tick cues (a <cue> entry covers its variants) as moments of their own', () => {
    expect(names([ev(1, 'button'), ev(1.05, 'detent'), ev(1.1, 'detent:fine'), ev(1.15, 'grab')], ['detent'])).toEqual(['1:button+grab', '1.05:detent', '1.1:detent:fine'])
  })

  it('min_gap_s skips a moment too soon after the last kept one of the same key', () => {
    const rules = { ...none, min_gap_s: { footstep: 2 } }
    expect(names([ev(0, 'footstep'), ev(1, 'footstep:approach'), ev(3, 'footstep'), ev(4, 'roar')], [], rules)).toEqual(['0:footstep', '3:footstep', '4:roar'])
  })

  it('max counts a <cue> key over its variants, a <cue>:<variant> key on its own; default_max per name', () => {
    const steps = [ev(0, 'footstep:approach'), ev(1, 'footstep:leave'), ev(2, 'footstep'), ev(3, 'footstep:leave')]
    expect(names(steps, [], { ...none, max: { footstep: 2 } })).toEqual(['0:footstep:approach', '1:footstep:leave'])
    expect(names(steps, [], { ...none, max: { footstep: 2, 'footstep:leave': 1 } })).toEqual(['0:footstep:approach', '1:footstep:leave', '2:footstep'])
    expect(names(steps, [], { ...none, default_max: 1 })).toEqual(['0:footstep:approach', '1:footstep:leave', '2:footstep'])
  })

  it('cuts the stretch at 0 and at the recording\'s end', () => {
    expect(deriveMoments([ev(0.5, 'a'), ev(9, 'b')], { ticks: [], moment_rules: none }, 10).map(m => [m.start, m.end])).toEqual([[0, 3.5], [7, 10]])
  })
})

describe('layers from the level columns (scene-recording section 2.1)', () => {
  it('makes one layer per cue, sides from :left / :right, the rate when recorded', () => {
    expect(layersFromColumns(['hold:level:left', 'hold:level:right', 'hold:rate:left', 'hold:rate:right', 'feed:level', 'other'])).toEqual([
      { cue: 'hold', gain: [0, 1], rate: [2, 3], colors: ['#4ea1ff', '#ff8a3d'] },
      { cue: 'feed', gain: [4, 4], rate: null, colors: ['#5cd18b', '#c77dff'] },
    ])
    expect(layersFromColumns(['rub:level:right'])).toMatchObject([{ cue: 'rub', gain: [0, 0] }])
  })
})

describe('contracts fixtures (sample-cue-table.json, sample-scene-recording.json)', () => {
  const rec = CONTRACT_SCENE_RECORDING

  it('reads every sample viewer-lib, with the defaults filled', () => {
    const minimal = parseViewerLib(text(rec.viewer_lib_minimal))
    expect(minimal).toMatchObject({ title: 'Minimal', at: [...AT_VALUES], loop_at: [...AT_VALUES], families: [], ticks: [], layers: [], loop_cues: [], import_command: '',
      moment_rules: { max: {}, min_gap_s: {}, default_max: null } })
    expect(minimal.record_command).toBeUndefined()
    const layers = parseViewerLib(text(rec.viewer_lib_layers))
    expect(layers).toMatchObject({ at: ['hand', 'pos_neck'], loop_at: ['hand'], loop_cues: ['feed_loop', 'cut_loop'] })
    expect(layers.layers).toEqual([
      { cue: 'feed_loop', gain: [0, 1], rate: [2, 3], colors: ['#4ea1ff', '#ff8a3d'] },
      { cue: 'cut_loop', gain: [4, 4], rate: null, colors: ['#aaaaaa', '#aaaaaa'] },
    ])
    const session = parseViewerLib(text(rec.session.lib))
    expect(session).toMatchObject({ ticks: ['footstep'], import_command: 'hapbeat import', moment_rules: { max: { footstep: 3 }, min_gap_s: { footstep: 2 }, default_max: null } })
  })

  it('reads the sample viewer-data: its moments and the layers from its columns', () => {
    const lib = parseViewerLib(text(rec.session.lib))
    const data = parseViewerData(text(rec.viewer_data), lib)
    expect(data.full).toMatchObject({ file: 'full_replay.mp4', columns: ['rub:level:left', 'rub:level:right'], levels: [[0, 0], [0, 0.4]] })
    expect(data.full.events[2]).toEqual({ t: 6, name: 'grab', hand: 'right', gain: 0.9, note: 'right hand on the bone' })
    expect(data.clips.map(c => [c.names.join('+'), c.start, c.end, c.note])).toEqual([['footstep:approach', 0, 4, ''], ['roar', 2, 7, ''], ['grab', 4, 8, 'right hand on the bone']])
    expect(withRecordingLayers(lib, data)).toMatchObject({ layers: [{ cue: 'rub', gain: [0, 1], rate: null }], loop_cues: ['rub'] })
  })

  it('parses and validates the sample cue table (cue-table section 6)', () => {
    const table = parseCueTable(text(CONTRACT_CUE_TABLE))
    const lib = parseViewerLib(text(rec.session.lib))
    expect(validateCueTable(table, { lib, kit: 'sample-scene-kit', cueNames: Object.keys(table.cues), clipFiles: new Set(Object.keys(table.clips)), soundFiles: new Set(Object.keys(table.sounds ?? {})) })).toEqual([])
    expect(() => parseCueTable(text({ ...CONTRACT_CUE_TABLE, schema_version: undefined }))).toThrow(SceneFormatError)
  })
})

describe('scene cue timing', () => {
  const data = sampleData(), items = buildItems(data), clip = items[1], all = data.full.events

  it('shows a moment\'s events in its stretch (replay time) and marks its own cues', () => {
    expect(itemEvents(clip, all).map(e => [e.name, e.t, e.own])).toEqual([
      ['detent', 1, false], ['button', 3, true], ['grab', 3.1, true], ['detent', 3.15, false], ['feed_loop', 4.5, false],
    ])
    expect(itemEvents({ ...clip, start: 2, end: 4 }, all).map(e => e.name)).toEqual(['button', 'grab', 'detent'])
  })

  it('groups the cues of one moment and skips ticks', () => {
    const ev = itemEvents(clip, all)
    expect(momentCues(ev, 3.0, ['detent'])).toEqual(['button', 'grab'])
    expect(momentCues(ev, null, [])).toEqual([])
  })

  it('focuses a moment on its own cue and the replay on the last non-tick cue', () => {
    expect(focusEvent(clip, itemEvents(clip, all), 0, ['detent'])?.name).toBe('button')
    expect(focusEvent(items[0], itemEvents(items[0], all), 3.2, ['detent'])?.name).toBe('grab')
  })

  it('interpolates layer levels and follows the louder hand for fixed routes', () => {
    const layer = sampleLib().layers[0]
    const levels = [[0, 1, 1, 2], [1, 0, 3, 4]]
    expect(levelAt(levels, 10, layer, 0.05, 0)).toEqual([0.5, 2])
    expect(levelAt(levels, 10, layer, 0.0, -1)).toEqual([1, 2])
    expect(levelAt(levels, 10, layer, 5, 0)).toEqual([0, 1])
    expect(familyColor(sampleLib(), 'grab')).toBe('#4ea1ff')
    expect(familyColor(sampleLib(), 'nope')).toBe('#888888')
    // A family naming the variant wins over one naming its cue.
    const lib = { ...sampleLib(), families: [{ label: 'a', color: '#111111', cues: ['grab'] }, { label: 'b', color: '#222222', cues: ['grab:hard'] }] }
    expect(familyColor(lib, 'grab:hard')).toBe('#222222')
    expect(familyColor(lib, 'grab:soft')).toBe('#111111')
  })
})
