import { describe, expect, it } from 'vitest'
import { resolveTrialScene, sceneEventTime, sceneProjectNeed, sceneVideoTime, stepSceneFrame, trialSceneOptions } from './trialScene'
import { sampleData, sampleLib } from './sceneTestFixtures'

describe('trial scene moments', () => {
  const data = sampleData()
  data.clips.push({ ...data.clips[0], name: 'grab', names: ['grab'], at: 6.1, event: 6.1, start: 4.1, end: 9.1 })

  it('offers the moments containing the trial cues as stretches of the full replay, marked at that cue', () => {
    const options = trialSceneOptions(data, ['grab'])
    expect(options.map(o => [o.key, o.file, o.end])).toEqual([['@3.000', 'full_replay.mp4', 5], ['@6.100', 'full_replay.mp4', 9.1]])
    expect(options[0].mark).toBeCloseTo(3.1) // grab plays 0.1 s after the button the first moment is for
    expect(options[0].segment).toEqual({ names: ['grab'], start: 1, end: 5, marks: [{ t: 3.1, name: 'grab', target: true }], repeating: false, total: 1 })
    expect(options[1].mark).toBeCloseTo(6.1)
    expect(trialSceneOptions(data, null)).toHaveLength(2)
    expect(trialSceneOptions(data, ['nope'])).toEqual([])
  })

  it('resolves the trial scene against the open project and the saved pick', () => {
    const lib = sampleLib()
    expect(resolveTrialScene({ lib: null, data: null })).toEqual({ kind: 'noProject' })
    expect(resolveTrialScene({ lib: null, data: null, scene: { project: 'trex', cues: ['roar'] } })).toEqual({ kind: 'noProject', project: 'trex' })
    expect(resolveTrialScene({ lib, data, project: 'trex' })).toEqual({ kind: 'otherProject', project: 'trex' })
    expect(resolveTrialScene({ lib, data, scene: { project: 'other', cues: ['grab'] } })).toEqual({ kind: 'otherProject', project: 'other' })
    expect(resolveTrialScene({ lib, data, scene: { project: 'mill', cues: ['nope'] } })).toEqual({ kind: 'noClips', cues: ['nope'] })
    // DEC-085: the representative stretch of the full replay (grab fires once at 3.1 s), no list of recorded clips.
    const auto = resolveTrialScene({ lib, data, scene: { project: 'mill', cues: ['grab'] }, soundSec: () => 0.4 })
    expect(auto.kind === 'ready' && auto.options.map(o => o.key)).toEqual(['segment'])
    expect(auto.kind === 'ready' && auto.chosen).toMatchObject({ key: 'segment', file: 'full_replay.mp4', mark: 3.1, marks: [{ t: 3.1, name: 'grab', target: true }], segment: { repeating: false } })
    expect(auto.kind === 'ready' && auto.chosen!.end).toBeCloseTo(3.1 + 0.4 + 0.5)
    // The user's pick of a moment still wins (listed after the representative).
    const saved = resolveTrialScene({ lib, data, scene: { project: 'mill', cues: ['grab'] }, saved: { project: 'mill', file: '@6.100' } })
    expect(saved.kind === 'ready' && saved.chosen?.key).toBe('@6.100')
    expect(saved.kind === 'ready' && saved.options.map(o => o.key)).toEqual(['segment', '@6.100'])
    const old = resolveTrialScene({ lib, data })
    expect(old.kind === 'ready' && old.options.length === 2 && old.chosen).toBeNull()
    expect(resolveTrialScene({ lib, data, saved: { project: 'other', file: '01_button.mp4' } })).toEqual({ kind: 'otherProject', project: 'other' })
  })

  it('takes the video project only from the Events panel (a subject of another project gets a note, never a link)', () => {
    const lib = sampleLib()
    // A trex clip while Safety Mill (mill) is open: a note naming both, no link / switch.
    const other = sceneProjectNeed(resolveTrialScene({ lib, data, saved: { project: 'trex', file: '01_button.mp4' } }), lib.project_name, 'mill')
    expect(other).toEqual({ kind: 'otherProject', project: 'trex', open: lib.project_name })
    // No project open: link the project last chosen in the Events panel, not the subject's.
    expect(sceneProjectNeed(resolveTrialScene({ lib: null, data: null, scene: { project: 'trex', cues: ['roar'] } }), null, 'mill')).toEqual({ kind: 'link', project: 'mill' })
    expect(sceneProjectNeed(resolveTrialScene({ lib: null, data: null }), null, null)).toEqual({ kind: 'link', project: null })
    // No label, or the open project: nothing to do.
    expect(sceneProjectNeed(resolveTrialScene({ lib, data }), lib.project_name, 'mill')).toBeNull()
    expect(sceneProjectNeed(resolveTrialScene({ lib, data, scene: { project: lib.project_name, cues: ['grab'] } }), lib.project_name, null)).toBeNull()
  })

  it('maps playback time 0 to the cue mark', () => {
    expect(sceneVideoTime(2, 0)).toBe(2)
    expect(sceneVideoTime(2, 0.5)).toBe(2.5)
    expect(sceneVideoTime(1, -2)).toBe(0)
  })

  it('pauses in event time (mark = 0) and steps one 1/30 s frame inside the video', () => {
    expect(sceneEventTime(2, 2.5)).toBeCloseTo(0.5)
    expect(sceneEventTime(2, 1.25)).toBeCloseTo(-0.75) // in the lead-in
    expect(stepSceneFrame(0.5, 1, 2, 10)).toBeCloseTo(0.5 + 1 / 30)
    expect(stepSceneFrame(0, -1, 2, 10)).toBeCloseTo(-1 / 30)
    expect(stepSceneFrame(-2, -1, 2, 10)).toBe(-2) // video start
    expect(stepSceneFrame(8, 1, 2, 10)).toBe(8) // video end
    expect(stepSceneFrame(8, 1, 2, NaN)).toBeCloseTo(8 + 1 / 30) // duration not known yet
  })
})

