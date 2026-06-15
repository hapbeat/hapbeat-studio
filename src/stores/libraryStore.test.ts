import { describe, it, expect } from 'vitest'
import { sanitizeEventIdPart, composeKitEventId, validateKitName } from './libraryStore'

describe('sanitizeEventIdPart — eventId 1 セグメントの正規化', () => {
  it('小文字化 + 非対応文字→_ + 連続_圧縮', () => {
    expect(sanitizeEventIdPart('Red Alert')).toBe('red_alert')
    expect(sanitizeEventIdPart('a!!b')).toBe('a_b')
  })
  it('先頭/末尾の _ - を除去', () => {
    expect(sanitizeEventIdPart('--x--')).toBe('x')
  })
  it('先頭が英小文字でなければ c を前置', () => {
    expect(sanitizeEventIdPart('123')).toBe('c_123')
    expect(sanitizeEventIdPart('')).toBe('c')
  })
  it('64 文字に切り詰め', () => {
    expect(sanitizeEventIdPart('a'.repeat(80)).length).toBe(64)
  })
})

describe('composeKitEventId — <kit>.<clip>', () => {
  it('両者を sanitize して結合', () => {
    expect(composeKitEventId('Alert Kit', 'Red')).toBe('alert_kit.red')
    expect(composeKitEventId('alert-kit', 'urgent')).toBe('alert-kit.urgent')
  })
})

describe('validateKitName — contracts kit_id 形式', () => {
  it('有効', () => {
    expect(validateKitName('my-kit')).toBeNull()
    expect(validateKitName('alert-kit-2')).toBeNull()
  })
  it('無効はエラーメッセージ', () => {
    expect(validateKitName('')).toBeTruthy()
    expect(validateKitName('My-Kit')).toBeTruthy()     // 大文字
    expect(validateKitName('my_kit')).toBeTruthy()      // アンダースコア不可
    expect(validateKitName('1kit')).toBeTruthy()        // 数字始まり
    expect(validateKitName('a'.repeat(65))).toBeTruthy() // 長さ超過
  })
})
