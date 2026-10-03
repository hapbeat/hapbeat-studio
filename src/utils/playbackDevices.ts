import type { DeviceInfo } from '@/types/manager'

/**
 * Playback targets shared by every surface that sends haptics (Kit deploy /
 * preview, Waveform editor output). Only receivers (or legacy no-role nodes)
 * play clips: a sensor / broker / transmitter must never receive one.
 */
export const isPlaybackDevice = (device: DeviceInfo) => !device.role || device.role === 'receiver'

/** Connected playback devices, in Helper's order. Offline entries are never targets. */
export const onlinePlaybackDevices = (devices: DeviceInfo[]) => devices.filter(device => device.online && isPlaybackDevice(device))

/** `selectedIps` empty → every connected playback device; otherwise only the selected connected ones. */
export function resolvePlaybackTargets(devices: DeviceInfo[], selectedIps: string[]): DeviceInfo[] {
  const playback = onlinePlaybackDevices(devices)
  if (selectedIps.length === 0) return playback
  const selected = new Set(selectedIps)
  return playback.filter(device => selected.has(device.ipAddress))
}
