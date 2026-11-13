import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KitDefinition } from '@/types/library'

const mocks = vi.hoisted(() => ({
  exportKitAsPack: vi.fn(),
  writeKitFolder: vi.fn(),
  writeKitManifestLast: vi.fn(),
  loadKitDiskCache: vi.fn(),
  saveKitDiskCache: vi.fn(),
  scanKitOutputFolder: vi.fn(),
  readKitClipFile: vi.fn(),
  writeMetadataJson: vi.fn(),
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
    writeKitManifestLast: mocks.writeKitManifestLast,
    loadKitDiskCache: mocks.loadKitDiskCache,
    saveKitDiskCache: mocks.saveKitDiskCache,
    scanKitOutputFolder: mocks.scanKitOutputFolder,
    readKitClipFile: mocks.readKitClipFile,
    writeMetadataJson: mocks.writeMetadataJson,
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
  mocks.writeKitManifestLast.mockReset()
  mocks.writeKitManifestLast.mockResolvedValue(null)
  mocks.loadKitDiskCache.mockReset()
  mocks.saveKitDiskCache.mockReset()
  mocks.scanKitOutputFolder.mockReset()
  mocks.readKitClipFile.mockReset()
  mocks.writeMetadataJson.mockReset()
  mocks.writeMetadataJson.mockResolvedValue(undefined)
  vi.useRealTimers()
  vi.unstubAllGlobals()
  useLibraryStore.setState({
    kits: [],
    activeKitId: null,
    workDirHandle: null,
    workKitRoot: null,
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
    useLibraryStore.setState({ kits: [kit], workKitRoot: root })

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
      clipGain: 0.5,
      deviceWiper: null,
    }

    const firstId = await useLibraryStore.getState().addEventToKit(kit.id, event, blob)
    const secondId = await useLibraryStore.getState().addEventToKit(
      kit.id,
      { ...event, clipName: 'hard-hit', clipSourceFilename: 'other.wav', clipGain: 0.8 },
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

  it('stores already device-ready 16 kHz stereo audio under source too', async () => {
    const root = { name: 'kits' } as FileSystemDirectoryHandle
    const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/wav' })
    mocks.readKitClipFile.mockResolvedValue(null)
    useLibraryStore.setState({ kits: [kit], workKitRoot: root })

    const event: Omit<KitDefinition['events'][number], 'id'> = {
      eventId: '',
      clipName: 'ready-stereo',
      clipSourceFilename: 'ready-stereo.wav',
      clipDuration: 1,
      clipChannels: 2,
      clipSampleRate: 16000,
      clipFileSize: blob.size,
      modes: ['stream_clip'],
      loop: false,
      clipGain: 0.5,
      deviceWiper: null,
    }

    const id = await useLibraryStore.getState().addEventToKit(kit.id, event, blob)

    expect(id).toBeTruthy()
    expect(mocks.writeKitFolder).toHaveBeenCalledWith(
      root,
      'safe-kit',
      [{ path: 'source/ready-stereo.wav', blob }],
    )
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
      workDirHandle: { name: 'kits' } as FileSystemDirectoryHandle, workKitRoot: { name: 'kits' } as FileSystemDirectoryHandle,
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
      clipGain: 1,
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
    useLibraryStore.setState({ kits: [kitWithAudio], workKitRoot: root })

    const result = await useLibraryStore.getState().flushKitFolderNow(kit.id)

    expect(result?.kitId).toBe('safe-kit')
    expect(mocks.readKitClipFile).toHaveBeenCalledWith(
      root,
      'safe-kit',
      'install-clips',
      'shared.wav',
    )
    expect(mocks.writeKitFolder).toHaveBeenCalledTimes(2)
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
    useLibraryStore.setState({ kits: [kit], workDirHandle: root, workKitRoot: root })

    const result = await useLibraryStore.getState().flushKitFolderNow(kit.id)

    expect(result?.kitId).toBe('safe-kit')
    expect(mocks.writeKitFolder).toHaveBeenCalledTimes(1)
    expect(mocks.writeKitManifestLast).toHaveBeenCalledOnce()
    expect(removeEntry).not.toHaveBeenCalled()
  })
})

describe('Kit continuous parameter editing', () => {
  it('updates volume synchronously and coalesces kits-meta.json writes', async () => {
    vi.useFakeTimers()
    const root = { name: 'library' } as FileSystemDirectoryHandle
    useLibraryStore.setState({ kits: [kit], workDirHandle: root, workKitRoot: root })

    const pending: Promise<void>[] = []
    for (let volume = 1; volume <= 40; volume++) {
      pending.push(useLibraryStore.getState().updateKit(kit.id, {
        targetDevice: { volume_level: volume },
      }))
      // Controlled UI state must be visible before any Promise / disk write.
      expect(useLibraryStore.getState().kits[0].targetDevice?.volume_level).toBe(volume)
    }

    expect(mocks.writeMetadataJson).not.toHaveBeenCalled()
    await Promise.all(pending)
    await vi.advanceTimersByTimeAsync(399)
    expect(mocks.writeMetadataJson).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)

    expect(mocks.writeMetadataJson).toHaveBeenCalledOnce()
    const [handle, filename, savedKits] = mocks.writeMetadataJson.mock.calls[0]
    expect(handle).toBe(root)
    expect(filename).toBe('kits-meta.json')
    expect((savedKits as KitDefinition[])[0].targetDevice?.volume_level).toBe(40)
  })

  it('flushes the latest debounced metadata once when Save is pressed immediately', async () => {
    vi.useFakeTimers()
    const root = { name: 'library' } as FileSystemDirectoryHandle
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
    useLibraryStore.setState({ kits: [kit], workDirHandle: root, workKitRoot: root })

    await useLibraryStore.getState().updateKit(kit.id, {
      targetDevice: { volume_level: 77 },
    })
    expect(mocks.writeMetadataJson).not.toHaveBeenCalled()

    const saved = await useLibraryStore.getState().flushKitFolderNow(kit.id)
    expect(saved?.kitId).toBe('safe-kit')
    expect(mocks.writeMetadataJson).toHaveBeenCalledOnce()
    const savedKits = mocks.writeMetadataJson.mock.calls[0][2] as KitDefinition[]
    expect(savedKits[0].targetDevice?.volume_level).toBe(77)

    await vi.advanceTimersByTimeAsync(400)
    expect(mocks.writeMetadataJson).toHaveBeenCalledOnce()
  })
})
describe('Kit operation ordering', () => {
  it('applies an immediate remove before Save captures its manifest snapshot', async () => {
    const makeEvent = (id: string, name: string): KitDefinition['events'][number] => ({
      id,
      eventId: `safe-kit.${name}`,
      clipName: name,
      clipSourceFilename: `${name}.wav`,
      clipDuration: 1,
      clipChannels: 1,
      clipSampleRate: 16000,
      clipFileSize: 4,
      modes: ['command'],
      loop: false,
      clipGain: 1,
      deviceWiper: null,
    })
    const removed = makeEvent('remove-me', 'old')
    const kept = makeEvent('keep-me', 'current')
    const kitWithEvents: KitDefinition = { ...kit, events: [removed, kept] }
    const root = { name: 'kits' } as FileSystemDirectoryHandle
    const diskFile = {
      name: 'current.wav',
      size: 4,
      type: 'audio/wav',
      arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
    }
    mocks.readKitClipFile.mockResolvedValue(diskFile)
    mocks.loadKitDiskCache.mockResolvedValue(null)
    mocks.saveKitDiskCache.mockResolvedValue(undefined)

    let exportedEventIds: string[] = []
    mocks.exportKitAsPack.mockImplementation(async (snapshot, resolveEventAudio) => {
      exportedEventIds = snapshot.events.map((event: KitDefinition['events'][number]) => event.id)
      for (const event of snapshot.events) await resolveEventAudio(event)
      return {
        kitId: 'safe-kit',
        warnings: [],
        errors: [],
        files: [{
          path: 'safe-kit-manifest.json',
          blob: new Blob(['{"events":{"safe-kit.current":{}}}']),
          outputHash: null,
          cached: false,
        }],
      }
    })
    useLibraryStore.setState({ kits: [kitWithEvents], workKitRoot: root })

    // Deliberately do not await the remove before requesting Save. Registering
    // both operations in the same turn reproduces the user's × → Save sequence.
    const removing = useLibraryStore.getState().removeEventFromKit(kit.id, removed.id)
    const saving = useLibraryStore.getState().flushKitFolderNow(kit.id)
    const [, result] = await Promise.all([removing, saving])

    expect(result?.kitId).toBe('safe-kit')
    expect(exportedEventIds).toEqual(['keep-me'])
    const metadataWrite = mocks.writeKitFolder.mock.calls.find(([, , files]) => (
      files.some((file: { path: string }) => file.path === '.studio-kit.json')
    ))
    expect(metadataWrite).toBeTruthy()
    const metadataBlob = metadataWrite?.[2][0].blob as Blob
    const metadata = JSON.parse(await metadataBlob.text()) as KitDefinition
    expect(metadata.events.map((event) => event.id)).toEqual(['keep-me'])
    expect(mocks.writeKitManifestLast).toHaveBeenCalledWith(
      root,
      'safe-kit',
      'safe-kit-manifest.json',
      expect.any(Blob),
    )
    const writeOrders = mocks.writeKitFolder.mock.invocationCallOrder
    const metadataWriteOrder = writeOrders[writeOrders.length - 1] ?? 0
    const manifestWriteOrder = mocks.writeKitManifestLast.mock.invocationCallOrder[0] ?? 0
    expect(manifestWriteOrder).toBeGreaterThan(metadataWriteOrder)
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
    useLibraryStore.setState({ workDirHandle: root, workKitRoot: root })

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

describe('Kit folders with the strength key before DEC-103', () => {
  const manifest = (parameters: Record<string, unknown>) => ({
    schema_version: '2.0.0', name: 'k', version: '1.0.0',
    events: { 'k.hit': { clip: 'hit.wav', parameters: { loop: false, ...parameters } } },
  })
  const scan = (...kits: [string, Record<string, unknown>][]) => mocks.scanKitOutputFolder.mockResolvedValue(
    kits.map(([folderName, parameters]) => ({ folderName, manifestJson: manifest(parameters), clipFiles: new Map() })))

  it('a manifest with parameters.intensity and no clip_gain is not taken in (not read as 1.0), and the status says to convert it', async () => {
    vi.stubGlobal('AudioContext', class { decodeAudioData() { return Promise.resolve({ duration: 0, numberOfChannels: 1, sampleRate: 16000 }) } })
    const root = { name: 'kits', getDirectoryHandle: vi.fn().mockRejectedValue(new DOMException('missing', 'NotFoundError')) } as unknown as FileSystemDirectoryHandle
    useLibraryStore.setState({ workKitRoot: root })
    scan(['stale-kit', { intensity: 0.3 }], ['new-kit', { clip_gain: 0.3 }], ['plain-kit', {}])

    const found = await useLibraryStore.getState().importKitsFromOutputDir()

    const kits = useLibraryStore.getState().kits
    expect(kits.map((k) => k.name)).toEqual(['new-kit', 'plain-kit'])
    // Another key is read as before: clip_gain as written, none = the default 1.0.
    expect(kits.map((k) => k.events[0].clipGain)).toEqual([0.3, 1])
    // The refused folder counts as found, so kits-meta.json is not shown in its place.
    expect(found).toBe(3)
    expect(useLibraryStore.getState().localFsStatus).toBe('error')
    expect(useLibraryStore.getState().localFsLastMsg).toMatch(/kits\/stale-kit/)
    expect(useLibraryStore.getState().localFsLastMsg).toMatch(/events\.k\.hit/)
    expect(useLibraryStore.getState().localFsLastMsg).toMatch(/変換して開く|Convert and open/)
    expect(useLibraryStore.getState().oldClipGainFiles).toBe(1)
  })
})

describe('kits-meta.json with the strength key before DEC-103', () => {
  it('is neither used nor written over by a scan, and the status says to convert it', async () => {
    vi.stubGlobal('AudioContext', class { decodeAudioData() { return Promise.resolve({ duration: 0, numberOfChannels: 1, sampleRate: 16000 }) } })
    const meta = [{ ...kit, name: 'k', events: [{ id: 'ev-1', eventId: 'k.hit', intensity: 0.3, modes: ['command'] }] }]
    const work = {
      name: 'work',
      getDirectoryHandle: vi.fn().mockRejectedValue(new DOMException('missing', 'NotFoundError')),
      getFileHandle: vi.fn(async (name: string) => {
        if (name !== 'kits-meta.json') throw new DOMException('missing', 'NotFoundError')
        return { getFile: async () => ({ text: async () => JSON.stringify(meta) }) }
      }),
    } as unknown as FileSystemDirectoryHandle
    useLibraryStore.setState({ workDirHandle: work, workKitRoot: work })
    mocks.scanKitOutputFolder.mockResolvedValue([{ folderName: 'k', manifestJson: { name: 'k', events: { 'k.hit': { clip: 'hit.wav', parameters: { clip_gain: 0.3 } } } }, clipFiles: new Map() }])

    await useLibraryStore.getState().importKitsFromOutputDir()

    // The Kit comes from its manifest as before; kits-meta.json (its ids) is not used, nor written.
    expect(useLibraryStore.getState().kits[0].events[0]).toMatchObject({ eventId: 'k.hit', clipGain: 0.3 })
    expect(useLibraryStore.getState().kits[0].events[0].id).not.toBe('ev-1')
    expect(mocks.writeMetadataJson.mock.calls.map(([, file]) => file)).not.toContain('kits-meta.json')
    expect(useLibraryStore.getState().localFsLastMsg).toMatch(/work\/kits-meta\.json/)
    expect(useLibraryStore.getState().localFsLastMsg).toMatch(/k\/k\.hit/)
  })

  it('is not written over by a later write (+ Kit, a later save) until a scan finds it converted', async () => {
    vi.stubGlobal('AudioContext', class { decodeAudioData() { return Promise.resolve({ duration: 0, numberOfChannels: 1, sampleRate: 16000 }) } })
    let meta: unknown = [{ ...kit, name: 'k', events: [{ id: 'ev-1', eventId: 'k.hit', intensity: 0.3, modes: ['command'] }] }]
    const work = {
      name: 'work',
      getDirectoryHandle: vi.fn().mockRejectedValue(new DOMException('missing', 'NotFoundError')),
      getFileHandle: vi.fn(async (name: string) => {
        if (name !== 'kits-meta.json') throw new DOMException('missing', 'NotFoundError')
        return { getFile: async () => ({ text: async () => JSON.stringify(meta) }) }
      }),
    } as unknown as FileSystemDirectoryHandle
    useLibraryStore.setState({ workDirHandle: work, workKitRoot: work })
    mocks.scanKitOutputFolder.mockResolvedValue([{ folderName: 'k', manifestJson: { name: 'k', events: { 'k.hit': { clip: 'hit.wav', parameters: { clip_gain: 0.3 } } } }, clipFiles: new Map() }])
    const metaWrites = () => mocks.writeMetadataJson.mock.calls.filter(([, file]) => file === 'kits-meta.json').length

    await useLibraryStore.getState().importKitsFromOutputDir()
    await useLibraryStore.getState().createKit('added')
    expect(metaWrites()).toBe(0)
    // A later successful save keeps the notice.
    useLibraryStore.getState().setLocalFsStatus('saved', 'kit "added" saved')
    expect(useLibraryStore.getState().localFsStatus).toBe('error')
    expect(useLibraryStore.getState().localFsLastMsg).toMatch(/kits-meta\.json/)

    meta = [{ ...kit, name: 'k', events: [{ id: 'ev-1', eventId: 'k.hit', clipGain: 0.3, modes: ['command'] }] }]
    await useLibraryStore.getState().importKitsFromOutputDir()
    expect(metaWrites()).toBe(1)
    useLibraryStore.getState().setLocalFsStatus('saved', 'ok')
    expect(useLibraryStore.getState().localFsStatus).toBe('saved')
  })
})
