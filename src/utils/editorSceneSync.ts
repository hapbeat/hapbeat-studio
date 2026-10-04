import type { PlaybackPreRoll } from './editorPlayback'

/**
 * The editor's Scene video panel registers its pre-roll here while it is
 * synced to an audition; the editor playback reads it at every play.
 */
let current: PlaybackPreRoll | null = null
export function setScenePreRoll(preRoll: PlaybackPreRoll | null) { current = preRoll }
export function scenePreRoll(): PlaybackPreRoll | null { return current }
