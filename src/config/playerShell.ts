/**
 * Hapbeat Player (Windows; a standalone app that plays a haptic video project).
 *
 * The app serves this same Studio build from inside its installer and marks the URL
 * with `?shell=player`; `?shell=player&haptics=off` keeps it from sending haptics. Its
 * preload adds `window.hapbeatPlayer` (the bundled helper, the project folder). Studio then
 * renders only the player (components/player), reading the project folder the user chose
 * in the app under `/__project/` (utils/appProject): the folder Studio's Scene tab saves
 * into, so its edits reach the player as soon as they are saved. The normal Studio never
 * enters this mode.
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
  builtAt: string | null
}

/** The project folder the app plays (one on disk, the same one Studio's Scene tab opens). */
export interface PlayerProject {
  /** The folder's name. */
  name: string
  path: string
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
  /** (apiVersion 2) The project folder, served under `/__project/` (utils/appProject). */
  project: {
    /** The folder the app plays now; null before one was chosen. */
    current(): Promise<PlayerProject | null>
    /** Opens the folder dialog: null when cancelled; rejects (with the reason) when the folder is not a project. */
    choose(): Promise<PlayerProject | null>
    /** After every successful choice (this page's or the app menu's): the page opens the project on this only. */
    onSwitched(callback: (project: PlayerProject) => void): () => void
    /** Files of the folder changed on disk (Studio saved), shortly after (paths relative, possibly none). */
    onChanged(callback: (change: { paths: string[] }) => void): () => void
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

/**
 * `helperPort=<n>` (player only): the helper's port when the app runs its helper apart from 7703 (the app's checks put
 * their stand-in helper there, next to a helper the user has running). null = the usual 7703.
 */
export const PLAYER_HELPER_PORT: number | null = (() => {
  if (!IS_PLAYER_SHELL) return null
  const port = Number(queryParam('helperPort'))
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : null
})()
