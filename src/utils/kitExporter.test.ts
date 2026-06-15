import { describe, it, expect } from 'vitest'
import { toKitId, manifestFileName, validateEventIds } from './kitExporter'

describe('toKitId — kit 名 → kit_id (contracts: [a-z][a-z0-9-]*)', () => {
  it('空白→ハイフン, 大文字→小文字', () => {
    expect(toKitId('My Kit')).toBe('my-kit')
    expect(toKitId('UPPER CASE')).toBe('upper-case')
  })
  it('非対応文字を除去 + 連続/末尾ハイフン整理', () => {
    expect(toKitId('My  Kit!!')).toBe('my-kit')
    expect(toKitId('a---b')).toBe('a-b')
    expect(toKitId('kit-')).toBe('kit')
  })
  it('先頭が英小文字でない分を除去', () => {
    expect(toKitId('123abc')).toBe('abc')
    expect(toKitId('-x')).toBe('x')
  })
  it('全部除去されたら unnamed-kit に fallback', () => {
    expect(toKitId('日本語')).toBe('unnamed-kit')
    expect(toKitId('')).toBe('unnamed-kit')
    expect(toKitId('123')).toBe('unnamed-kit')
  })
})

describe('manifestFileName', () => {
  it('<kit-id>-manifest.json 規約', () => {
    expect(manifestFileName('my-kit')).toBe('my-kit-manifest.json')
  })
})

describe('validateEventIds — contracts event-id 形式', () => {
  const check = (ids: string[]) =>
    validateEventIds({ events: ids.map((eventId) => ({ eventId })) } as Parameters<typeof validateEventIds>[0])
      .map((r) => r.valid)

  it('有効な形式', () => {
    expect(check(['foo.bar'])).toEqual([true])
    expect(check(['ns/foo.bar'])).toEqual([true])       // 任意 namespace
    expect(check(['kit.clip.sub'])).toEqual([true])      // 1〜3 dot-part
  })
  it('無効な形式', () => {
    expect(check(['Foo.bar'])).toEqual([false])          // 先頭大文字
    expect(check(['foo'])).toEqual([false])              // dot 無し
    expect(check(['a.b.c.d.e'])).toEqual([false])        // dot-part 過多
    expect(check(['foo.'])).toEqual([false])             // 末尾 dot
  })
})
