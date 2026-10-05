import { describe, expect, it, vi } from 'vitest'
import { sceneSegment } from './sceneSegments'
import { sceneVideoTime } from './trialScene'
import { FRAME_SEC, videoCorrection } from './editorSceneSync'
import { FiringScheduler } from './firingScheduler'
import { groupFirings, groupHapticsEnd, markMaterials, mixGroupHaptics } from './groupPlayback'
import { RATE } from './sceneHaptics'
import type { CueTable } from './sceneCueTable'
import type { SceneEvent } from './sceneData'

const table = (): CueTable => ({
  clips: { bite_t51_a: { intensity: 1, loop: false }, tear_hit: { intensity: 1, loop: false } },
  sounds: { BiteCrunch: { intensity: 1 }, chew_meat_1s: { intensity: 1 } },
  cues: {
    bite: { sfx: { sound: 'BiteCrunch', volume: 1 }, haptics: [{ clip: 'bite_t51_a', at: 'pos_neck', gain: 1 }],
      variants: { tear: { sfx: { sound: 'chew_meat_1s', volume: 1 } } } },
  },
} as unknown as CueTable)
// A meal as recorded: bite, tear, bite, tear … (a repeating chain) and a one-off bite / tear pair.
const meal: SceneEvent[] = [21.367, 23.4, 25.4].map(t => ({ t, name: 'bite', hand: 'both' }))
  .concat([21.967, 24.0, 26.0].map(t => ({ t, name: 'bite:tear', hand: 'both' })))
const once: SceneEvent[] = [{ t: 9.6, name: 'bite', hand: 'both' }, { t: 10, name: 'bite:tear', hand: 'both' }, { t: 10.9, name: 'bite', hand: 'both' }]

/** The audition plan as the editor builds it (useAuditionPlan): offsets from the first mark, which is the video's 0. */
const planOf = (events: SceneEvent[]) => {
  const seg = sceneSegment(events, ['bite:tear'], 0.4)!, mark = seg.marks[0].t
  return { seg, mark, targets: seg.marks.filter(m => m.target).map(m => m.t - mark), others: seg.marks.filter(m => !m.target).map(m => ({ atSec: m.t - mark, name: m.name })) }
}

describe('group playback timing against the video (bite / bite:tear)', () => {
  it.each([['a repeating meal', meal], ['a one-off pair', once]] as const)('%s: every firing is scheduled on the video time of its mark (≤ 1 frame)', (_, events) => {
    const p = planOf(events)
    const shown = { event: 'bite:tear', target: 'sound' as const, material: 'chew_meat_1s' }
    const { haptics, sounds } = groupFirings(table(), p, shown, true)
    // PC sounds: FiringScheduler on the AudioContext clock, started with the playback at 0.
    const starts: number[] = []
    const ctx = { currentTime: 5, destination: {}, createGain: () => ({ gain: { value: 1 }, connect: vi.fn() }),
      createBufferSource: () => ({ buffer: null, connect: vi.fn(), stop: vi.fn(), start: (when: number) => starts.push(when - 5) }) }
    const scheduler = new FiringScheduler<{ duration: number }>(() => ctx)
    scheduler.setFirings(sounds.map(s => ({ atSec: s.atSec, gain: s.gain, buffer: { duration: 0.4 } })))
    scheduler.play(0)
    // The video plays from sceneVideoTime(mark, 0) at the same moment: firing at player time x is on video time mark + x.
    const grey = p.seg.marks.filter(m => !m.target)
    grey.forEach((m, i) => {
      expect(Math.abs(sceneVideoTime(p.mark, starts[i]) - m.t)).toBeLessThanOrEqual(FRAME_SEC)
      expect(Math.abs(sceneVideoTime(p.mark, haptics[i].atSec) - m.t)).toBeLessThanOrEqual(FRAME_SEC)
    })
    // The red firings' haptic (the shown sound's event) on their marks too.
    p.seg.marks.filter(m => m.target).forEach((m, i) => expect(Math.abs(sceneVideoTime(p.mark, haptics[grey.length + i].atSec) - m.t)).toBeLessThanOrEqual(FRAME_SEC))
    // In the haptic stream: each part's first sample at its mark's offset (±1 frame), including a bite after the last tear.
    const pcm = { bite_t51_a: new Float32Array(1600).fill(0.5) }
    const end = groupHapticsEnd(haptics.filter(h => h.clip === 'bite_t51_a'), pcm)
    const mixed = mixGroupHaptics(null, haptics, pcm, end)
    for (const h of haptics.filter(x => x.clip === 'bite_t51_a')) {
      const first = mixed.findIndex((v, i) => i >= Math.round((h.atSec - FRAME_SEC) * RATE) && v !== 0)
      expect(Math.abs(first / RATE - h.atSec)).toBeLessThanOrEqual(FRAME_SEC)
    }
    expect(end).toBeCloseTo(Math.max(...haptics.map(h => h.atSec)) + 0.1, 3)
  })

  it('the video catches up with the playback within a frame after a seek lag, and stays there', () => {
    let video = 0, played = 0
    const lagged = (lag: number) => { video = -lag; played = 0 }
    const run = (seconds: number) => {
      let worstAfter = 0
      for (let t = 0; t < seconds; t += 0.016) {
        const c = videoCorrection(video, played)
        if (c.seek !== null) video = c.seek
        video += 0.016 * c.rate; played += 0.016
        if (t > 0.6) worstAfter = Math.max(worstAfter, Math.abs(video - played))
      }
      return worstAfter
    }
    lagged(0.12); expect(run(5)).toBeLessThanOrEqual(FRAME_SEC)
    lagged(0.4); expect(run(5)).toBeLessThanOrEqual(FRAME_SEC) // beyond 0.25 s: moved at once
    lagged(-0.1); expect(run(5)).toBeLessThanOrEqual(FRAME_SEC) // ahead
    expect(videoCorrection(1, 1.005)).toEqual({ seek: null, rate: 1 })
  })

  it('names what each firing plays (overlay, marks titles)', () => {
    const p = planOf(once)
    const out = markMaterials(table(), p.seg.marks, { event: 'bite:tear', target: 'sound', material: 'chew_meat_1s' }, true, () => 0.4)
    expect(out.map(x => x && `${x.label}: ${x.material}`)).toEqual(['bite: BiteCrunch', 'tear: chew_meat_1s', 'bite: BiteCrunch'])
    const haptic = markMaterials(table(), p.seg.marks, { event: 'bite:tear', target: 'haptic', material: 'tear_hit' }, true, () => 0.4)
    expect(haptic.map(x => x && `${x.label}: ${x.material}`)).toEqual(['bite: bite_t51_a', 'tear: tear_hit', 'bite: bite_t51_a'])
  })
})
