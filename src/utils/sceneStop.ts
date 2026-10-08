/**
 * Where a scene audition stops (the editor playback = the haptic stream, and the Scene video with it): never before
 * the last firing + the post-roll (editor setting), the end of the longest sound played or the end of the longest
 * haptic. Seconds of the playback (0 = the first firing). The sounds ring out by themselves after it (FiringScheduler).
 */
export interface StopPart {
  /** Start (seconds of the playback). */
  atSec: number
  /** The material's own length (seconds). */
  durSec: number
  /** Playback rate (1 = as recorded; 2 = twice as fast, half as long). */
  rate?: number
}

const partEnd = (p: StopPart) => p.atSec + p.durSec / (p.rate && p.rate > 0 ? p.rate : 1)

export function sceneStopSec(o: { firings: readonly number[]; postRollSec: number; sounds: readonly StopPart[]; haptics: readonly StopPart[] }): number {
  const last = Math.max(0, ...o.firings)
  return Math.max(last + Math.max(0, o.postRollSec), ...o.sounds.map(partEnd), ...o.haptics.map(partEnd))
}
