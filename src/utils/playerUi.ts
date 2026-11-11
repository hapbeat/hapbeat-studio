import type { PlayerUiMode } from '@/config/playerShell'
import type { CueTable } from './sceneCueTable'
import { matchesAddress, tableTargets } from './sceneHaptics'

/**
 * Whether the player's idle timer hides the controls (and the cursor): always in `hide`, never in `show`; in `auto`
 * while the video plays or the window is fullscreen (paused too: a display showing a demo), unless a mouse rests over
 * the controls (a touch pointer has no hover, so a tap never keeps them).
 */
export function idleHidesControls(mode: PlayerUiMode, state: { playing: boolean; fullscreen: boolean; hovered: boolean }): boolean {
  if (mode === 'hide') return true
  if (mode === 'show') return false
  return !state.hovered && (state.playing || state.fullscreen)
}

/**
 * Whether a press on the player only brings the controls back: in `auto`, while idling has hidden them. That press (and
 * the click it ends in) does not play or pause, so a click or a first tap to see the controls never stops the video.
 * In `hide` the controls never show, so a press acts at once.
 */
export const pressOnlyShowsControls = (mode: PlayerUiMode, controlsHidden: boolean) => mode === 'auto' && controlsHidden

/**
 * Whether the player sends every route to every Hapbeat (the Scene's allDevices): only when no playing Hapbeat's address
 * is at a position the cue table routes to (one Hapbeat at a position the table does not use, none, no table), so a demo
 * never goes silent. Once one is, every route plays by position, as in the game (a neck and a wrist each get their own).
 */
export function playerPlaysAllDevices(table: CueTable | null, addresses: string[]): boolean {
  if (!table) return true
  const targets = tableTargets(table)
  return !addresses.some(address => address && targets.some(target => matchesAddress(target, address)))
}
