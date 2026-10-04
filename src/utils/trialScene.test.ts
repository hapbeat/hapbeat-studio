import { describe, expect, it } from 'vitest'
import { resolveTrialScene, sceneVideoTime, trialSceneOptions } from './trialScene'
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
    const auto = resolveTrialScene({ lib, data, scene: { project: 'mill', cues: ['grab'] } })
    expect(auto.kind === 'ready' && auto.chosen?.file).toBe('01_button.mp4')
    const saved = resolveTrialScene({ lib, data, scene: { project: 'mill', cues: ['grab'] }, saved: { project: 'mill', file: '02_grab.mp4' } })
    expect(saved.kind === 'ready' && saved.chosen?.file).toBe('02_grab.mp4')
    const old = resolveTrialScene({ lib, data })
    expect(old.kind === 'ready' && old.options.length === 2 && old.chosen).toBeNull()
    expect(resolveTrialScene({ lib, data, saved: { project: 'other', file: '01_button.mp4' } })).toEqual({ kind: 'otherProject', project: 'other' })
  })

  it('maps playback time 0 to the cue mark', () => {
    expect(sceneVideoTime(2, 0)).toBe(2)
    expect(sceneVideoTime(2, 0.5)).toBe(2.5)
    expect(sceneVideoTime(1, -2)).toBe(0)
  })
})

describe('event moments (cue table v2)', () => {
  it('defaults to a moment of the first cue listed, before its variants', () => {
    const data = sampleData()
    data.clips = [
      { ...data.clips[0], file: '01_button-soft.mp4', name: 'button:soft', names: ['button:soft'] },
      { ...data.clips[0], file: '02_button.mp4', name: 'button', names: ['button'] },
    ]
    const state = resolveTrialScene({ lib: sampleLib(), data, scene: { project: 'mill', cues: ['button', 'button:soft'] } })
    expect(state.kind === 'ready' && state.chosen?.file).toBe('02_button.mp4')
    expect(state.kind === 'ready' && state.options.map(o => o.cue)).toEqual(['button:soft', 'button'])
  })
})
