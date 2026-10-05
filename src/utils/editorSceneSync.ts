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
