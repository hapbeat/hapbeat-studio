import { describe, it, expect } from 'vitest'
import { isHapbeatBoard, isKnownNonHapbeatBoard } from './hapbeatBoard'

describe('isHapbeatBoard', () => {
  it('duo_wl_* / band_wl_* は Hapbeat 本体', () => {
    expect(isHapbeatBoard('duo_wl_v3')).toBe(true)
    expect(isHapbeatBoard('band_wl_v2')).toBe(true)
    expect(isHapbeatBoard('band_wl_v4')).toBe(true)
  })
  it('周辺機器は Hapbeat ではない', () => {
    expect(isHapbeatBoard('atom_lite')).toBe(false)
    expect(isHapbeatBoard('atom_s3')).toBe(false)
    expect(isHapbeatBoard('m5stack_basic')).toBe(false)
  })
  it('未取得 (undefined / unknown) は false', () => {
    expect(isHapbeatBoard(undefined)).toBe(false)
    expect(isHapbeatBoard('')).toBe(false)
    expect(isHapbeatBoard('unknown')).toBe(false)
  })
})

describe('isKnownNonHapbeatBoard — 「非 Hapbeat と確定」のみ true (安全側 fail-open)', () => {
  it('周辺機器 board は true', () => {
    expect(isKnownNonHapbeatBoard('atom_lite')).toBe(true)
    expect(isKnownNonHapbeatBoard('atom_s3')).toBe(true)
  })
  it('Hapbeat 本体は false', () => {
    expect(isKnownNonHapbeatBoard('duo_wl_v3')).toBe(false)
    expect(isKnownNonHapbeatBoard('band_wl_v2')).toBe(false)
  })
  it('未取得 (undefined / unknown) は false — 誤ってブロックしない', () => {
    expect(isKnownNonHapbeatBoard(undefined)).toBe(false)
    expect(isKnownNonHapbeatBoard('unknown')).toBe(false)
  })
})
