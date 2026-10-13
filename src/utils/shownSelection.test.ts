import { describe, expect, it } from 'vitest'
import type { WaveformRegion } from '@/types/waveform'
import { selectionAfterShow } from './shownSelection'

/** What waveformStore.setSelectedRegion keeps for a buffer of `duration` (cut to its length). */
const store = (region: WaveformRegion | null, duration: number) => region && { start: Math.min(region.start, duration), end: Math.min(region.end, duration) }

describe('selection when the waveform shows another file', () => {
  it('stepping through files of different lengths always plays each one whole (a short file on the way cuts nothing after it)', () => {
    const files = [['material A', 0.5], ['material B', 0.078], ['candidate C', 1.2], ['material D', 0.3], ['candidate E', 2.4]] as const
    let shown: string = files[0][0]
    let selection: WaveformRegion | null = { start: 0, end: files[0][1] }
    for (const [item, duration] of files.slice(1)) {
      selection = store(selectionAfterShow(selection, item === shown, duration), duration)
      shown = item
      expect([item, selection]).toEqual([item, { start: 0, end: duration }])
    }
  })

  it('the same item drawn again keeps its range, cut to the new length; no selection stays none', () => {
    const range = { start: 0.1, end: 0.9 }
    expect(store(selectionAfterShow(range, true, 0.5), 0.5)).toEqual({ start: 0.1, end: 0.5 }) // a chain made it shorter
    expect(selectionAfterShow(range, true, 2)).toEqual(range)
    expect(selectionAfterShow(null, false, 1)).toBeNull()
  })
})
