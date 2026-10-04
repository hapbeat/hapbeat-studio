import { describe, it, expect } from 'vitest'
import {
  inferVariantFromEnv,
  formatBytes,
  matchesHapticOutput,
  mergeLocalWithReleases,
  type FirmwareLibraryEntry,
} from './firmwareLibrary'

describe('inferVariantFromEnv — env 名から role/transport/board 推定', () => {
  it('broker / sensor', () => {
    expect(inferVariantFromEnv('atoms3_broker')).toMatchObject({ role: 'broker', transport: 'mqtt' })
    expect(inferVariantFromEnv('atom_lite_sensor')).toMatchObject({ role: 'sensor', transport: 'mqtt' })
  })
  it('transmitter (audio tx)', () => {
    expect(inferVariantFromEnv('m5stack_espnow_stream_source')).toMatchObject({
      role: 'transmitter', transport: 'espnow_stream',
    })
  })
  it('receiver mqtt + board 推定 (band/necklace)', () => {
    expect(inferVariantFromEnv('band_v3_mqtt')).toMatchObject({
      role: 'receiver', transport: 'mqtt', board: 'band_wl_v3',
    })
    // necklace/duo → duo_wl_*
    expect(inferVariantFromEnv('necklace_v3')).toMatchObject({
      role: 'receiver', transport: 'wifi_udp', board: 'duo_wl_v3',
    })
  })
  it('espnow stream receiver', () => {
    expect(inferVariantFromEnv('necklace_v3_stream_espnow')).toMatchObject({
      role: 'receiver', transport: 'espnow_stream', board: 'duo_wl_v3',
    })
  })
  it('既定 (素の wifi_udp receiver)', () => {
    expect(inferVariantFromEnv('band_v2')).toMatchObject({
      role: 'receiver', transport: 'wifi_udp', board: 'band_wl_v2',
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

describe('PWM 出力版 (band_v4_pwm) の判別', () => {
  it('env 名 _pwm から hapticOutput=pwm を推定し、board は通常 Band v4 と同じ', () => {
    expect(inferVariantFromEnv('band_v4_pwm')).toMatchObject({
      role: 'receiver', transport: 'wifi_udp', board: 'band_wl_v4', hapticOutput: 'pwm',
    })
    expect(inferVariantFromEnv('band_v4').hapticOutput).toBeUndefined()
  })
  it('haptic_pwm を報告しないデバイスには PWM 版を合わせず、報告するデバイスには通常版を合わせない', () => {
    const plain = { env: 'band_v4', board: 'band_wl_v4' } as FirmwareLibraryEntry
    const pwm = { env: 'band_v4_pwm', board: 'band_wl_v4', hapticOutput: 'pwm' } as FirmwareLibraryEntry
    expect(matchesHapticOutput(plain, false)).toBe(true)
    expect(matchesHapticOutput(pwm, false)).toBe(false)
    expect(matchesHapticOutput(pwm, true)).toBe(true)
    expect(matchesHapticOutput(plain, true)).toBe(false)
  })
})

describe('mergeLocalWithReleases — dev のローカルビルド + 公開リリース', () => {
  const art = (path: string) => ({ size: 1, mtime: 0, path })
  const rel = (env: string, fws: string[]): FirmwareLibraryEntry => ({
    env,
    fwVersion: fws[0],
    appOta: art(`/firmware-releases/${env}_${fws[0]}.bin`),
    versions: fws.map((fwVersion) => ({
      fwVersion, tag: `dev/${env}/v${fwVersion}`, appOta: art(`/firmware-releases/${env}_${fwVersion}.bin`),
    })),
  })
  it('ローカルを versions[0] (local) に置き、続けてリリースを並べる', () => {
    const local: FirmwareLibraryEntry = { env: 'band_v4_pwm', fwVersion: '0.2.0d1', source: 'live', appOta: art('C:/x.bin') }
    const [e] = mergeLocalWithReleases([local], [rel('band_v4_pwm', ['0.1.1', '0.1.0'])])
    expect(e.fwVersion).toBe('0.2.0d1')
    expect(e.source).toBe('live')
    expect(e.versions?.map((v) => [v.fwVersion, v.local ?? false])).toEqual([
      ['0.2.0d1', true], ['0.1.1', false], ['0.1.0', false],
    ])
  })
  it('リリースのみの env は source=release で追加、ローカルのみはそのまま', () => {
    const local: FirmwareLibraryEntry = { env: 'necklace_v3', fwVersion: '0.5.0d7', source: 'live' }
    const out = mergeLocalWithReleases([local], [rel('band_v4', ['0.4.1'])])
    expect(out.map((e) => [e.env, e.source, e.versions?.length])).toEqual([
      ['necklace_v3', 'live', undefined], ['band_v4', 'release', 1],
    ])
  })
})
