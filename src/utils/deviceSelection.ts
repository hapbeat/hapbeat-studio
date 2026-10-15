import type { DeviceInfo } from '@/types/manager'
import type { SerialDeviceInfo, SerialPortEntry } from '@/stores/serialMaster'
import { isKnownNonHapbeatBoard } from './hapbeatBoard'

/**
 * Pure helpers behind the cross-tab device selection (owner 2026-10-15):
 *   - the next tab inherits the previous tab's selection instead of starting
 *     from its own stale one;
 *   - when exactly one Hapbeat is connected (USB or Wi-Fi) it is selected by
 *     default.
 * The stores call these with plain snapshots so the rules stay testable
 * without React or Web Serial.
 */

/** Board / MAC facts per LAN IP — the subset of deviceStore.infoCache used here. */
export type LanInfo = Record<string, { board?: string; mac?: string } | undefined>

const normMac = (mac?: string): string => (mac ?? '').toLowerCase().replace(/[^0-9a-f]/g, '')

/** True when the `get_info` IP is a usable station address (not AP-mode / unset). */
const isUsableIp = (ip?: string): ip is string => !!ip && ip !== '0.0.0.0'

/**
 * The Wi-Fi (LAN) IP of the device behind a USB card, if that same device is
 * also on the LAN. Matched by the IP the device reports over USB (`wifi_ip`),
 * falling back to the MAC against the LAN `get_info` cache. Only IPs in
 * `lanIps` (what Helper currently lists) are returned.
 */
export function lanIpForUsbEntry(
  entry: Pick<SerialPortEntry, 'info'>,
  lanIps: ReadonlySet<string>,
  lanInfo: LanInfo,
): string | null {
  const info = entry.info
  if (!info) return null
  if (isUsableIp(info.wifi_ip) && lanIps.has(info.wifi_ip)) return info.wifi_ip
  const mac = normMac(info.mac)
  if (!mac) return null
  for (const ip of lanIps) {
    if (normMac(lanInfo[ip]?.mac) === mac) return ip
  }
  return null
}

/**
 * Same as {@link lanIpForUsbEntry} for a `serial:<mac>` pseudo-device id (the
 * id the Manage detail pane uses for the USB config connection).
 */
export function lanIpForSerialId(
  serialId: string,
  usbPorts: ReadonlyArray<Pick<SerialPortEntry, 'info'>>,
  lanIps: ReadonlySet<string>,
  lanInfo: LanInfo,
): string | null {
  const mac = normMac(serialId.replace(/^serial:/, ''))
  if (!mac) return null
  const entry = usbPorts.find((e) => normMac(e.info?.mac) === mac)
  if (entry) {
    const ip = lanIpForUsbEntry(entry, lanIps, lanInfo)
    if (ip) return ip
  }
  for (const ip of lanIps) {
    if (normMac(lanInfo[ip]?.mac) === mac) return ip
  }
  return null
}

/** One physical Hapbeat that is connected right now, by whichever transports reach it. */
export interface ConnectedHapbeat {
  lanIp: string | null
  usbPortId: string | null
}

const isWearableRole = (role?: string): boolean => !role || role === 'receiver'

/**
 * Every Hapbeat connected now, a device on both USB and Wi-Fi counted once.
 * LAN: online in Helper's list. USB: a card whose identify probe answered.
 * Known non-Hapbeat nodes (sensor / broker / transmitter, or a non-Hapbeat
 * board) are left out; an unprobed board stays in (same safe side as the UI
 * tab's write filter).
 */
export function connectedHapbeats(
  lanDevices: ReadonlyArray<Pick<DeviceInfo, 'ipAddress' | 'online' | 'role'>>,
  lanInfo: LanInfo,
  usbPorts: ReadonlyArray<Pick<SerialPortEntry, 'id' | 'info'>>,
): ConnectedHapbeat[] {
  const out: ConnectedHapbeat[] = []
  const onlineLan = lanDevices.filter((d) => d.online && !!d.ipAddress)
  const lanIps = new Set(onlineLan.map((d) => d.ipAddress))
  const byLanIp = new Map<string, ConnectedHapbeat>()
  for (const d of onlineLan) {
    if (!isWearableRole(d.role) || isKnownNonHapbeatBoard(lanInfo[d.ipAddress]?.board)) continue
    const entry: ConnectedHapbeat = { lanIp: d.ipAddress, usbPortId: null }
    byLanIp.set(d.ipAddress, entry)
    out.push(entry)
  }
  for (const p of usbPorts) {
    const info = p.info
    if (!info || !isWearableRole(info.role) || isKnownNonHapbeatBoard(info.board)) continue
    const lanIp = lanIpForUsbEntry(p, lanIps, lanInfo)
    const same = lanIp ? byLanIp.get(lanIp) : undefined
    if (same) same.usbPortId = same.usbPortId ?? p.id
    else if (!lanIp) out.push({ lanIp: null, usbPortId: p.id })
  }
  return out
}

/** The device the UI tab writes to over USB: the active USB config connection. */
export interface UsbUiTarget {
  /** `serial:<mac>` — the id the Manage detail pane uses for it. */
  serialId: string
  name: string
  /** Same device's online Wi-Fi IP (then the write goes over Wi-Fi). */
  lanIp: string | null
  /** Firmware accepts the chunked USB upload (`serial_ui_config: 1`). */
  serialWrite: boolean
}

/**
 * UI-tab write target when the UI selection has no online Wi-Fi device: the
 * Hapbeat on the USB config connection (Manage 設定, opened automatically when
 * it is the only device). Null while a selected Wi-Fi device is online, so an
 * explicit Wi-Fi choice always wins. The UI-tab pill shows this same target.
 */
export function usbUiTarget(args: {
  selectedIps: readonly string[]
  lanDevices: ReadonlyArray<Pick<DeviceInfo, 'ipAddress' | 'online'>>
  lanInfo: LanInfo
  usbPorts: ReadonlyArray<Pick<SerialPortEntry, 'info'>>
  serialMode: string
  serialInfo: SerialDeviceInfo | null
}): UsbUiTarget | null {
  const { selectedIps, lanDevices, lanInfo, usbPorts, serialMode, serialInfo: info } = args
  const onlineIps = new Set(lanDevices.filter((d) => d.online && !!d.ipAddress).map((d) => d.ipAddress))
  const selectedOnline = selectedIps.some((ip) => onlineIps.has(
    ip.startsWith('serial:') ? lanIpForSerialId(ip, usbPorts, onlineIps, lanInfo) ?? '' : ip))
  if (selectedOnline) return null
  if (serialMode !== 'config' || !info) return null
  if (!isWearableRole(info.role) || isKnownNonHapbeatBoard(info.board)) return null
  return {
    serialId: `serial:${info.mac ?? 'active'}`,
    name: info.name || '(unnamed)',
    lanIp: lanIpForUsbEntry({ info }, onlineIps, lanInfo),
    serialWrite: info.serial_ui_config === 1,
  }
}
