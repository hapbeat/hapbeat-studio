import { describe, expect, it } from 'vitest'
import { resolveTrialScene, sceneEventTime, sceneVideoTime, stepSceneFrame, trialSceneOptions } from './trialScene'
import { sampleData, sampleLib } from './sceneTestFixtures'

describe('trial scene clips', () => {
  const data = sampleData()
  data.clips.push({ ...data.clips[0], file: '02_grab.mp4', name: 'grab', names: ['grab'], at: 3.1 })

  it('offers the clips containing the trial cues, marked at that cue', () => {
    const options = trialSceneOptions(data, ['grab'])
    expect(options.map(o => o.file)).toEqual(['01_button.mp4', '02_grab.mp4'])
    expect(options[0].mark).toBeCloseTo(2.1) // grab plays 0.1 s after the button the first clip was cut for
    expect(options[1].mark).toBeCloseTo(2.0)
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
    expect(auto.kind === 'ready' && auto.options.map(o => o.file)).toEqual(['full_replay.mp4'])
    expect(auto.kind === 'ready' && auto.chosen).toMatchObject({ file: 'full_replay.mp4', mark: 3.1, marks: [{ t: 3.1, name: 'grab', target: true }], segment: { repeating: false } })
    expect(auto.kind === 'ready' && auto.chosen!.end).toBeCloseTo(3.1 + 0.4 + 0.5)
    // The user's pick of a recorded clip still wins (listed after the representative).
    const saved = resolveTrialScene({ lib, data, scene: { project: 'mill', cues: ['grab'] }, saved: { project: 'mill', file: '02_grab.mp4' } })
    expect(saved.kind === 'ready' && saved.chosen?.file).toBe('02_grab.mp4')
    expect(saved.kind === 'ready' && saved.options.map(o => o.file)).toEqual(['full_replay.mp4', '02_grab.mp4'])
    const old = resolveTrialScene({ lib, data })
    expect(old.kind === 'ready' && old.options.length === 2 && old.chosen).toBeNull()
    expect(resolveTrialScene({ lib, data, saved: { project: 'other', file: '01_button.mp4' } })).toEqual({ kind: 'otherProject', project: 'other' })
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
  it('without the cues in the recording: the earliest recorded clip; scene.clip names one; the user pick wins', () => {
    const data = sampleData()
    data.full.events = []
    data.clips = [
      { ...data.clips[0], file: '01_button-soft.mp4', name: 'button:soft', names: ['button:soft'], at: 1.3 },
      { ...data.clips[0], file: '02_button.mp4', name: 'button', names: ['button'], at: 17.4 },
    ]
    const scene = { project: 'mill', cues: ['button', 'button:soft'] }
    const state = resolveTrialScene({ lib: sampleLib(), data, scene })
    expect(state.kind === 'ready' && state.chosen?.file).toBe('01_button-soft.mp4')
    expect(state.kind === 'ready' && state.options.map(o => o.label)).toEqual(['01 button:soft (1.3 s)', '02 button (17.4 s)'])
    const named = resolveTrialScene({ lib: sampleLib(), data, scene: { ...scene, clip: '02_button.mp4' } })
    expect(named.kind === 'ready' && named.chosen?.file).toBe('02_button.mp4')
    const picked = resolveTrialScene({ lib: sampleLib(), data, scene: { ...scene, clip: '02_button.mp4' }, saved: { project: 'mill', file: '01_button-soft.mp4' } })
    expect(picked.kind === 'ready' && picked.chosen?.file).toBe('01_button-soft.mp4')
  })

  it('with the cues in the recording: scene.clip (a recorded clip) wins over the representative stretch', () => {
    const data = sampleData()
    const state = resolveTrialScene({ lib: sampleLib(), data, scene: { project: 'mill', cues: ['button'], clip: '01_button.mp4' } })
    expect(state.kind === 'ready' && state.chosen?.file).toBe('01_button.mp4')
    expect(state.kind === 'ready' && state.options.map(o => o.file)).toEqual(['full_replay.mp4', '01_button.mp4'])
    const back = resolveTrialScene({ lib: sampleLib(), data, scene: { project: 'mill', cues: ['button'], clip: '01_button.mp4' }, saved: { project: 'mill', file: 'full_replay.mp4' } })
    expect(back.kind === 'ready' && back.chosen?.file).toBe('full_replay.mp4')
  })
})
