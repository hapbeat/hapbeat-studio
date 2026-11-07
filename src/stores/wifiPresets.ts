import { create } from 'zustand'

/**
 * Wi-Fi networks saved on this PC, so the Wi-Fi tab can fill the SSID and
 * password with one pick instead of a scan and retyping.
 *
 * Kept in this browser's localStorage, never in the user's folder: a file
 * would be just as readable by Studio's JS, but the chosen folders are often
 * shared (Dropbox, git), and Studio never fully deletes files there (removed
 * files go to `_archive`), so a deleted preset would leave its password
 * behind. Saved only by an explicit user action, and only once a device was
 * seen connecting with it (a mistyped password is never saved). The password
 * is never logged and never shown in the list.
 */

export interface WifiPreset {
  ssid: string
  password: string
  /** Date.now() when it was last saved. */
  savedAt: number
}

export const WIFI_PRESETS_KEY = 'hapbeat-studio-wifi-presets'
export const WIFI_PRESETS_MAX = 10

/** Parse the stored list; anything malformed is dropped, never thrown. */
export function parseWifiPresets(raw: string | null): WifiPreset[] {
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const seen = new Set<string>()
  const out: WifiPreset[] = []
  for (const v of parsed) {
    if (!v || typeof v !== 'object') continue
    const { ssid, password, savedAt } = v as Record<string, unknown>
    if (typeof ssid !== 'string' || ssid.trim() === '' || seen.has(ssid)) continue
    seen.add(ssid)
    out.push({
      ssid,
      password: typeof password === 'string' ? password : '',
      savedAt: typeof savedAt === 'number' && Number.isFinite(savedAt) ? savedAt : 0,
    })
  }
  return out.sort((a, b) => b.savedAt - a.savedAt).slice(0, WIFI_PRESETS_MAX)
}

/** `preset` first, replacing an entry with the same SSID; at most `max`. */
export function addWifiPreset(list: WifiPreset[], preset: WifiPreset, max = WIFI_PRESETS_MAX): WifiPreset[] {
  return [preset, ...list.filter((p) => p.ssid !== preset.ssid)].slice(0, max)
}

/** A write waiting to be seen connected before it is saved here. */
export interface WifiPresetPending {
  ssid: string
  /** Date.now() when set_wifi was sent. */
  at: number
  /** The status object on screen when it was sent (a stale read). */
  baseline: unknown
}

/** Not before this long after set_wifi: a status read sooner may still
 *  describe the previous connection. */
export const PRESET_CONFIRM_MIN_MS = 1500

/** True when `status` is a fresh read showing the device connected to the
 *  pending network, i.e. the password worked and it may be saved here. */
export function confirmsPresetConnection(
  pending: WifiPresetPending,
  status: { connected?: boolean; ssid?: string } | undefined,
  now: number,
): boolean {
  if (!status || status === pending.baseline) return false
  if (now - pending.at < PRESET_CONFIRM_MIN_MS) return false
  return status.connected === true && status.ssid === pending.ssid
}

/** The stored list, or null when this browser has no usable localStorage
 *  (private mode, blocked site data). */
function readStored(): WifiPreset[] | null {
  try {
    return parseWifiPresets(localStorage.getItem(WIFI_PRESETS_KEY))
  } catch {
    return null
  }
}

function writeStored(list: WifiPreset[]): boolean {
  try {
    if (list.length === 0) localStorage.removeItem(WIFI_PRESETS_KEY)
    else localStorage.setItem(WIFI_PRESETS_KEY, JSON.stringify(list))
    return true
  } catch {
    return false  // quota / privacy mode
  }
}

interface WifiPresetsState {
  presets: WifiPreset[]
  /** Save (or refresh) a network. False when this browser cannot store it. */
  remember: (creds: { ssid: string; pass?: string }) => boolean
  remove: (ssid: string) => void
  clear: () => void
}

export const useWifiPresets = create<WifiPresetsState>((set, get) => {
  // What is stored now, not this tab's copy, so a change in another Studio
  // tab is not overwritten; this tab's copy when storage is unusable.
  const current = () => readStored() ?? get().presets
  return {
    presets: readStored() ?? [],
    remember: (creds) => {
      const ssid = creds.ssid.trim()
      if (!ssid) return false
      const next = addWifiPreset(current(), { ssid, password: creds.pass ?? '', savedAt: Date.now() })
      set({ presets: next })
      return writeStored(next)
    },
    remove: (ssid) => {
      const next = current().filter((p) => p.ssid !== ssid)
      set({ presets: next })
      writeStored(next)
    },
    clear: () => {
      set({ presets: [] })
      writeStored([])
    },
  }
})
