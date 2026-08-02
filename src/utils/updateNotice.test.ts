import { describe, it, expect, beforeEach, vi } from 'vitest'
import { dismissVersion, getDismissedVersion, shouldNotify } from './updateNotice'
import { resolveLatestFirmware } from './firmwareUpdate'
import type { FirmwareLibraryEntry } from './firmwareLibrary'

// updateNotice は localStorage にしか依存しない純ロジック。node 環境でも
// 走るよう最小のスタブを当てる。
beforeEach(() => {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => { store.clear() },
  })
})

describe('shouldNotify — 1 版につき 1 回だけ通知する (DEC-053 §5.1)', () => {
  it('まだ閉じていなければ通知する', () => {
    expect(shouldNotify('helper', '0.3.1')).toBe(true)
  })

  it('閉じた版と同じ版は二度と通知しない', () => {
    dismissVersion('helper', '0.3.1')
    expect(shouldNotify('helper', '0.3.1')).toBe(false)
  })

  it('閉じた後により新しい版が出たら再び通知する', () => {
    dismissVersion('helper', '0.3.1')
    expect(shouldNotify('helper', '0.4.0')).toBe(true)
    expect(shouldNotify('helper', '0.3.2')).toBe(true)
  })

  it('閉じた版より古い版は通知しない (ロールバックや feed の巻き戻り)', () => {
    dismissVersion('helper', '0.3.1')
    expect(shouldNotify('helper', '0.3.0')).toBe(false)
  })

  it('dev ビルド接尾辞 (0.3.1d4) は同版扱い — 同じ版への更新を促さない', () => {
    dismissVersion('helper', '0.3.1')
    expect(shouldNotify('helper', '0.3.1d4')).toBe(false)
  })

  it('latest 不明 (feed 未取得) なら通知しない', () => {
    expect(shouldNotify('helper', null)).toBe(false)
    expect(shouldNotify('helper', undefined)).toBe(false)
  })

  it('product ごとに独立して記録される', () => {
    dismissVersion('helper', '0.3.1')
    expect(shouldNotify('studio', '0.3.1')).toBe(true)
    expect(getDismissedVersion('studio')).toBeNull()
  })
})

describe('resolveLatestFirmware — 曖昧なら通知しない', () => {
  const entry = (o: Partial<FirmwareLibraryEntry>): FirmwareLibraryEntry =>
    ({ env: 'x', ...o } as FirmwareLibraryEntry)

  it('board 一致の 1 件を返す', () => {
    const entries = [
      entry({ env: 'band_v3', board: 'band_wl_v3', transport: 'udp', fwVersion: '0.3.1' }),
      entry({ env: 'duo_v4', board: 'duo_wl_v4', transport: 'udp', fwVersion: '0.2.0' }),
    ]
    expect(resolveLatestFirmware(entries, 'band_wl_v3', 'udp')).toBe('0.3.1')
  })

  it('先頭 v は落として正準形で返す', () => {
    const entries = [entry({ board: 'band_wl_v3', transport: 'udp', fwVersion: 'v0.3.1' })]
    expect(resolveLatestFirmware(entries, 'band_wl_v3', 'udp')).toBe('0.3.1')
  })

  it('transport で絞り込む (env ごとに独立採番されるため)', () => {
    const entries = [
      entry({ env: 'band_v3', board: 'band_wl_v3', transport: 'udp', fwVersion: '0.3.1' }),
      entry({ env: 'band_v3_mqtt', board: 'band_wl_v3', transport: 'mqtt', fwVersion: '0.2.5' }),
    ]
    expect(resolveLatestFirmware(entries, 'band_wl_v3', 'udp')).toBe('0.3.1')
    expect(resolveLatestFirmware(entries, 'band_wl_v3', 'mqtt')).toBe('0.2.5')
  })

  it('transports[] に含まれていればマッチする', () => {
    const entries = [
      entry({ board: 'band_wl_v3', transport: 'udp', transports: ['udp', 'mqtt'], fwVersion: '0.3.1' }),
    ]
    expect(resolveLatestFirmware(entries, 'band_wl_v3', 'mqtt')).toBe('0.3.1')
  })

  it('候補が複数版に割れたら null (誤報を出さない)', () => {
    const entries = [
      entry({ env: 'a', board: 'band_wl_v3', transport: 'udp', fwVersion: '0.3.1' }),
      entry({ env: 'b', board: 'band_wl_v3', transport: 'udp', fwVersion: '0.2.0' }),
    ]
    expect(resolveLatestFirmware(entries, 'band_wl_v3', 'udp')).toBeNull()
  })

  it('board 不明 / 該当なしは null', () => {
    const entries = [entry({ board: 'band_wl_v3', transport: 'udp', fwVersion: '0.3.1' })]
    expect(resolveLatestFirmware(entries, undefined, 'udp')).toBeNull()
    expect(resolveLatestFirmware(entries, 'duo_wl_v4', 'udp')).toBeNull()
  })
})
