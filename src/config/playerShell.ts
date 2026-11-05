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

export interface PlayerInfo {
  appVersion: string
  /** The Studio build the app bundles. */
  studio: string
  helperBundled: boolean
  /** The project the app bundles. */
  project: string
  builtAt: string
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
