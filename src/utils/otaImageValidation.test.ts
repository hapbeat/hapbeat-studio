import { describe, it, expect } from 'vitest'
import {
  chipIdForBoard,
  validateOtaImage,
  ESP_IMAGE_MAGIC,
  ESP_CHIP_ID_ESP32,
  ESP_CHIP_ID_ESP32_S3,
} from './otaImageValidation'

describe('chipIdForBoard', () => {
  it('classic ESP32 系', () => {
    expect(chipIdForBoard('atom_lite')).toBe(ESP_CHIP_ID_ESP32)
    expect(chipIdForBoard('m5stack_basic')).toBe(ESP_CHIP_ID_ESP32)
  })
  it('ESP32-S3 系', () => {
    expect(chipIdForBoard('atom_s3')).toBe(ESP_CHIP_ID_ESP32_S3)
    expect(chipIdForBoard('band_wl_v2')).toBe(ESP_CHIP_ID_ESP32_S3)
    expect(chipIdForBoard('duo_wl_v3')).toBe(ESP_CHIP_ID_ESP32_S3)
  })
  it('不明な board は null (完全一致チェックを skip させる)', () => {
    expect(chipIdForBoard(null)).toBeNull()
    expect(chipIdForBoard(undefined)).toBeNull()
    expect(chipIdForBoard('weird')).toBeNull()
  })
})

/** 有効な app image header を持つ 200 KB のダミーを作る。 */
function makeImage(opts: { magic?: number; segments?: number; chipId?: number } = {}): Uint8Array {
  const buf = new Uint8Array(200 * 1024)
  buf[0] = opts.magic ?? ESP_IMAGE_MAGIC
  buf[1] = opts.segments ?? 4
  buf[12] = opts.chipId ?? ESP_CHIP_ID_ESP32_S3
  buf[23] = 1 // hash appended
  return buf
}

describe('validateOtaImage', () => {
  it('正常な S3 app image (chip 一致)', () => {
    const r = validateOtaImage(makeImage({ chipId: ESP_CHIP_ID_ESP32_S3 }), ESP_CHIP_ID_ESP32_S3)
    expect(r.ok).toBe(true)
    expect(r.info?.chipName).toBe('ESP32-S3')
    expect(r.info?.chipId).toBe(ESP_CHIP_ID_ESP32_S3)
  })
  it('小さすぎるファイルを弾く', () => {
    const r = validateOtaImage(new Uint8Array(1000))
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/小さすぎ/)
  })
  it('magic byte 不正を弾く', () => {
    const r = validateOtaImage(makeImage({ magic: 0x00 }))
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/0xE9|application image/)
  })
  it('chip ID 不一致を弾く (classic を S3 デバイスに送る等)', () => {
    const r = validateOtaImage(makeImage({ chipId: ESP_CHIP_ID_ESP32 }), ESP_CHIP_ID_ESP32_S3)
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/Chip ID/)
  })
  it('classic ESP32 image を classic デバイスに送るのは通る (regression: 旧版は常に S3 固定で弾いていた)', () => {
    const r = validateOtaImage(makeImage({ chipId: ESP_CHIP_ID_ESP32 }), ESP_CHIP_ID_ESP32)
    expect(r.ok).toBe(true)
    expect(r.info?.chipName).toBe('ESP32')
  })
  it('board 不明 (expectedChipId 省略) でも既知 chip なら通る', () => {
    const r = validateOtaImage(makeImage({ chipId: ESP_CHIP_ID_ESP32_S3 }))
    expect(r.ok).toBe(true)
  })
  it('merged image (partition table magic AA 50 @0x8000) を弾く', () => {
    const buf = makeImage()
    buf[0x8000] = 0xaa
    buf[0x8001] = 0x50
    const r = validateOtaImage(buf, ESP_CHIP_ID_ESP32_S3)
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/merged image/)
  })
  it('segment 数が不正を弾く', () => {
    const r = validateOtaImage(makeImage({ segments: 0 }), ESP_CHIP_ID_ESP32_S3)
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/segment/)
  })
})
