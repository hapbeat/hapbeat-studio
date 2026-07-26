import { describe, it, expect } from 'vitest'
import type { KitDefinition } from '@/types/library'
import { exportKitAsPack, toKitId, manifestFileName, validateEventIds } from './kitExporter'

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

describe('exportKitAsPack — source audio safety', () => {
  it('reports a hard error instead of silently exporting a partial manifest', async () => {
    const kit: KitDefinition = {
      id: 'kit-1',
      name: 'safe-kit',
      version: '1.0.0',
      description: '',
      createdAt: '2026-07-27T00:00:00.000Z',
      updatedAt: '2026-07-27T00:00:00.000Z',
      events: [{
        id: 'event-1',
        eventId: 'safe-kit.missing',
        clipName: 'missing',
        clipSourceFilename: 'missing.wav',
        clipDuration: 0,
        clipChannels: 1,
        clipSampleRate: 16000,
        clipFileSize: 0,
        modes: ['command'],
        loop: false,
        intensity: 1,
        deviceWiper: null,
      }],
    }

    const result = await exportKitAsPack(kit)

    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('音声が設定されていません')
    expect(result.files.map((file) => file.path)).toEqual(['safe-kit-manifest.json'])
    const manifest = JSON.parse(await result.files[0].blob.text()) as { events: unknown }
    expect(manifest.events).toEqual({})
  })
})
