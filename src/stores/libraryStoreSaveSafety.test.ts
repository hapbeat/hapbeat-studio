import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KitDefinition } from '@/types/library'

const mocks = vi.hoisted(() => ({
  exportKitAsPack: vi.fn(),
  writeKitFolder: vi.fn(),
  loadKitDiskCache: vi.fn(),
  saveKitDiskCache: vi.fn(),
  scanKitOutputFolder: vi.fn(),
}))

vi.mock('@/utils/kitExporter', async () => {
  const actual = await vi.importActual<typeof import('@/utils/kitExporter')>('@/utils/kitExporter')
  return { ...actual, exportKitAsPack: mocks.exportKitAsPack }
})

vi.mock('@/utils/localDirectory', async () => {
  const actual = await vi.importActual<typeof import('@/utils/localDirectory')>('@/utils/localDirectory')
  return {
    ...actual,
    writeKitFolder: mocks.writeKitFolder,
    loadKitDiskCache: mocks.loadKitDiskCache,
    saveKitDiskCache: mocks.saveKitDiskCache,
    scanKitOutputFolder: mocks.scanKitOutputFolder,
  }
})

import { useLibraryStore } from './libraryStore'

const kit: KitDefinition = {
  id: 'kit-1',
  name: 'safe-kit',
  version: '1.0.0',
  description: '',
  createdAt: '2026-07-27T00:00:00.000Z',
  updatedAt: '2026-07-27T00:00:00.000Z',
  events: [],
}

afterEach(() => {
  mocks.exportKitAsPack.mockReset()
  mocks.writeKitFolder.mockReset()
  mocks.loadKitDiskCache.mockReset()
  mocks.saveKitDiskCache.mockReset()
  mocks.scanKitOutputFolder.mockReset()
  vi.unstubAllGlobals()
  useLibraryStore.setState({
    kits: [],
    activeKitId: null,
    workDirHandle: null,
    kitDirHandle: null,
    localFsStatus: 'idle',
    localFsLastMsg: '',
  })
})

describe('flushKitFolderNow — missing source audio', () => {
  it('aborts before writing any file when export reports an error', async () => {
    mocks.exportKitAsPack.mockResolvedValue({
      kitId: 'safe-kit',
      warnings: ['missing source'],
      errors: ['missing source'],
      files: [{
        path: 'safe-kit-manifest.json',
        blob: new Blob(['{}']),
        outputHash: null,
        cached: false,
      }],
    })
    useLibraryStore.setState({
      kits: [kit],
      workDirHandle: { name: 'kits' } as FileSystemDirectoryHandle,
    })

    const result = await useLibraryStore.getState().flushKitFolderNow(kit.id)

    expect(result).toBeNull()
    expect(mocks.writeKitFolder).not.toHaveBeenCalled()
    expect(useLibraryStore.getState().localFsStatus).toBe('error')
    expect(useLibraryStore.getState().localFsLastMsg).toContain('中止しました')
  })
})

describe('flushKitFolderNow — non-destructive Save Folder', () => {
  it('leaves an unreferenced WAV untouched', async () => {
    const removeEntry = vi.fn()
    const orphanDir = {
      values: async function* () {
        yield { kind: 'file', name: 'orphan.wav' }
      },
      removeEntry,
    }
    const kitDir = {
      getFileHandle: vi.fn().mockRejectedValue(new Error('missing manifest')),
      getDirectoryHandle: vi.fn().mockResolvedValue(orphanDir),
    }
    const root = {
      name: 'kits',
      getDirectoryHandle: vi.fn().mockResolvedValue(kitDir),
    } as unknown as FileSystemDirectoryHandle

    mocks.exportKitAsPack.mockResolvedValue({
      kitId: 'safe-kit',
      warnings: [],
      errors: [],
      files: [{
        path: 'safe-kit-manifest.json',
        blob: new Blob(['{}']),
        outputHash: null,
        cached: false,
      }],
    })
    mocks.loadKitDiskCache.mockResolvedValue(null)
    mocks.saveKitDiskCache.mockResolvedValue(undefined)
    useLibraryStore.setState({ kits: [kit], workDirHandle: root })

    const result = await useLibraryStore.getState().flushKitFolderNow(kit.id)

    expect(result?.kitId).toBe('safe-kit')
    expect(mocks.writeKitFolder).toHaveBeenCalledOnce()
    expect(removeEntry).not.toHaveBeenCalled()
  })
})

describe('sample-kit repair', () => {
  it('writes only missing canonical files and preserves existing ones', async () => {
    const installDir = {
      getFileHandle: vi.fn().mockRejectedValue(new Error('missing WAV')),
    }
    const sampleDir = {
      getFileHandle: vi.fn(async (name: string) => {
        if (name === 'sample-kit-manifest.json') return { name }
        throw new Error('missing file')
      }),
      getDirectoryHandle: vi.fn().mockResolvedValue(installDir),
    }
    const root = {
      name: 'kits',
      getDirectoryHandle: vi.fn().mockResolvedValue(sampleDir),
    } as unknown as FileSystemDirectoryHandle
    mocks.scanKitOutputFolder.mockResolvedValue([])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      blob: async () => new Blob(['canonical WAV']),
    }))
    useLibraryStore.setState({ workDirHandle: root })

    await useLibraryStore.getState().importKitsFromOutputDir()

    expect(mocks.writeKitFolder).toHaveBeenCalledOnce()
    const [, kitId, files] = mocks.writeKitFolder.mock.calls[0]
    expect(kitId).toBe('sample-kit')
    expect(files.map((file: { path: string }) => file.path)).toEqual([
      'install-clips/sine_50hz.wav',
      'install-clips/sine_100hz.wav',
      'install-clips/sine_200hz.wav',
    ])
    expect(files.some((file: { path: string }) => file.path === 'sample-kit-manifest.json')).toBe(false)
  })
})
