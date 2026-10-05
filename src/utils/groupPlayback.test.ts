import { describe, expect, it, vi } from 'vitest'
import { groupFirings, inSpans, mixGroupHaptics, shownSpans } from './groupPlayback'
import { EditorPlayback } from './editorPlayback'
import { RATE } from './sceneHaptics'
import type { CueTable } from './sceneCueTable'
import type { ManagerMessage } from '@/types/manager'
import type { StreamOptions } from './audioStreamer'

/** bite (sound + haptic), bite:tear (its own sound, the haptic inherited) and footstep outside the group. */
const table = (): CueTable => ({
  clips: { bite_hit: { intensity: 0.8, loop: false }, step: { intensity: 1, loop: false } },
  sounds: { BiteCrunch: { intensity: 0.7 }, TearRip: { intensity: 0.9 }, Step: { intensity: 0.5 } },
  cues: {
    bite: { sfx: { sound: 'BiteCrunch', volume: 1 }, haptics: [{ clip: 'bite_hit', at: 'pos_neck', gain: 1 }],
      variants: { tear: { sfx: { sound: 'TearRip', volume: 1 } } } },
    footstep: { sfx: { sound: 'Step', volume: 1 }, haptics: [{ clip: 'step', at: 'pos_neck', gain: 1 }] },
  },
} as unknown as CueTable)
// The stretch of bite:tear: tear fires at 0 (red), bite at 0.8 and a footstep at 1.2 (grey).
const plan = { targets: [0], others: [{ atSec: 0.8, name: 'bite' }, { atSec: 1.2, name: 'footstep' }] }

describe('group playback (cue + its variants)', () => {
  it('bite:tear selected: the bite firing sends its haptic and plays its sound; footstep stays sound only', () => {
    const tear = { event: 'bite:tear', target: 'sound' as const, material: 'TearRip' }
    const { haptics, sounds } = groupFirings(table(), plan, tear, true)
    // Haptics to the devices: tear's own firing (the inherited bite haptic) and the bite firing, at the clip intensity.
    expect(haptics).toEqual([{ clip: 'bite_hit', atSec: 0.8, gain: 0.8 }, { clip: 'bite_hit', atSec: 0, gain: 0.8 }])
    // Sounds on the PC: bite's and the footstep's representative sounds at their intensities (no scene multiplier).
    expect(sounds).toEqual([{ sound: 'BiteCrunch', atSec: 0.8, gain: 0.7 }, { sound: 'Step', atSec: 1.2, gain: 0.5 }])
    // "This row only": the others keep their sound, no haptic.
    expect(groupFirings(table(), plan, tear, false).haptics).toEqual([])
  })

  it('the haptic stream carries the bite firing and is sent; the live strength applies to the shown firings only', async () => {
    const pcm = { bite_hit: new Float32Array(160).fill(0.5) }
    const shown = { data: new Float32Array(RATE * 0.2).fill(0.25), rate: RATE }
    const parts = groupFirings(table(), plan, { event: 'bite:tear', target: 'haptic', material: 'bite_hit' }, true).haptics
    expect(parts).toEqual([{ clip: 'bite_hit', atSec: 0.8, gain: 0.8 }])
    const mixed = mixGroupHaptics(shown, parts, pcm, 1.5)
    expect(mixed.length).toBe(RATE * 1.5)
    expect(mixed[Math.round(0.05 * RATE)]).toBeCloseTo(0.25) // the shown haptic (as played)
    expect(mixed[Math.round(0.8 * RATE) + 10]).toBeCloseTo(0.4) // bite: 0.5 × 0.8
    expect(mixed[Math.round(1.2 * RATE) + 10]).toBe(0) // footstep: no haptic
    const spans = shownSpans(plan.targets, 0.2)
    expect(inSpans(spans, 0.1)).toBe(true); expect(inSpans(spans, 0.85)).toBe(false)

    // Played with a device target: the stream starts (haptic send) and reads the strength per chunk position.
    const player = { play: vi.fn().mockResolvedValue(undefined), pause: vi.fn(), isPlaying: () => false, getCurrentTime: () => 0, getDuration: () => 1.5 }
    const send = vi.fn()
    let options: StreamOptions | undefined
    const stream = vi.fn(async (_blob: Blob, out: (m: ManagerMessage) => void, o: StreamOptions) => { options = o; out({ type: 'stream_begin', payload: {} } as ManagerMessage) })
    const playback = new EditorPlayback(player, vi.fn().mockResolvedValue(new Blob()), ['10.0.0.9'], send, stream)
    playback.level = time => inSpans(spans, time) ? 0.3 : 1
    await playback.play()
    expect(stream).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'stream_begin', payload: expect.objectContaining({ targets: ['10.0.0.9'] }) }))
    expect(options!.control!.getIntensity!(0.1)).toBe(0.3) // the shown (red) firing: the slider
    expect(options!.control!.getIntensity!(0.85)).toBe(1) // the bite (grey) firing: its own intensity, already mixed in
  })
})
