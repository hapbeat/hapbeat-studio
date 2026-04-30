import { create } from 'zustand'

const STORAGE_KEY_SELECTED = 'hapbeat-studio-selected-device'
const STORAGE_KEY_SELECTED_SET = 'hapbeat-studio-selected-devices'
const STORAGE_KEY_DISMISSED = 'hapbeat-studio-dismissed-devices'

export interface WifiProfile {
  index: number
  ssid: string
  pass?: string
  active?: boolean
}

interface DeviceState {
  /** IP of the device currently focused in the Devices pane.
   *  Mirrors the most-recently-checked entry from `selectedIps` so
   *  detail-pane consumers can keep using a single primary IP. */
  selectedIp: string | null

  /** Multi-select set — every IP the user has ticked in the sidebar.
   *  Manager parity: clicking a card toggles its checkbox here, and
   *  batch operations (broadcast PLAY ALL, etc.) target all of them. */
  selectedIps: string[]

  /** Client-side dismissed list for offline cards. The × button on
   *  an offline card adds the IP here; the sidebar then hides that
   *  card. Auto-cleared when the device comes back online (helper
   *  push reports `online: true`) so users don't have to manually
   *  un-dismiss after a reboot. Persisted across reloads. */
  dismissedIps: string[]

  /** Per-IP cache of the most recent get_info response. */
  infoCache: Record<string, {
    name?: string
    mac?: string
    fw?: string
    group?: number
    wifi_connected?: boolean
  }>

  /** Per-IP cache of the most recent get_wifi_status response. */
  wifiStatusCache: Record<string, {
    connected?: boolean
    ssid?: string
    ip?: string
    rssi?: number
    channel?: number
  }>

  /** Per-IP cache of the most recent list_wifi_profiles response. */
  wifiProfilesCache: Record<string, {
    profiles: WifiProfile[]
    count: number
    max: number
  }>

  /** Per-IP cache of the most recent get_debug_dump response. */
  debugDumpCache: Record<string, Record<string, unknown>>

  /** Per-IP cache of the most recent kit_list response.
   *  Firmware ≥ 2026-04-29 reports events as `{name, mode}` so the
   *  UI can split FIRE vs CLIP. Older builds emit plain strings,
   *  which the consuming component treats as command/FIRE mode. */
  kitListCache: Record<string, Array<{
    kit_id: string
    version?: string
    events?: Array<string | { name: string; mode?: string }>
  }>>

  selectDevice: (ip: string | null) => void
  toggleSelect: (ip: string) => void
  dismissDevice: (ip: string) => void
  /** Helper-driven housekeeping: every push of the device list calls
   *  this so dismissed-but-now-online IPs un-dismiss themselves. Idempotent. */
  syncOnlineDevices: (onlineIps: string[]) => void
  setInfo: (ip: string, info: DeviceState['infoCache'][string]) => void
  setWifiStatus: (ip: string, status: DeviceState['wifiStatusCache'][string]) => void
  setWifiProfiles: (ip: string, profiles: WifiProfile[], count: number, max: number) => void
  setDebugDump: (ip: string, dump: Record<string, unknown>) => void
  setKitList: (ip: string, kits: DeviceState['kitListCache'][string]) => void
  clearCachesFor: (ip: string) => void
}

const initialSelected = (() => {
  try {
    return localStorage.getItem(STORAGE_KEY_SELECTED) || null
  } catch {
    return null
  }
})()

const readJsonArray = (key: string): string[] => {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return []
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((s): s is string => typeof s === 'string') : []
  } catch {
    return []
  }
}

const initialSelectedIps = (() => {
  const arr = readJsonArray(STORAGE_KEY_SELECTED_SET)
  // Backward compat: if a legacy single `selectedIp` exists but the
  // multi-select array doesn't, promote it.
  if (arr.length === 0 && initialSelected) return [initialSelected]
  return arr
})()

const initialDismissed = readJsonArray(STORAGE_KEY_DISMISSED)

const persist = (key: string, value: string[] | string | null) => {
  try {
    if (value == null) {
      localStorage.removeItem(key)
    } else if (Array.isArray(value)) {
      localStorage.setItem(key, JSON.stringify(value))
    } else {
      localStorage.setItem(key, value)
    }
  } catch {
    /* ignore quota / privacy-mode failures */
  }
}

