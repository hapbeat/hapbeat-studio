import { create } from 'zustand'

const STORAGE_KEY_SELECTED = 'hapbeat-studio-selected-device'

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

  selectDevice: (ip: string | null) => void
  setInfo: (ip: string, info: DeviceState['infoCache'][string]) => void
  setWifiStatus: (ip: string, status: DeviceState['wifiStatusCache'][string]) => void
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

  clearCachesFor: (ip) =>
    set((s) => {
      const info = { ...s.infoCache }
      const wifi = { ...s.wifiStatusCache }
      delete info[ip]
      delete wifi[ip]
      return { infoCache: info, wifiStatusCache: wifi }
    }),
}))
