import { describe, expect, it } from 'vitest'
import { loopStretch, renderLoopStretch } from './loopStretch'
import { layoutStatus } from './shownLayout'
import { formatMessage, messages } from '@/i18n/messages'
import type { SceneLayer } from './sceneData'

const layer: SceneLayer = { cue: 'brush_loop', gain: [0, 1], rate: null, colors: ['#000', '#000'] }
/** 10 fps: off for frames 0–9, on (0.5 on the right hand) for 10–29, off 30–39, on (0.8, left) 40–49, off after. */
const levels = Array.from({ length: 70 }, (_, i) => i >= 10 && i < 30 ? [0, 0.5] : i >= 40 && i < 50 ? [0.8, 0] : [0, 0])

describe('loop cue: continuous segments from the recorded layer levels', () => {
  it('segments are the active runs from the mark, a run kept to where the level returns to 0', () => {
    const s = loopStretch(levels, 10, layer, 1.0, 0.5)!
    expect(s.segments).toEqual([{ start: 0, end: 2 }])
    expect(s.durationSec).toBe(2)
    const both = loopStretch(levels, 10, layer, 1.0, 3.5)!
    expect(both.segments.map(p => [p.start, p.end])).toEqual([[0, 2], [3, 4]])
    expect(both.durationSec).toBe(4)
    expect(loopStretch(levels, 10, layer, 5.5, 0.5)).toBeNull()
  })

  it('the envelope is the louder hand per frame from the mark', () => {
    const s = loopStretch(levels, 10, layer, 1.0, 3.5)!
    expect(s.envelope[0]).toEqual({ t: 0, gain: 0.5 })
    expect(s.envelope.find(p => Math.abs(p.t - 3.2) < 1e-9)!.gain).toBe(0.8)
    expect(s.envelope.find(p => Math.abs(p.t - 2.5) < 1e-9)!.gain).toBe(0)
  })

  it('tiles the material phase-continuously within a segment, restarting at each, × the level', () => {
    const material = Float32Array.from([1, 2, 3])
    const stretch = { segments: [{ start: 0, end: 7 / 8 }, { start: 1, end: 1.5 }], level: (sec: number) => ({ gain: sec < 0.5 ? 1 : 0.5, rate: 1 }) }
    const [out] = renderLoopStretch([material], 8, stretch, 2)
    expect(out).toHaveLength(16)
    expect(Array.from(out.slice(0, 7))).toEqual([1, 2, 3, 1, 1, 1.5, 0.5])
    expect(out[7]).toBe(0)
    // The second segment starts the material from its beginning.
    expect(Array.from(out.slice(8, 12))).toEqual([0.5, 1, 1.5, 0.5])
    expect(Array.from(out.slice(12))).toEqual([0, 0, 0, 0])
  })

  it('the recorded rate advances the phase', () => {
    const [out] = renderLoopStretch([Float32Array.from([1, 2, 3, 4])], 4, { segments: [{ start: 0, end: 1 }], level: () => ({ gain: 1, rate: 2 }) }, 1)
    expect(Array.from(out)).toEqual([1, 3, 1, 3])
  })

  it('says loop in the header status', () => {
    const { id, params } = layoutStatus({ materialSec: 2, starts: null, loop: { segments: [{ start: 0, end: 2 }], envelope: [] } })
    expect(formatMessage(messages[id].ja, params)).toBe('ループ（素材 2.00 s を繰り返し、強さは録画のレベル）')
    expect(formatMessage(messages[id].en, params)).toBe('Loop (material 2.00 s repeated, strength from the recorded level)')
  })
})
