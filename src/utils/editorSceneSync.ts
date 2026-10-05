import { create } from 'zustand'
import type { PlaybackPreRoll } from './editorPlayback'

/**
 * The editor's Scene video panel registers its pre-roll here while it is
 * synced to the editor playback; the editor playback reads it at every play.
 * It applies only while `active()` (the panel has focus: play "from the video");
 * with the waveform focused, playback starts at once and the video from the mark.
 */
export interface ScenePreRoll extends PlaybackPreRoll { active: () => boolean }
let current: ScenePreRoll | null = null
export function setScenePreRoll(preRoll: ScenePreRoll | null) { current = preRoll }
export function scenePreRoll(): PlaybackPreRoll | null { return current && current.active() ? current : null }

/**
 * Pause / resume of the synced Scene video panel. Space with the panel focused (or while it is
 * paused) toggles it, and a plain waveform click while paused only seeks (video and waveform stay together).
 */
export interface ScenePause { paused: () => boolean; toggle: () => void }
let pause: ScenePause | null = null
export function setScenePause(control: ScenePause | null) { pause = control }
export function scenePause(): ScenePause | null { return pause }

/**
 * What the Scene video panel shows when no AI candidate is auditioned (an
 * audition always shows its trial): the trial whose "▶ Video" was pressed,
 * the selected clip (Properties "▶ Video") or the event selected in the Events panel.
 */
export type SceneVideoTarget = { kind: 'trial'; trialId: string } | { kind: 'clip' } | { kind: 'event'; key: string }
export const useSceneVideoTarget = create<{ target: SceneVideoTarget; setTarget: (target: SceneVideoTarget) => void }>(set => ({
  target: { kind: 'clip' },
  setTarget: target => set({ target }),
}))

/** One video frame (the recordings are 30 fps): the most the video may be off the playback. */
export const FRAME_SEC = 1 / 30
/** Beyond this the video is moved (seek); within it the speed is nudged so the picture does not jump. */
const SEEK_OVER_SEC = 0.25
/** How strongly the speed corrects (per second of error); kept within ±25 %. */
const RATE_GAIN = 4
/**
 * Keeps the Scene video on the playback clock (the editor player = the sounds and the haptic stream): the video
 * lags after a seek (decoding) and after the lead-in timer, so it is corrected all along, not only at play.
 * `videoTime` / `expected`: where the video is / should be. Returns a seek (or null) and the playback rate to use.
 */
export function videoCorrection(videoTime: number, expected: number): { seek: number | null; rate: number } {
  const diff = videoTime - expected
  if (Math.abs(diff) > SEEK_OVER_SEC) return { seek: expected, rate: 1 }
  if (Math.abs(diff) <= FRAME_SEC / 4) return { seek: null, rate: 1 }
  return { seek: null, rate: Math.max(0.75, Math.min(1.25, 1 - diff * RATE_GAIN)) }
}
