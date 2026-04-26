import { create } from 'zustand'

const STORAGE_KEY_SELECTED = 'hapbeat-studio-selected-device'

export interface WifiProfile {
  index: number
  ssid: string
  pass?: string
  active?: boolean
}

interface DeviceState {
  /** IP of the device currently focused in the Devices pane. */
  selectedIp: string | null

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

  /** Per-IP cache of the most recent kit_list response. */
  kitListCache: Record<string, Array<{
    kit_id: string
    version?: string
    events?: string[]
  }>>

  selectDevice: (ip: string | null) => void
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

export const useDeviceStore = create<DeviceState>((set) => ({
  selectedIp: initialSelected,
  infoCache: {},
  wifiStatusCache: {},
  wifiProfilesCache: {},
  debugDumpCache: {},
  kitListCache: {},

  selectDevice: (ip) => {
    try {
      if (ip) localStorage.setItem(STORAGE_KEY_SELECTED, ip)
      else localStorage.removeItem(STORAGE_KEY_SELECTED)
    } catch {
      /* ignore quota / privacy-mode failures */
    }
    set({ selectedIp: ip })
  },

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
