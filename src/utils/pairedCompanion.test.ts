import { describe, expect, it } from 'vitest'
import { companionSoundName, representativeSound } from './cueEvents'
import { groupFirings } from './groupPlayback'
import { sampleLib } from './sceneTestFixtures'
import type { CueTable } from './sceneCueTable'

/** breath: paired — sound i goes with clip i. */
const table = (clips = ['breath_t56_a', 'breath_t56_b', 'breath_t56_c']): CueTable => ({
  clips: Object.fromEntries(['breath_t56_a', 'breath_t56_b', 'breath_t56_c'].map(c => [c, { intensity: 1, loop: false }])),
  sounds: {},
  cues: {
    ...(structuredClone(sampleTableCues())),
    breath: { sfx: { sounds: ['breath_snort_m4', 'breath_snort_m7', 'breath_huff2_m4'], volume: 1 }, haptics: [{ clips, at: 'pos_neck', gain: 1 }], variation: { paired: true } },
  },
} as unknown as CueTable)
function sampleTableCues() { return {} }
const buffers = { breath_snort_m4: { id: 'm4' }, breath_snort_m7: { id: 'm7' }, breath_huff2_m4: { id: 'huff' } }

describe('paired cue: the sound that goes with a haptic (breath)', () => {
  it('auditioning breath_t56_c plays breath_huff2_m4 (not the representative)', () => {
    const t = table()
    const play = (wav: string) => representativeSound(t, sampleLib(), ['breath'], buffers, companionSoundName(t, { audition: null, material: { event: 'breath', target: 'haptic', wav } }))?.buffer
    expect(play('breath_t56_c')).toBe(buffers.breath_huff2_m4)
    expect(play('breath_t56_b')).toBe(buffers.breath_snort_m7)
    expect(play('breath_t56_a')).toBe(buffers.breath_snort_m4)
    // Not paired: the representative.
    const unpaired = table(); (unpaired.cues.breath as { variation?: object }).variation = {}
    expect(representativeSound(unpaired, sampleLib(), ['breath'], buffers, companionSoundName(unpaired, { audition: null, material: { event: 'breath', target: 'haptic', wav: 'breath_t56_c' } }))?.buffer).toBe(buffers.breath_snort_m4)
  })

  it('a shown sound sends the haptic of the same index, also with the group off', () => {
    const { haptics } = groupFirings(table(), { targets: [0], others: [] }, { event: 'breath', target: 'sound', material: 'breath_huff2_m4' }, false)
    expect(haptics).toEqual([{ clip: 'breath_t56_c', atSec: 0, gain: 1 }])
  })

  it('an AI candidate without sound on a paired cue: the sound at the position its clip will take', () => {
    const t = table(['breath_t56_a'])
    const trial = { id: 'T1', candidates: [{ id: 'A' }, { id: 'B' }, { id: 'C' }], scene: { cues: ['breath'] } }
    const name = (cid: string) => companionSoundName(t, { audition: { trial, candidateId: cid, picks: {} }, material: null })
    expect(name('A')).toBe('breath_snort_m7')
    expect(name('B')).toBe('breath_huff2_m4')
    expect(name('C')).toBeNull() // past the sounds: the representative
    expect(companionSoundName(t, { audition: { trial: { ...trial, candidates: [{ id: 'A', sound: 'breath_snort_m4' }] }, candidateId: 'A', picks: {} }, material: null })).toBe('breath_snort_m4')
  })
})
