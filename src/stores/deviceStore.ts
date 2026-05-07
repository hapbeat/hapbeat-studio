import { create } from 'zustand'

const STORAGE_KEY_SELECTED = 'hapbeat-studio-selected-device'
const STORAGE_KEY_SELECTED_SET = 'hapbeat-studio-selected-devices'
const STORAGE_KEY_DISMISSED = 'hapbeat-studio-dismissed-devices'
const STORAGE_KEY_LAST_FLASHED_BOARD = 'hapbeat-studio-last-flashed-board'

export interface WifiProfile {
  index: number
  ssid: string
  /** パスワードは write-only: firmware は読み出しを許可しない。
   *  パスワードが設定済みかどうかのフラグのみ受け取る。 */
  has_pass?: boolean
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
    /**
     * Hardware board ID reported by the device firmware
     * (e.g. `band_wl_v3`, `band_wl_v4`, `duo_wl_v3`). Used by the
     * Firmware sub-tab to pre-check that the user-selected build
     * matches the physical board before flashing.
     */
    board?: string
    /** Current Wi-Fi mode: "sta" (normal) or "ap" (SoftAP). Added in firmware v0.1.0. */
    mode?: 'sta' | 'ap'
    /** AP mode info — present only when mode === "ap" */
    ap_ssid?: string
    ap_ip?: string
    ap_has_pass?: boolean
    ap_client_count?: number
    /** OLED brightness (1=low / 2=mid / 3=high). Firmware ≥ v0.1.x. */
    oled_brightness?: number
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
  /** Drop selection entries that no longer correspond to any *known*
   *  device (i.e. the helper's mDNS list never returned this IP this
   *  session). Use to clean up stale persisted IPs from previous
   *  Studio sessions — e.g. a device whose DHCP lease changed leaves
   *  the old IP in localStorage as a phantom "選択済". Idempotent. */
  pruneSelectionsToKnown: (knownIps: string[]) => void
  setInfo: (ip: string, info: DeviceState['infoCache'][string]) => void
  /** Merge AP status into infoCache (from get_ap_status or get_info extension). */
  setApStatus: (ip: string, status: {
    mode?: 'sta' | 'ap'
    ap_ssid?: string
    ap_ip?: string
    ap_has_pass?: boolean
    ap_client_count?: number
  }) => void
  /**
   * Drop the cached `board` for an IP. Called immediately after a
   * successful flash: the binary just written may target a different
   * BOARD_ID than what the device used to report. Clearing forces the
   * next pre-flight check to skip board comparison (rather than fire
   * a stale-data mismatch) until DeviceDetail re-queries get_info on
   * the post-reboot online transition and writes the fresh value.
   */
  invalidateBoard: (ip: string) => void

  /**
   * Record the BOARD_ID expected by the most recently flashed env on
   * this device. Used as a fallback for `checkBoardMatch` when the
   * device hasn't yet replied to get_info (first session, post-flash
   * before reboot, etc), so the warning is symmetric across flashes.
   * Persisted in localStorage so it survives a page reload.
   */
  lastFlashedBoard: Record<string, string>
  setLastFlashedBoard: (ip: string, board: string) => void
  setWifiStatus: (ip: string, status: DeviceState['wifiStatusCache'][string]) => void
  setWifiProfiles: (ip: string, profiles: WifiProfile[], count: number, max: number) => void
  setDebugDump: (ip: string, dump: Record<string, unknown>) => void
  setKitList: (ip: string, kits: DeviceState['kitListCache'][string]) => void
  clearCachesFor: (ip: string) => void
}

// Serial pseudo-device entries (`serial:<mac>`) are inherently bound to
// the *current* USB connection and don't survive a Studio reload —
// reusing a stale `serial:` IP after the cable is gone produces ghost
// "N 台選択" counts and noisy "Serial をスキップ" toasts on deploy.
// Filter them at hydration so persisted state only carries LAN IPs.
const isSerialId = (s: string): boolean => s.startsWith('serial:')

const initialSelected = (() => {
  try {
    const v = localStorage.getItem(STORAGE_KEY_SELECTED)
    return v && !isSerialId(v) ? v : null
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
  const arr = readJsonArray(STORAGE_KEY_SELECTED_SET).filter((s) => !isSerialId(s))
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

// Hydrate the per-IP last-flashed-board map from localStorage so the
// pre-flight comparison survives a Studio reload.
const initialLastFlashedBoard: Record<string, string> = (() => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_LAST_FLASHED_BOARD)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Record<string, string> = {}
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'string') out[k] = v
      }
      return out
    }
    return {}
  } catch {
    return {}
  }
})()

export const useDeviceStore = create<DeviceState>((set) => ({
  selectedIp: initialSelected,
  selectedIps: initialSelectedIps,
  dismissedIps: initialDismissed,
  infoCache: {},
  wifiStatusCache: {},
  wifiProfilesCache: {},
  debugDumpCache: {},
  kitListCache: {},
  lastFlashedBoard: initialLastFlashedBoard,

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

  pruneSelectionsToKnown: (knownIps) =>
    set((s) => {
      // serial: は USB に紐付いた揮発エントリで knownIps とは別系統で
      // 管理されるため (DeviceList 側の serialDevice 合流) ここでは
      // ふるい落とさない。LAN IP だけを対象に絞る。
      const known = new Set(knownIps)
      const isStale = (ip: string) => !ip.startsWith('serial:') && !known.has(ip)
      const nextSelectedIps = s.selectedIps.filter((ip) => !isStale(ip))
      const nextSelectedIp = s.selectedIp && isStale(s.selectedIp) ? null : s.selectedIp
      const setChanged = nextSelectedIps.length !== s.selectedIps.length
      const primaryChanged = nextSelectedIp !== s.selectedIp
      if (!setChanged && !primaryChanged) return {}
      if (setChanged) persist(STORAGE_KEY_SELECTED_SET, nextSelectedIps)
      if (primaryChanged) persist(STORAGE_KEY_SELECTED, nextSelectedIp)
      return { selectedIps: nextSelectedIps, selectedIp: nextSelectedIp }
    }),

  setInfo: (ip, info) =>
    set((s) => ({ infoCache: { ...s.infoCache, [ip]: { ...s.infoCache[ip], ...info } } })),

  setApStatus: (ip, status) =>
    set((s) => ({ infoCache: { ...s.infoCache, [ip]: { ...s.infoCache[ip], ...status } } })),

  invalidateBoard: (ip) =>
    set((s) => {
      const cur = s.infoCache[ip]
      if (!cur || cur.board === undefined) return {}
      const { board: _drop, ...rest } = cur
      void _drop
      return { infoCache: { ...s.infoCache, [ip]: rest } }
    }),

  setLastFlashedBoard: (ip, board) =>
    set((s) => {
      const next = { ...s.lastFlashedBoard, [ip]: board }
      try {
        localStorage.setItem(STORAGE_KEY_LAST_FLASHED_BOARD, JSON.stringify(next))
      } catch { /* quota / privacy mode */ }
      return { lastFlashedBoard: next }
    }),

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
