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
    expect(resolveTrialScene({ lib, data, scene: { project: 'other', cues: ['grab'] } })).toEqual({ kind: 'otherProject', project: 'other' })
    expect(resolveTrialScene({ lib, data, scene: { project: 'mill', cues: ['nope'] } })).toEqual({ kind: 'noClips', cues: ['nope'] })
    const auto = resolveTrialScene({ lib, data, scene: { project: 'mill', cues: ['grab'] } })
    expect(auto.kind === 'ready' && auto.chosen?.file).toBe('01_button.mp4')
    const saved = resolveTrialScene({ lib, data, scene: { project: 'mill', cues: ['grab'] }, saved: { project: 'mill', file: '02_grab.mp4' } })
    expect(saved.kind === 'ready' && saved.chosen?.file).toBe('02_grab.mp4')
    const old = resolveTrialScene({ lib, data })
    expect(old.kind === 'ready' && old.options.length === 2 && old.chosen).toBeNull()
    const otherPick = resolveTrialScene({ lib, data, saved: { project: 'other', file: '01_button.mp4' } }) // a pick made in another project is ignored
    expect(otherPick.kind === 'ready' && otherPick.chosen).toBeNull()
  })

  it('maps playback time 0 to the cue mark', () => {
    expect(sceneVideoTime(2, 0)).toBe(2)
    expect(sceneVideoTime(2, 0.5)).toBe(2.5)
    expect(sceneVideoTime(1, -2)).toBe(0)
  })
})
