/**
 * Hapbeat Studio desktop app (Windows; repo hapbeat-studio-desktop).
 *
 * The app shows this same online Studio in its window, so a Studio deploy reaches
 * it without reinstalling. It marks the URL with `?shell=desktop` and its preload
 * adds `window.hapbeatDesktop` (the bundled helper, app updates). Studio then shows
 * the desktop layout: Kit / UI / Manage only, Manage without the test and bench
 * tabs, and the app panel instead of the pipx instructions. "Show all features" in
 * that panel brings back the full Studio.
 */
import { create } from 'zustand'

export type DesktopHelperState = 'starting' | 'running' | 'external' | 'stopped' | 'crashed' | 'missing'

export interface DesktopHelperStatus {
  state: DesktopHelperState
  /** 'bundled' = the app's own helper; 'external' = one that was already running (e.g. pipx). */
  source: 'bundled' | 'external' | null
  version: string | null
  port: number
  error: string | null
}

export interface DesktopUpdateResult {
  state: 'dev' | 'none' | 'downloading' | 'downloaded' | 'error'
  version?: string
  error?: string
}

/** Where the app's Studio page came from (apiVersion 3). */
export interface DesktopStudioStatus {
  /** 'offline': no network answered, so the page is the app's saved copy of Studio. */
  mode: 'online' | 'offline'
  /** The copy kept for offline use: saved after an online launch, or shipped in the installer. */
  copy: { id: string; savedAt: string | null; source: 'saved' | 'bundled' } | null
}

export interface HapbeatDesktopApi {
  shell: 'electron'
  /** Raised by the app when this API changes; check it before using calls added later. */
  apiVersion?: number
  /**
   * (apiVersion 2, Windows) getDisplayMedia from a click returns what the PC plays,
   * without a picker: PC sound → Hapbeat (`systemAudioCapture`).
   */
  systemAudio?: boolean
  getInfo(): Promise<{ appVersion: string; platform: string; helper: DesktopHelperStatus; studio?: DesktopStudioStatus }>
  helper: {
    status(): Promise<DesktopHelperStatus>
    restart(): Promise<DesktopHelperStatus>
    openLogFolder(): Promise<string>
    onStatus(callback: (status: DesktopHelperStatus) => void): () => void
  }
  /** (apiVersion 3) Online page or the saved copy; absent in older apps. */
  studio?: {
    status(): Promise<DesktopStudioStatus>
    onStatus(callback: (status: DesktopStudioStatus) => void): () => void
  }
  checkForUpdates(): Promise<DesktopUpdateResult>
}

declare global {
  interface Window {
    hapbeatDesktop?: HapbeatDesktopApi
  }
}

/** The app's API, or null in a browser (including a browser opened with `?shell=desktop`). */
export function desktopApi(): HapbeatDesktopApi | null {
  return typeof window === 'undefined' ? null : window.hapbeatDesktop ?? null
}

/** The app can hand Studio what the PC plays (Windows app, apiVersion 2 and later). */
export function desktopSystemAudio(): boolean {
  return desktopApi()?.systemAudio === true
}

function detectDesktopShell(): boolean {
  if (typeof window === 'undefined') return false
  if (window.hapbeatDesktop) return true
  try {
    return new URLSearchParams(window.location.search).get('shell') === 'desktop'
  } catch {
    return false
  }
}

/** Inside the desktop app (or a browser testing its layout with `?shell=desktop`). Fixed for the page's life. */
export const IS_DESKTOP_SHELL = detectDesktopShell()

const FULL_UI_KEY = 'hapbeat-studio-desktop-full-ui'

function readFullUi(): boolean {
  try {
    return localStorage.getItem(FULL_UI_KEY) === '1'
  } catch {
    return false
  }
}

interface DesktopUiState {
  /** "Show all features" in the app panel. */
  fullUi: boolean
  setFullUi(fullUi: boolean): void
}

export const useDesktopUi = create<DesktopUiState>((set) => ({
  fullUi: readFullUi(),
  setFullUi: (fullUi) => {
    try {
      localStorage.setItem(FULL_UI_KEY, fullUi ? '1' : '0')
    } catch {
      /* preference only */
    }
    set({ fullUi })
  },
}))

/** True when the simple desktop layout applies. The browser Studio always shows everything. */
export function isSimpleUi(desktopShell: boolean, fullUi: boolean): boolean {
  return desktopShell && !fullUi
}

export function useSimpleUi(): boolean {
  const fullUi = useDesktopUi((s) => s.fullUi)
  return isSimpleUi(IS_DESKTOP_SHELL, fullUi)
}

/** Top tabs of the simple layout: Kit, UI (display) and Manage (devices). */
export const SIMPLE_TABS: readonly string[] = ['kit', 'display', 'devices']

/** Manage sub-tabs the simple layout leaves out: playback / command tests and the bench-only PWM tab. */
export const SIMPLE_HIDDEN_SUBTABS: ReadonlySet<string> = new Set(['test', 'pwm'])

export function visibleTabs<T extends string>(all: readonly T[], simple: boolean): T[] {
  return simple ? all.filter((tab) => SIMPLE_TABS.includes(tab)) : [...all]
}

export function visibleSubTabs<T extends string>(all: readonly T[], simple: boolean): T[] {
  return simple ? all.filter((tab) => !SIMPLE_HIDDEN_SUBTABS.has(tab)) : [...all]
}
