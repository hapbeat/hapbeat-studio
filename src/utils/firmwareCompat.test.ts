import { describe, it, expect } from 'vitest'
import { deviceStreamGens, firmwareCompatNotice, firmwareMajor } from './firmwareCompat'
import firmwareCompatSource from './firmwareCompat.ts?raw'

describe('firmwareMajor', () => {
  it('先頭の v と開発版の接尾辞を除いた major を返す', () => {
    expect(firmwareMajor('0.5.0')).toBe(0)
    expect(firmwareMajor('v1.0.0')).toBe(1)
    expect(firmwareMajor('1.0.0d3')).toBe(1)
    expect(firmwareMajor('1.0.0-d3')).toBe(1)
    expect(firmwareMajor('1.0.0-rc1')).toBe(1)
    expect(firmwareMajor('0.1.0d12')).toBe(0)
  })
  it('読めない版は null', () => {
    expect(firmwareMajor('unknown')).toBeNull()
    expect(firmwareMajor('')).toBeNull()
    expect(firmwareMajor(null)).toBeNull()
    expect(firmwareMajor(undefined)).toBeNull()
  })
})

describe('firmwareCompatNotice', () => {
  it('major が変わるときだけ案内する', () => {
    expect(firmwareCompatNotice('1.0.0', { fw: '0.5.0' })).toEqual({ fromMajor: 0, toMajor: 1, currentStreamGens: null })
    expect(firmwareCompatNotice('0.2.0', { fw: '0.1.0' })).toBeNull() // band_v4_pwm の 0.1.0 → 0.2.0
    expect(firmwareCompatNotice('0.5.1', { fw: '0.5.0' })).toBeNull()
  })
  it('機体の版が分からなければ fromMajor: null で案内する', () => {
    expect(firmwareCompatNotice('1.0.0', { fw: undefined })).toEqual({ fromMajor: null, toMajor: 1, currentStreamGens: null })
  })
  it('image の版が読めなければ判定しない', () => {
    expect(firmwareCompatNotice(null, { fw: '0.5.0' })).toBeNull()
    expect(firmwareCompatNotice(undefined, { fw: undefined })).toBeNull()
  })
  it('機体の今の stream の世代を添える', () => {
    expect(firmwareCompatNotice('1.0.0', { fw: '0.5.0', info: { stream_protocol: 2 } })?.currentStreamGens).toEqual([2])
  })
})

describe('deviceStreamGens', () => {
  it('caps.stream_gens を優先する', () => {
    expect(deviceStreamGens({ caps: { stream_gens: [2] }, stream_protocol: 1 })).toEqual([2])
    expect(deviceStreamGens({ caps: { stream_gens: [] } })).toEqual([])
  })
  it('stream_protocol を配列にする', () => {
    expect(deviceStreamGens({ stream_protocol: 2 })).toEqual([2])
  })
  it('どちらも無ければ null', () => {
    expect(deviceStreamGens({})).toBeNull()
    expect(deviceStreamGens(null)).toBeNull()
    expect(deviceStreamGens({ caps: {} })).toBeNull()
  })
})

describe('表を持たない (versioning.md §5.5)', () => {
  it('firmwareCompat.ts に SDK・ファームの版の文字列が無い', () => {
    expect(firmwareCompatSource).not.toMatch(/['"`]v?\d+\.\d+\.\d+/)
  })
})
