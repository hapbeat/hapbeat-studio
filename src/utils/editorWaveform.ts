import type { WaveformClip } from '@/types/waveform'

/** Stable import identity; filenames provide grouping for clips without an ID. */
export const sourceGroup = (clip: WaveformClip): string => clip.sourceGroupId ?? (clip.sourceFileName ? `file:${clip.sourceFileName}` : clip.id)

/** Retain first/last and signed extrema in time order for each physical pixel.
 * At sample-level zoom every sample is retained. Work and path size stay bounded
 * for long audio without losing brief positive or negative transients. */
export function sampleLine(data: Float32Array | number[], width: number): {x: number; value: number}[] {
  const points: {x: number; value: number}[] = []
  if (!data.length || width <= 0) return points
  const bins = Math.min(data.length, Math.max(1, Math.floor(width)))
  for (let bin = 0; bin < bins; bin++) {
    const start = Math.floor(bin * data.length / bins)
    const end = Math.floor((bin + 1) * data.length / bins)
    let min = start, max = start
    for (let i = start + 1; i < end; i++) {
      if (data[i] < data[min]) min = i
      if (data[i] > data[max]) max = i
    }
    for (const i of [...new Set([start, min, max, end - 1])].sort((a,b) => a-b)) {
      points.push({x: i / Math.max(1, data.length - 1) * width, value: data[i]})
    }
  }
  return points
}

/** Draw signed PCM channels in separate lanes, without mirrored peak filling. */
export function renderSampleWaveform(channels: Array<Float32Array | number[]>, ctx: CanvasRenderingContext2D) {
  const {width, height} = ctx.canvas
  if (!channels.length) return
  const lane = height / channels.length
  ctx.strokeStyle = ctx.fillStyle
  ctx.lineWidth = 1
  channels.forEach((data, channel) => {
    const center = lane * (channel + .5), amplitude = Math.max(1, lane / 2 - 2)
    ctx.save()
    ctx.beginPath(); ctx.rect(0, channel * lane, width, lane); ctx.clip()
    ctx.globalAlpha = .2
    ctx.beginPath(); ctx.moveTo(0, center); ctx.lineTo(width, center); ctx.stroke()
    ctx.globalAlpha = 1
    ctx.beginPath()
    sampleLine(data, width).forEach(({x, value}, index) => {
      const y = center - value * amplitude
      if (index === 0) ctx.moveTo(x,y); else ctx.lineTo(x,y)
    })
    ctx.stroke(); ctx.restore()
  })
}
