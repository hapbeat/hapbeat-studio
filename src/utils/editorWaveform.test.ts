import {describe, expect, it} from 'vitest'
import {sampleLine, sourceGroup} from './editorWaveform'
import type {WaveformClip} from '@/types/waveform'

describe('sample line rendering', () => {
  it('preserves signed samples in order when zoomed in', () => {
    expect(sampleLine(Float32Array.from([0, .5, -1, .25]), 30)).toEqual([
      {x: 0, value: 0}, {x: 10, value: .5}, {x: 20, value: -1}, {x: 30, value: .25},
    ])
  })
  it('preserves short extrema and their order when many samples share a pixel', () => {
    const data = new Float32Array(10000)
    data[300] = -1; data[400] = .75
    const points = sampleLine(data, 10)
    expect(points.length).toBeLessThanOrEqual(40)
    expect(points.filter(p => p.value !== 0).map(p => p.value)).toEqual([-1, .75])
    expect(points.every((p,i) => !i || p.x >= points[i-1].x)).toBe(true)
  })
  it('handles empty and single-sample audio', () => {
    expect(sampleLine(new Float32Array(), 100)).toEqual([])
    expect(sampleLine(Float32Array.from([-.5]), 100)).toEqual([{x: 0, value: -.5}])
  })
})

describe('source grouping', () => {
  it('keeps independent imports separate even with identical filenames', () => {
    const a = {id: 'a', sourceGroupId: 'a', sourceFileName: 'same.wav'} as WaveformClip
    const b = {...a, id: 'b', sourceGroupId: 'b'}
    expect(sourceGroup(a)).not.toBe(sourceGroup(b))
    expect(sourceGroup({...a, id: 'cut', name: 'renamed'})).toBe(sourceGroup(a))
  })
})