export const useDeviceStore = create<DeviceState>((set) => ({
  selectedIp: initialSelected,
  selectedIps: initialSelectedIps,
  dismissedIps: initialDismissed,
  infoCache: {},
  wifiStatusCache: {},
  wifiProfilesCache: {},
  debugDumpCache: {},
  kitListCache: {},

  selectDevice: (ip) => {
    persist(STORAGE_KEY_SELECTED, ip)
    set((s) => {
      const next = new Set(s.selectedIps)
      if (ip) next.add(ip)
      const arr = [...next]
      persist(STORAGE_KEY_SELECTED_SET, arr)
      return { selectedIp: ip, selectedIps: arr }
    })
  },

  /**
   * Toggle one IP in the selected set. Manager-style: clicking a card
   * inverts its checkbox state. The detail-pane "primary" (`selectedIp`)
   * auto-syncs to whichever IP was just toggled on, or to the first
   * remaining one when the toggle was a removal.
   */
  toggleSelect: (ip) =>
    set((s) => {
      const set_ = new Set(s.selectedIps)
      let primary: string | null
      if (set_.has(ip)) {
        set_.delete(ip)
        primary = s.selectedIp === ip
          ? (set_.size > 0 ? set_.values().next().value ?? null : null)
          : s.selectedIp
      } else {
        set_.add(ip)
        // The newly-checked IP becomes the focused detail target so
        // the right pane updates immediately.
        primary = ip
      }
      const arr = [...set_]
      persist(STORAGE_KEY_SELECTED_SET, arr)
      persist(STORAGE_KEY_SELECTED, primary)
      return { selectedIps: arr, selectedIp: primary }
    }),

  /** Hide an offline card. Persisted; cleared when the IP comes back online. */
  dismissDevice: (ip) =>
    set((s) => {
      if (s.dismissedIps.includes(ip)) return {}
      const arr = [...s.dismissedIps, ip]
      persist(STORAGE_KEY_DISMISSED, arr)
      // Also drop it from the selected set — a card that the user
      // explicitly dismissed shouldn't keep contributing to broadcast
      // ops just because the box was checked before.
      const sel = new Set(s.selectedIps)
      sel.delete(ip)
      const selArr = [...sel]
      persist(STORAGE_KEY_SELECTED_SET, selArr)
      const primary = s.selectedIp === ip
        ? (selArr[0] ?? null)
        : s.selectedIp
      persist(STORAGE_KEY_SELECTED, primary)
      return {
        dismissedIps: arr,
        selectedIps: selArr,
        selectedIp: primary,
      }
    }),

  /**
   * Helper push reports the live online set. Use it to auto-undismiss
   * any IP that came back online — otherwise a user who dismissed a
   * device would have to know to manually re-add it after the device
   * reboots, which Manager users would never expect.
   */
  syncOnlineDevices: (onlineIps) =>
    set((s) => {
      if (s.dismissedIps.length === 0) return {}
      const filtered = s.dismissedIps.filter((ip) => !onlineIps.includes(ip))
      if (filtered.length === s.dismissedIps.length) return {}
      persist(STORAGE_KEY_DISMISSED, filtered)
      return { dismissedIps: filtered }
    }),

  setInfo: (ip, info) =>
    set((s) => ({ infoCache: { ...s.infoCache, [ip]: { ...s.infoCache[ip], ...info } } })),

  setWifiStatus: (ip, status) =>
    set((s) => ({
      wifiStatusCache: {
        ...s.wifiStatusCache,
        [ip]: { ...s.wifiStatusCache[ip], ...status },
      },
    })),

  setWifiProfiles: (ip, profiles, count, max) =>
    set((s) => ({
      wifiProfilesCache: {
        ...s.wifiProfilesCache,
        [ip]: { profiles, count, max },
      },
    })),

  setDebugDump: (ip, dump) =>
    set((s) => ({ debugDumpCache: { ...s.debugDumpCache, [ip]: dump } })),

  setKitList: (ip, kits) =>
    set((s) => ({ kitListCache: { ...s.kitListCache, [ip]: kits } })),

  clearCachesFor: (ip) =>
    set((s) => {
      const info = { ...s.infoCache }
      const wifi = { ...s.wifiStatusCache }
      const profiles = { ...s.wifiProfilesCache }
      const dump = { ...s.debugDumpCache }
      const kits = { ...s.kitListCache }
      delete info[ip]
      delete wifi[ip]
      delete profiles[ip]
      delete dump[ip]
      delete kits[ip]
      return {
        infoCache: info,
        wifiStatusCache: wifi,
        wifiProfilesCache: profiles,
        debugDumpCache: dump,
        kitListCache: kits,
      }
    }),
}))
