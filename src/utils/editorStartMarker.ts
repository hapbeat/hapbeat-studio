import { create } from 'zustand'

/**
 * Playback start chosen by a plain click on the waveform (no range). It stays
 * visible after playing, and Stop / a new play return to it. A range selection
 * takes precedence; the marker is cleared when the shown audio changes.
 */
export const useStartMarker = create<{ start: number | null; set: (start: number | null) => void }>(set => ({
  start: null,
  set: start => set({ start }),
}))

/** Where play starts and Stop rewinds to: the range start, else the marker, else 0. */
export function playStart(selection: { start: number } | null, marker: number | null): number {
  return selection ? selection.start : marker ?? 0
}
