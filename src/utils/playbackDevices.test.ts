import { describe, expect, it } from 'vitest'
import type { DeviceInfo } from '@/types/manager'
import { onlinePlaybackDevices, resolvePlaybackTargets } from './playbackDevices'

const device = (ipAddress: string, patch: Partial<DeviceInfo> = {}): DeviceInfo => ({
  name: ipAddress, ipAddress, address: '', firmwareVersion: '', online: true, serialConnected: false,
  volumeWiper: null, volumeLevel: null, volumeSteps: null, ...patch,
})

describe('playback devices', () => {
  const devices = [device('a'), device('b', { online: false }), device('c', { role: 'sensor' }), device('d', { role: 'receiver' })]
  it('keeps only connected receivers', () => {
    expect(onlinePlaybackDevices(devices).map(d => d.ipAddress)).toEqual(['a', 'd'])
  })
  it('restricts to the selection when there is one, never to offline devices', () => {
    expect(resolvePlaybackTargets(devices, []).map(d => d.ipAddress)).toEqual(['a', 'd'])
    expect(resolvePlaybackTargets(devices, ['b', 'd']).map(d => d.ipAddress)).toEqual(['d'])
  })
})
