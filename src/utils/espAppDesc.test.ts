import { describe, it, expect } from 'vitest'
import { readAppDescVersion } from './espAppDesc'

// Node built-in loaded untyped: the app tsconfig carries no Node types.
const fs = await import(/* @vite-ignore */ `node:${'fs'}`) as {
  existsSync(p: URL): boolean
  readFileSync(p: URL): Uint8Array
}

function appImage(version: string, size = 0x100, magic = 0xabcd5432): Uint8Array {
  const bin = new Uint8Array(size)
  bin[0] = 0xe9
  new DataView(bin.buffer).setUint32(0x20, magic, true)
  bin.set(new TextEncoder().encode(version), 0x30)
  return bin
}

function mergedImage(version: string): Uint8Array {
  const bin = new Uint8Array(0x10100).fill(0xff)
  bin[0] = 0xe9
  bin.set(appImage(version), 0x10000)
  return bin
}

describe('readAppDescVersion', () => {
  it('app-only image の version を読む', () => {
    expect(readAppDescVersion(appImage('0.5.0d7'))).toBe('0.5.0d7')
    expect(readAppDescVersion(appImage('0.5.0'))).toBe('0.5.0')
    expect(readAppDescVersion(appImage('0.5.0-rc1'))).toBe('0.5.0-rc1')
  })
  it('merged full-serial image は 0x10000 以降の descriptor を読む', () => {
    expect(readAppDescVersion(mergedImage('0.5.0d7'))).toBe('0.5.0d7')
  })
  it('旧ビルドの IDF version / magic 不一致 / 短すぎる入力は null', () => {
    expect(readAppDescVersion(appImage('esp-idf: v4.4.7 38eeba213a'))).toBeNull()
    expect(readAppDescVersion(mergedImage('esp-idf: v4.4.7 38eeba213a'))).toBeNull()
    expect(readAppDescVersion(appImage('0.5.0', 0x100, 0))).toBeNull()
    expect(readAppDescVersion(new Uint8Array(0x20))).toBeNull()
    expect(readAppDescVersion(appImage(''))).toBeNull()
  })

  // Real local build output (hapbeat-device-firmware dist/), when present.
  const dist = '../../../../repos-firmware/hapbeat-device-firmware/dist/necklace_v3/'
  const files = ['firmware_app_ota.bin', 'firmware_full_serial.bin']
    .map((f) => new URL(dist + f, import.meta.url))
  it.skipIf(!files.every((f) => fs.existsSync(f)))('ローカルの necklace_v3 ビルドから同じ version を読む', () => {
    const [ota, full] = files.map((f) => readAppDescVersion(new Uint8Array(fs.readFileSync(f))))
    expect(ota).toMatch(/^\d+\.\d+\.\d+/)
    expect(full).toBe(ota)
  })
})
