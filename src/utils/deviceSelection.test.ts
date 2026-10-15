import { describe, expect, it } from 'vitest'
import { connectedHapbeats, lanIpForSerialId, lanIpForUsbEntry, usbUiTarget } from './deviceSelection'

const lan = (ipAddress: string, online = true, role?: 'receiver' | 'sensor') => ({ ipAddress, online, role })

describe('USB ↔ Wi-Fi device matching', () => {
  it('matches a USB card to its Wi-Fi IP by the IP it reports, then by MAC', () => {
    const lanIps = new Set(['192.168.0.10', '192.168.0.11'])
    expect(lanIpForUsbEntry({ info: { wifi_ip: '192.168.0.10' } }, lanIps, {})).toBe('192.168.0.10')
    expect(lanIpForUsbEntry(
      { info: { wifi_ip: '0.0.0.0', mac: 'AA:BB:CC:DD:EE:01' } },
      lanIps,
      { '192.168.0.11': { mac: 'aabbccddee01' } },
    )).toBe('192.168.0.11')
    expect(lanIpForUsbEntry({ info: { wifi_ip: '192.168.0.99' } }, lanIps, {})).toBeNull()
    expect(lanIpForUsbEntry({ info: null }, lanIps, {})).toBeNull()
  })

  it('resolves a serial:<mac> id through the USB card or the LAN cache', () => {
    const lanIps = new Set(['192.168.0.10'])
    const ports = [{ info: { mac: 'AA:BB:CC:DD:EE:01', wifi_ip: '192.168.0.10' } }]
    expect(lanIpForSerialId('serial:AA:BB:CC:DD:EE:01', ports, lanIps, {})).toBe('192.168.0.10')
    expect(lanIpForSerialId('serial:aa:bb:cc:dd:ee:01', [], lanIps, { '192.168.0.10': { mac: 'AA:BB:CC:DD:EE:01' } })).toBe('192.168.0.10')
    expect(lanIpForSerialId('serial:active', ports, lanIps, {})).toBeNull()
  })
})

describe('connectedHapbeats', () => {
  it('counts a device on both USB and Wi-Fi once', () => {
    const out = connectedHapbeats(
      [lan('192.168.0.10')],
      { '192.168.0.10': { board: 'band_wl_v5' } },
      [{ id: 'usb-1', info: { wifi_ip: '192.168.0.10', board: 'band_wl_v5' } }],
    )
    expect(out).toEqual([{ lanIp: '192.168.0.10', usbPortId: 'usb-1' }])
  })

  it('lists a USB-only device and skips offline, non-Hapbeat and unidentified ones', () => {
    const out = connectedHapbeats(
      [lan('192.168.0.10', false), lan('192.168.0.20', true, 'sensor'), lan('192.168.0.30')],
      { '192.168.0.30': { board: 'atom_s3' } },
      [
        { id: 'usb-1', info: { board: 'band_wl_v5', wifi_ip: '0.0.0.0' } },
        { id: 'usb-2', info: null },
      ],
    )
    expect(out).toEqual([{ lanIp: null, usbPortId: 'usb-1' }])
  })
})

describe('usbUiTarget', () => {
  const base = {
    selectedIps: [] as string[],
    lanDevices: [lan('192.168.0.10')],
    lanInfo: {},
    usbPorts: [],
    serialMode: 'config',
  }

  it('targets the USB config device when no selected Wi-Fi device is online', () => {
    const t = usbUiTarget({ ...base, serialInfo: { name: 'band5', mac: 'AA:01', wifi_ip: '0.0.0.0', board: 'band_wl_v5', serial_ui_config: 1 } })
    expect(t).toEqual({ serialId: 'serial:AA:01', name: 'band5', lanIp: null, serialWrite: true })
    const old = usbUiTarget({ ...base, serialInfo: { name: 'band5', mac: 'AA:01', board: 'band_wl_v5' } })
    expect(old?.serialWrite).toBe(false)
  })

  it('routes over Wi-Fi when the USB device is also online on the LAN', () => {
    const t = usbUiTarget({ ...base, serialInfo: { mac: 'AA:01', wifi_ip: '192.168.0.10', serial_ui_config: 1 } })
    expect(t?.lanIp).toBe('192.168.0.10')
  })

  it('yields to an online Wi-Fi selection, and needs an open USB config connection', () => {
    const info = { mac: 'AA:01', serial_ui_config: 1 }
    expect(usbUiTarget({ ...base, selectedIps: ['192.168.0.10'], serialInfo: info })).toBeNull()
    expect(usbUiTarget({ ...base, selectedIps: ['192.168.0.99'], serialInfo: info })).not.toBeNull()
    expect(usbUiTarget({ ...base, serialMode: 'idle', serialInfo: info })).toBeNull()
    expect(usbUiTarget({ ...base, serialInfo: { ...info, role: 'sensor' } })).toBeNull()
  })
})
