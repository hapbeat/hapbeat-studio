import { describe, expect, it } from 'vitest'
import { timeAtPixel, waveformPeaks, waveformOutline, zoomAtTime } from './waveformView'
describe('waveform overview and selection mapping', () => {
  it('keeps the point under the cursor fixed during zoom, bounded to the clip', () => {
    expect(zoomAtTime(5, 200, 200, 1000, 20)).toBe(4)
    expect(zoomAtTime(1, 600, 200, 1000, 20)).toBe(0)
    expect(zoomAtTime(20, 200, 200, 1000, 20)).toBe(15)
  })
  it('draws both positive and negative peaks as a continuous outline', () => {
    const buffer = {length: 2, numberOfChannels: 1, getChannelData: () => Float32Array.from([1,-1])} as unknown as AudioBuffer
    expect(waveformOutline(buffer, 2)).toBe('M128,1 L384,20 L384,39 L128,20 Z')
  })

  it('maps dragging to the visible scrolled interval rather than the whole file', () => {
    expect(timeAtPixel(250, 1000, 2000, 500, 20)).toBe(4.5)
    expect(timeAtPixel(-100, 1000, 2000, 500, 20)).toBe(4)
    expect(timeAtPixel(1500, 1000, 2000, 500, 20)).toBe(6)
    expect(timeAtPixel(900, 1000, 9900, 500, 20)).toBe(20)
  })
  it('includes transients from both stereo channels in thumbnail bins', () => {
    const channels = [new Float32Array([0,0,0,0]), new Float32Array([0,.8,0,.5])]
    const buffer = {length:4,numberOfChannels:2,getChannelData:(ch: number) => channels[ch]} as AudioBuffer
    expect(waveformPeaks(buffer, 2)).toEqual([expect.closeTo(.8), .5])
  })
})
