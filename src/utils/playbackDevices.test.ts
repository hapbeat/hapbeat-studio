import { describe, expect, it } from 'vitest'
import type { DeviceInfo } from '@/types/manager'
import { atPositions, devicePosition, onlinePlaybackDevices, playerChipDevices, resolvePlaybackTargets, routePlaybackTargets } from './playbackDevices'

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
  it("the player's chip counts the found Hapbeats before a project is read, the runtime's targets after", () => {
    // No cue table yet: the runtime has no targets, but the helper sees two playback devices.
    expect(playerChipDevices(false, [], devices, []).map(d => d.ipAddress)).toEqual(['a', 'd'])
    expect(playerChipDevices(false, [], devices, ['d']).map(d => d.ipAddress)).toEqual(['d'])
    expect(playerChipDevices(false, [], [], [])).toEqual([])
    // With the table: exactly the runtime's targets.
    expect(playerChipDevices(true, [{ ipAddress: 'a', name: 'a', address: '' }], devices, []).map(d => d.ipAddress)).toEqual(['a'])
    expect(playerChipDevices(true, [], devices, [])).toEqual([])
  })

  it('routes an audition by the cue positions: neck to the DuoWL, hand / both to both wrists; no address = position unknown', () => {
    const all = [device('n', { name: 'DuoWL-1', address: 'player_1/pos_neck/group_1' }), device('l', { name: 'BandWL-L', address: 'player_1/pos_l_wrist/group_1' }),
      device('r', { name: 'BandWL-R', address: 'player_1/pos_r_wrist' }), device('x', { name: 'old' })]
    expect(devicePosition('player_1/pos_neck/group_1')).toBe('pos_neck')
    expect(devicePosition('')).toBeNull()
    expect(atPositions('hand')).toEqual(['pos_l_wrist', 'pos_r_wrist'])
    const neck = routePlaybackTargets(all, ['pos_neck'])
    expect(neck.devices.map(d => d.ipAddress)).toEqual(['n'])
    expect(neck.unknown.map(d => d.ipAddress)).toEqual(['x'])
    expect(routePlaybackTargets(all, ['hand']).devices.map(d => d.ipAddress)).toEqual(['l', 'r'])
    expect(routePlaybackTargets(all, ['pos_neck', 'both']).devices.map(d => d.ipAddress)).toEqual(['n', 'l', 'r']) // every route
    expect(routePlaybackTargets(all, ['pos_chest']).devices).toEqual([])
    expect(routePlaybackTargets(all, null).devices).toHaveLength(4) // no cue: as selected
  })
})
