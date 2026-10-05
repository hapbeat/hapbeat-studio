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

/** The 12 body positions of the device address (contracts specs/device-addressing.md). */
export const BODY_POSITIONS = ['pos_neck', 'pos_chest', 'pos_abd', 'pos_l_arm', 'pos_r_arm', 'pos_l_wrist', 'pos_r_wrist', 'pos_hip', 'pos_l_thigh', 'pos_r_thigh', 'pos_l_ankle', 'pos_r_ankle'] as const

/** The position segment (`pos_…`) of a device address, or null when the device has none (position unknown). */
export const devicePosition = (address: string): string | null => address.split('/').find(seg => seg.startsWith('pos_')) ?? null

/** Positions a cue route's `at` plays on: pos_* as is; `hand` (whichever hand acts) and `both` = both wrists. */
export const atPositions = (at: string): string[] => at === 'hand' || at === 'both' ? ['pos_l_wrist', 'pos_r_wrist'] : [at]

/**
 * Devices an audition goes to: of `devices` (the selected connected ones), those whose address position is one of
 * the cue's route positions (`ats`; every route counts). Devices without a position are left out (`unknown`).
 * `ats` null (no cue: a trial without scene, an editor clip): every device, as selected.
 */
export function routePlaybackTargets(devices: DeviceInfo[], ats: readonly string[] | null): { devices: DeviceInfo[]; unknown: DeviceInfo[]; positions: string[] | null } {
  if (!ats) return { devices, unknown: [], positions: null }
  const positions = [...new Set(ats.flatMap(atPositions))]
  return {
    devices: devices.filter(d => { const p = devicePosition(d.address); return !!p && positions.includes(p) }),
    unknown: devices.filter(d => !devicePosition(d.address)),
    positions,
  }
}
