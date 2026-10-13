import type { WaveformRegion } from '@/types/waveform'

/**
 * The waveform selection (the play range) after the waveform panel shows a new buffer. Another item (an AI candidate,
 * an event material or a clip reached by ↑/↓ or a click) starts from its whole length — a range never carries over
 * from one file to another, so a short file shown on the way cannot cut the longer ones after it. The same item
 * drawn again (an applied chain, Edited / Original) keeps its range (the store cuts it to the new length).
 * No selection stays none (playback then covers the whole buffer anyway).
 */
export function selectionAfterShow(selection: WaveformRegion | null, sameItem: boolean, duration: number): WaveformRegion | null {
  if (!selection) return null
  return sameItem ? selection : { start: 0, end: duration }
}