describe('event moments (cue table v2)', () => {
  it('without the cues in the recording: the earliest moment; the user pick wins', () => {
    const data = sampleData()
    data.full.events = []
    data.clips = [
      { ...data.clips[0], name: 'button:soft', names: ['button:soft'], at: 1.3, event: 1.3, start: 0, end: 4.3 },
      { ...data.clips[0], name: 'button', names: ['button'], at: 17.4, event: 17.4, start: 15.4, end: 20.4 },
    ]
    const scene = { project: 'mill', cues: ['button', 'button:soft'] }
    const state = resolveTrialScene({ lib: sampleLib(), data, scene })
    expect(state.kind === 'ready' && state.chosen?.key).toBe('@1.300')
    expect(state.kind === 'ready' && state.options.map(o => o.label)).toEqual(['01 button:soft (1.3 s)', '02 button (17.4 s)'])
    const picked = resolveTrialScene({ lib: sampleLib(), data, scene, saved: { project: 'mill', file: '@17.400' } })
    expect(picked.kind === 'ready' && picked.chosen?.key).toBe('@17.400')
  })

  it('with the cues in the recording: the representative stretch; a picked moment wins, and back again', () => {
    const data = sampleData()
    const state = resolveTrialScene({ lib: sampleLib(), data, scene: { project: 'mill', cues: ['button'] } })
    expect(state.kind === 'ready' && state.chosen?.key).toBe('segment')
    const picked = resolveTrialScene({ lib: sampleLib(), data, scene: { project: 'mill', cues: ['button'] }, saved: { project: 'mill', file: '@3.000' } })
    expect(picked.kind === 'ready' && picked.chosen?.key).toBe('@3.000')
    expect(picked.kind === 'ready' && picked.options.map(o => o.key)).toEqual(['segment', '@3.000'])
    const back = resolveTrialScene({ lib: sampleLib(), data, scene: { project: 'mill', cues: ['button'] }, saved: { project: 'mill', file: 'segment' } })
    expect(back.kind === 'ready' && back.chosen?.key).toBe('segment')
  })
})
