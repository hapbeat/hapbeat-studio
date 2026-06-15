import { describe, it, expect } from 'vitest'
import { inferVariantFromEnv, formatBytes } from './firmwareLibrary'

describe('inferVariantFromEnv — env 名から role/transport/board 推定', () => {
  it('broker / sensor', () => {
    expect(inferVariantFromEnv('atoms3_broker')).toMatchObject({ role: 'broker', transport: 'mqtt' })
    expect(inferVariantFromEnv('atom_lite_sensor')).toMatchObject({ role: 'sensor', transport: 'mqtt' })
  })
  it('transmitter (audio tx)', () => {
    expect(inferVariantFromEnv('m5stack_audio_tx')).toMatchObject({
      role: 'transmitter', transport: 'espnow_stream',
    })
  })
  it('receiver mqtt + board 推定 (band/necklace)', () => {
    expect(inferVariantFromEnv('band_v3_mqtt')).toMatchObject({
      role: 'receiver', transport: 'mqtt', board: 'band_wl_v3',
    })
    // necklace/duo → duo_wl_*
    expect(inferVariantFromEnv('necklace_v3')).toMatchObject({
      role: 'receiver', transport: 'udp', board: 'duo_wl_v3',
    })
  })
  it('espnow stream receiver', () => {
    expect(inferVariantFromEnv('necklace_v3_stream_espnow')).toMatchObject({
      role: 'receiver', transport: 'espnow_stream', board: 'duo_wl_v3',
    })
  })
  it('既定 (素の udp receiver)', () => {
    expect(inferVariantFromEnv('band_v2')).toMatchObject({
      role: 'receiver', transport: 'udp', board: 'band_wl_v2',
    })
  })
})

describe('formatBytes', () => {
  it('境界', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1023)).toBe('1023 B')
    expect(formatBytes(1024)).toBe('1 KB')
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB')
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.0 GB')
  })
})
