/**
 * Where a scene audition stops (the editor playback = the haptic stream, and the Scene video with it): the end of the
 * last sound played + the post-roll (editor setting, default 0 = with the sound), or the end of the longest haptic if
 * later; with no sound, the end of the longest haptic + the post-roll. Seconds of the playback (0 = the first firing).
 * The sounds ring out by themselves after it (FiringScheduler).
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

/** `untilSec`: never before this either (an audition with context runs to the end of the representative stretch). */
export function sceneStopSec(o: { postRollSec: number; sounds: readonly StopPart[]; haptics: readonly StopPart[]; untilSec?: number }): number {
  const postRoll = Math.max(0, o.postRollSec)
  const hapticEnd = Math.max(0, ...o.haptics.map(partEnd))
  const stop = o.sounds.length ? Math.max(Math.max(...o.sounds.map(partEnd)) + postRoll, hapticEnd) : hapticEnd + postRoll
  return Math.max(stop, o.untilSec ?? 0)
}
