/**
 * Hapbeat Player (Windows; a standalone app that plays one haptic video project).
 *
 * The app serves this same Studio build from inside its installer and marks the URL
 * with `?shell=player`; `?shell=player&haptics=off` keeps it from sending haptics. Its
 * preload adds `window.hapbeatPlayer` (the bundled helper). Studio then renders only
 * the player (components/player), reading the project the app bundles under
 * `/__project/` (utils/bundledProject). The normal Studio never enters this mode.
 */
import type { DesktopHelperStatus } from './desktopShell'

export type PlayerHelperStatus = DesktopHelperStatus

/** What the app was built from (its build-info.json); null when the app could not read it. */
export interface PlayerInfo {
  appVersion: string
  /** The Studio build the app bundles. */
  studio: { sha: string; version: string } | null
  /** The bundled helper's `version` output, e.g. "hapbeat-helper 1.0.0". */
  helperBundled: string | null
  /** The project the app bundles: its commit (with -dirty for uncommitted data). */
  project: string | null
  builtAt: string | null
}

export interface HapbeatPlayerApi {
  /** Raised by the app when this API changes. */
  apiVersion: number
  getInfo(): Promise<PlayerInfo>
  helper: {
    status(): Promise<PlayerHelperStatus>
    restart(): Promise<PlayerHelperStatus>
    onStatus(callback: (status: PlayerHelperStatus) => void): () => void
  }
  /**
   * Called when the window is minimized. The app keeps the page "visible" (no background throttling, so playback
   * keeps its timing behind other windows), so the page cannot tell by itself.
   */
  onMinimize(callback: () => void): () => void
}

declare global {
  interface Window {
    hapbeatPlayer?: HapbeatPlayerApi
  }
}

/** The app's API, or null in a browser (including a browser opened with `?shell=player`). */
export function playerApi(): HapbeatPlayerApi | null {
  return typeof window === 'undefined' ? null : window.hapbeatPlayer ?? null
}

function queryParam(name: string): string | null {
  if (typeof window === 'undefined') return null
  try {
    return new URLSearchParams(window.location.search).get(name)
  } catch {
    return null
  }
}

/** Inside the player app (or a browser testing it with `?shell=player`). Fixed for the page's life. */
export const IS_PLAYER_SHELL = queryParam('shell') === 'player'

/** `haptics=off`: the player never sends haptics and its haptics toggle stays disabled. */
export const PLAYER_HAPTICS_OFF = queryParam('haptics') === 'off'

/**
 * `helperPort=<n>` (player only): the helper's port when the app runs its helper apart from 7703 (the app's checks put
 * their stand-in helper there, next to a helper the user has running). null = the usual 7703.
 */
export const PLAYER_HELPER_PORT: number | null = (() => {
  if (!IS_PLAYER_SHELL) return null
  const port = Number(queryParam('helperPort'))
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : null
})()
