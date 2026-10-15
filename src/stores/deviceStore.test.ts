import { beforeEach, describe, expect, it } from 'vitest'
import { useDeviceStore } from './deviceStore'
import { useSerialMaster, type SerialPortEntry } from './serialMaster'

describe('scoped device selections', () => {
  beforeEach(() => {
    useDeviceStore.setState({
      selectedIp: null,
      selectedIps: [],
      kitSelectedIp: null,
      kitSelectedIps: [],
      displaySelectedIp: null,
      displaySelectedIps: [],
      dismissedIps: [],
    })
  })

  it('keeps Kit, UI, and Manage targets independent', () => {
    const store = useDeviceStore.getState()
    store.selectScopedExclusive('kit', '192.168.0.11')
    store.toggleScopedSelect('kit', '192.168.0.12')
    store.selectScopedExclusive('display', '192.168.0.21')
    store.selectExclusive('192.168.0.31')

    const state = useDeviceStore.getState()
    expect(state.kitSelectedIps).toEqual(['192.168.0.11', '192.168.0.12'])
    expect(state.kitSelectedIp).toBe('192.168.0.12')
    expect(state.displaySelectedIps).toEqual(['192.168.0.21'])
    expect(state.displaySelectedIp).toBe('192.168.0.21')
    expect(state.selectedIps).toEqual(['192.168.0.31'])
    expect(state.selectedIp).toBe('192.168.0.31')
  })

  it('keeps an intentionally empty scoped target list empty after a toggle', () => {
    const store = useDeviceStore.getState()
    store.selectScopedExclusive('kit', '192.168.0.11')
    store.toggleScopedSelect('kit', '192.168.0.11')

    const state = useDeviceStore.getState()
    expect(state.kitSelectedIps).toEqual([])
    expect(state.kitSelectedIp).toBeNull()
  })
})

describe('carrySelection (tab switch)', () => {
  const usbPort = (id: string, info: SerialPortEntry['info']): SerialPortEntry => ({
    id, bridge: 'USB', probe: 'success', info, flash: { state: 'idle', progress: null },
  })

  beforeEach(() => {
    useDeviceStore.setState({
      selectedIp: null,
      selectedIps: [],
      kitSelectedIp: null,
      kitSelectedIps: [],
      displaySelectedIp: null,
      displaySelectedIps: [],
      dismissedIps: [],
      infoCache: {},
    })
    useSerialMaster.setState({ knownPorts: [], selectedPortIds: [], selectedPortId: null })
  })

  it('gives the next tab the selection of the previous tab', () => {
    const store = useDeviceStore.getState()
    store.selectScopedExclusive('kit', '192.168.0.11')
    store.toggleScopedSelect('kit', '192.168.0.12')
    store.carrySelection('kit', 'display', ['192.168.0.11', '192.168.0.12'])
    let state = useDeviceStore.getState()
    expect(state.displaySelectedIps).toEqual(['192.168.0.11', '192.168.0.12'])
    expect(state.displaySelectedIp).toBe('192.168.0.12')

    state.carrySelection('display', 'manage', ['192.168.0.11', '192.168.0.12'])
    state = useDeviceStore.getState()
    expect(state.selectedIps).toEqual(['192.168.0.11', '192.168.0.12'])
    expect(state.selectedIp).toBe('192.168.0.12')
  })

  it('keeps the target selection when the source has nothing to carry', () => {
    const store = useDeviceStore.getState()
    store.selectScopedExclusive('display', '192.168.0.21')
    store.carrySelection('kit', 'display', ['192.168.0.21'])
    expect(useDeviceStore.getState().displaySelectedIps).toEqual(['192.168.0.21'])
  })

  it('carries a Manage USB card as the Wi-Fi IP of the same device', () => {
    useSerialMaster.setState({
      knownPorts: [usbPort('usb-1', { mac: 'AA:BB:CC:DD:EE:01', wifi_ip: '192.168.0.10', board: 'band_wl_v5' })],
      selectedPortIds: ['usb-1'],
      selectedPortId: 'usb-1',
    })
    useDeviceStore.getState().carrySelection('manage', 'display', ['192.168.0.10'])
    expect(useDeviceStore.getState().displaySelectedIps).toEqual(['192.168.0.10'])

    // Back to Manage: the USB session already targets that device → untouched.
    useDeviceStore.getState().carrySelection('display', 'manage', ['192.168.0.10'])
    expect(useSerialMaster.getState().selectedPortIds).toEqual(['usb-1'])
    expect(useDeviceStore.getState().selectedIps).toEqual([])
  })

  it('does not carry a USB-only device or a non-Hapbeat board into the UI tab', () => {
    useSerialMaster.setState({
      knownPorts: [usbPort('usb-1', { mac: 'AA:BB:CC:DD:EE:01', wifi_ip: '0.0.0.0' })],
      selectedPortIds: ['usb-1'],
      selectedPortId: 'usb-1',
    })
    useDeviceStore.getState().carrySelection('manage', 'kit', ['192.168.0.10'])
    expect(useDeviceStore.getState().kitSelectedIps).toEqual([])

    useSerialMaster.setState({ selectedPortIds: [], selectedPortId: null })
    useDeviceStore.setState({ infoCache: { '192.168.0.30': { board: 'atom_s3' } } })
    useDeviceStore.getState().selectExclusive('192.168.0.30')
    useDeviceStore.getState().carrySelection('manage', 'display', ['192.168.0.30'])
    expect(useDeviceStore.getState().displaySelectedIps).toEqual([])
  })
})
