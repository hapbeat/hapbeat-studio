import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KitDefinition } from '@/types/library'

const mocks = vi.hoisted(() => ({
  exportKitAsPack: vi.fn(),
  writeKitFolder: vi.fn(),
  loadKitDiskCache: vi.fn(),
  saveKitDiskCache: vi.fn(),
  scanKitOutputFolder: vi.fn(),
  readKitClipFile: vi.fn(),
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
    readKitClipFile: mocks.readKitClipFile,
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
  mocks.readKitClipFile.mockReset()
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

describe('addEventToKit — disk source ownership', () => {
  it('stores the original under source/ and reuses identical bytes', async () => {
    const root = { name: 'kits' } as FileSystemDirectoryHandle
    const sourceBytes = new Uint8Array([10, 20, 30, 40])
    const blob = new Blob([sourceBytes], { type: 'audio/wav' })
    mocks.readKitClipFile
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        name: 'hit.wav',
        size: sourceBytes.byteLength,
        arrayBuffer: async () => sourceBytes.buffer,
      })
    useLibraryStore.setState({ kits: [kit], kitDirHandle: root })

    const event: Omit<KitDefinition['events'][number], 'id'> = {
      eventId: '',
      clipName: 'hit',
      clipSourceFilename: 'hit.wav',
      clipDuration: 1,
      clipChannels: 1,
      clipSampleRate: 44100,
      clipFileSize: blob.size,
      modes: ['command'],
      loop: false,
      intensity: 0.5,
      deviceWiper: null,
    }

    const firstId = await useLibraryStore.getState().addEventToKit(kit.id, event, blob)
    const secondId = await useLibraryStore.getState().addEventToKit(
      kit.id,
      { ...event, clipName: 'hard-hit', clipSourceFilename: 'other.wav', intensity: 0.8 },
      blob,
    )

    expect(firstId).toBeTruthy()
    expect(secondId).toBeTruthy()
    expect(mocks.writeKitFolder).toHaveBeenCalledOnce()
    expect(mocks.writeKitFolder).toHaveBeenCalledWith(
      root,
      'safe-kit',
      [{ path: 'source/hit.wav', blob }],
    )
    const events = useLibraryStore.getState().kits[0].events
    expect(events).toHaveLength(2)
    expect(events[0].clipSourceFilename).toBe('hit.wav')
    expect(events[1].clipSourceFilename).toBe('hit.wav')
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

describe('flushKitFolderNow — source audio resolution', () => {
  it('uses a legacy install-clips file and materialises source/ without IndexedDB', async () => {
    const event: KitDefinition['events'][number] = {
      id: 'event-on-disk',
      eventId: 'safe-kit.hit',
      clipName: 'hit',
      clipSourceFilename: 'hit.wav',
      clipOutputFilenames: { command: 'shared.wav' },
      clipDuration: 1,
      clipChannels: 1,
      clipSampleRate: 16000,
      clipFileSize: 4,
      modes: ['command'],
      loop: false,
      intensity: 1,
      deviceWiper: null,
    }
    const kitWithAudio: KitDefinition = { ...kit, events: [event] }
    const root = { name: 'kits' } as FileSystemDirectoryHandle
    const diskBytes = new Uint8Array([1, 2, 3, 4]).buffer

    mocks.readKitClipFile.mockImplementation(async (_root, _kit, subdir) => (
      subdir === 'install-clips'
        ? { name: 'shared.wav', size: 4, arrayBuffer: async () => diskBytes }
        : null
    ))
    mocks.exportKitAsPack.mockImplementation(async (exportedKit, resolveEventAudio) => {
      const blob = await resolveEventAudio(exportedKit.events[0])
      return {
        kitId: 'safe-kit',
        warnings: [],
        errors: blob ? [] : ['missing source'],
        files: [{
          path: 'safe-kit-manifest.json',
          blob: new Blob(['{}']),
          outputHash: null,
          cached: false,
        }],
      }
    })
    mocks.loadKitDiskCache.mockResolvedValue(null)
    mocks.saveKitDiskCache.mockResolvedValue(undefined)
    useLibraryStore.setState({ kits: [kitWithAudio], kitDirHandle: root })

    const result = await useLibraryStore.getState().flushKitFolderNow(kit.id)

    expect(result?.kitId).toBe('safe-kit')
    expect(mocks.readKitClipFile).toHaveBeenCalledWith(
      root,
      'safe-kit',
      'install-clips',
      'shared.wav',
    )
    expect(mocks.writeKitFolder).toHaveBeenCalledTimes(3)
    expect(mocks.writeKitFolder.mock.calls[0][2]).toEqual([
      { path: 'source/hit.wav', blob: expect.any(Blob) },
    ])
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
    expect(mocks.writeKitFolder).toHaveBeenCalledTimes(2)
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
