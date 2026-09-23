/** Coordinate mapping shared by waveform selection, overview and viewport. */
export function timeAtPixel(x: number, width: number, scroll: number, pixelsPerSecond: number, duration: number): number {
  return Math.max(0, Math.min(duration, (Math.max(0, Math.min(width, x)) + scroll) / Math.max(1, pixelsPerSecond)))
}
export function waveformPeaks(buffer: AudioBuffer, bins = 160): number[] {
  const peaks: number[] = []
  for (let bin = 0; bin < bins; bin++) {
    const start = Math.floor(bin * buffer.length / bins)
    const end = Math.max(start + 1, Math.floor((bin + 1) * buffer.length / bins))
    let peak = 0
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      const values = buffer.getChannelData(channel)
      for (let i = start; i < Math.min(end, buffer.length); i++) peak = Math.max(peak, Math.abs(values[i]))
    }
    peaks.push(Math.min(1, peak))
  }
  return peaks
}

/** Signed min/max envelope; preserves short peaks without implying RMS levels. */
export function waveformOutline(buffer: AudioBuffer, bins = 512): string {
  const upper: string[] = [], lower: string[] = []
  for (let bin = 0; bin < bins; bin++) {
    const start = Math.floor(bin * buffer.length / bins)
    const end = Math.max(start + 1, Math.floor((bin + 1) * buffer.length / bins))
    let min = 0, max = 0
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const data = buffer.getChannelData(ch)
      for (let i = start; i < Math.min(end, data.length); i++) { min = Math.min(min, data[i]); max = Math.max(max, data[i]) }
    }
    const x = (bin + .5) / bins * 512
    upper.push(`${x},${20 - Math.min(1, max) * 19}`)
    lower.push(`${x},${20 - Math.max(-1, min) * 19}`)
  }
  return `M${upper.join(' L')} L${lower.reverse().join(' L')} Z`
}
export function zoomAtTime(time: number, x: number, zoom: number, width: number, duration: number) {
  return Math.max(0, Math.min(Math.max(0, duration - width / zoom), time - x / zoom))
}
