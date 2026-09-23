import { beforeEach, describe, expect, it } from 'vitest'
import { useDeviceStore } from './deviceStore'

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
