import { describe, it, expect, vi } from 'vitest'
import type { KitDefinition } from '@/types/library'
import {
  exportKitAsPack,
  findDuplicateEventIds,
  manifestFileName,
  toKitId,
  validateEventIds,
} from './kitExporter'

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

describe('findDuplicateEventIds', () => {
  it('reports one Event ID shared by distinct Kit events only once', () => {
    const kit = {
      events: [
        { id: 'event-a', eventId: 'safe-kit.hit' },
        { id: 'event-b', eventId: 'safe-kit.hit' },
        { id: 'event-c', eventId: 'safe-kit.other' },
        { id: 'event-d', eventId: 'safe-kit.hit' },
        { id: 'event-empty-a', eventId: '' },
        { id: 'event-empty-b', eventId: '' },
      ],
    } as KitDefinition

    expect(findDuplicateEventIds(kit)).toEqual(['safe-kit.hit'])
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

function pcm16MonoWav(): Blob {
  const bytes = new Uint8Array(46)
  const view = new DataView(bytes.buffer)
  const ascii = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i)
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 38, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, 16000, true)
  view.setUint32(28, 32000, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, 2, true)
  view.setInt16(44, 1000, true)
  return new Blob([bytes], { type: 'audio/wav' })
}

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

    const result = await exportKitAsPack(kit, async () => undefined)

    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('音声が設定されていません')
    expect(result.files.map((file) => file.path)).toEqual(['safe-kit-manifest.json'])
    const manifest = JSON.parse(await result.files[0].blob.text()) as { events: unknown }
    expect(manifest.events).toEqual({})
  })

  it('rejects duplicate Event IDs before one manifest entry can overwrite another', async () => {
    const source = pcm16MonoWav()
    const resolveAudio = vi.fn(async () => source)
    const event = (id: string, clipName: string): KitDefinition['events'][number] => ({
      id,
      eventId: 'safe-kit.hit',
      clipName,
      clipSourceFilename: `${clipName}.wav`,
      clipDuration: 1 / 16000,
      clipChannels: 1,
      clipSampleRate: 16000,
      clipFileSize: source.size,
      modes: ['command'],
      loop: false,
      intensity: 0.5,
      deviceWiper: null,
    })
    const kit: KitDefinition = {
      id: 'kit-duplicate',
      name: 'safe-kit',
      version: '1.0.0',
      description: '',
      createdAt: '2026-07-27T00:00:00.000Z',
      updatedAt: '2026-07-27T00:00:00.000Z',
      events: [event('event-a', 'soft-hit'), event('event-b', 'hard-hit')],
    }

    const result = await exportKitAsPack(kit, resolveAudio)

    expect(result.errors).toEqual([
      '同じ Event ID は Kit 内で複数定義できません: "safe-kit.hit"',
    ])
    expect(resolveAudio).not.toHaveBeenCalled()
    expect(result.files.filter((file) => file.path.endsWith('.wav'))).toEqual([])
    const manifestFile = result.files.find((file) => file.path.endsWith('-manifest.json'))!
    const manifest = JSON.parse(await manifestFile.blob.text()) as { events: unknown }
    expect(manifest.events).toEqual({})
  })

  it('shares one generated WAV while keeping per-event parameters', async () => {
    const source = pcm16MonoWav()
    const event = (id: string, eventId: string, clipName: string, intensity: number): KitDefinition['events'][number] => ({
      id,
      eventId,
      clipName,
      clipSourceFilename: 'shared-source.wav',
      clipDuration: 1 / 16000,
      clipChannels: 1,
      clipSampleRate: 16000,
      clipFileSize: source.size,
      modes: ['command'],
      loop: false,
      intensity,
      deviceWiper: null,
    })
    const kit: KitDefinition = {
      id: 'kit-shared',
      name: 'shared-kit',
      version: '1.0.0',
      description: '',
      createdAt: '2026-07-27T00:00:00.000Z',
      updatedAt: '2026-07-27T00:00:00.000Z',
      events: [
        event('event-a', 'shared-kit.soft', 'soft-hit', 0.25),
        event('event-b', 'shared-kit.hard', 'hard-hit', 0.8),
      ],
    }

    const result = await exportKitAsPack(kit, async () => source)

    expect(result.errors).toEqual([])
    expect(result.files.filter((file) => file.path.startsWith('install-clips/'))).toHaveLength(1)
    expect(result.files.some((file) => file.path.startsWith('source/'))).toBe(false)
    const manifestFile = result.files.find((file) => file.path.endsWith('-manifest.json'))!
    const manifest = JSON.parse(await manifestFile.blob.text()) as {
      events: Record<string, { clip: string; parameters: { intensity: number } }>
    }
    expect(manifest.events['shared-kit.soft'].clip).toBe('soft-hit.wav')
    expect(manifest.events['shared-kit.hard'].clip).toBe('soft-hit.wav')
    expect(manifest.events['shared-kit.soft'].parameters.intensity).toBe(0.25)
    expect(manifest.events['shared-kit.hard'].parameters.intensity).toBe(0.8)
  })
})
