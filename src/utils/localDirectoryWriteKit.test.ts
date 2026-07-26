import { describe, it, expect, vi } from 'vitest'
import { writeKitFolder, writeKitManifestLast } from './localDirectory'

describe('writeKitFolder', () => {
  it('reacquires the Kit directory before every output file', async () => {
    let directoryLookups = 0
    const written: string[] = []

    const root = {
      getDirectoryHandle: async () => {
        directoryLookups++
        let valid = true
        return {
          getFileHandle: async (name: string) => {
            if (!valid) throw new DOMException('stale child handle', 'InvalidStateError')
            return {
              createWritable: async () => ({
                write: async () => { written.push(name) },
                close: async () => { valid = false },
              }),
            }
          },
        }
      },
    } as unknown as FileSystemDirectoryHandle

    await writeKitFolder(root, 'beat', [
      { path: 'beat.wav', blob: new Blob(['audio']) },
      { path: 'beat-manifest.json', blob: new Blob(['{}']) },
    ])

    expect(directoryLookups).toBe(2)
    expect(written).toEqual(['beat.wav', 'beat-manifest.json'])
  })
})

describe('writeKitManifestLast', () => {
  it('archives a stale existing manifest before recreating the canonical path', async () => {
    const oldBlob = new Blob(['{"version":"1.0.0"}'], { type: 'application/json' })
    const newBlob = new Blob(['{"version":"1.0.1"}'], { type: 'application/json' })
    let canonicalExists = true
    let canonicalWritten: Blob | null = null
    let archivedBlob: Blob | null = null
    const removeEntry = vi.fn(async (name: string) => {
      expect(name).toBe('beat-manifest.json')
      canonicalExists = false
    })

    const archiveHandle = {
      createWritable: async () => ({
        write: async (blob: Blob) => { archivedBlob = blob },
        close: async () => undefined,
      }),
      getFile: async () => ({ size: archivedBlob?.size ?? 0 }),
    }
    const historyDir = {
      getFileHandle: async (_name: string, options?: { create?: boolean }) => {
        if (!options?.create) throw new DOMException('missing', 'NotFoundError')
        return archiveHandle
      },
    }
    const kitDir = {
      getDirectoryHandle: async (name: string) => {
        expect(name).toBe('history')
        return historyDir
      },
      getFileHandle: async (name: string) => {
        expect(name).toBe('beat-manifest.json')
        if (canonicalExists) {
          return {
            getFile: async () => ({
              type: 'application/json',
              arrayBuffer: () => oldBlob.arrayBuffer(),
            }),
            createWritable: async () => {
              throw new DOMException('stale existing entry', 'InvalidStateError')
            },
          }
        }
        return {
          createWritable: async () => ({
            write: async (blob: Blob) => { canonicalWritten = blob },
            close: async () => undefined,
          }),
        }
      },
      removeEntry,
    }
    const root = {
      getDirectoryHandle: async () => kitDir,
    } as unknown as FileSystemDirectoryHandle

    const archivedPath = await writeKitManifestLast(
      root,
      'beat',
      'beat-manifest.json',
      newBlob,
    )

    expect(archivedPath).toMatch(/^history\/beat-manifest-replaced-/)
    expect(await (archivedBlob as Blob | null)?.text()).toBe(await oldBlob.text())
    expect(await (canonicalWritten as Blob | null)?.text()).toBe(await newBlob.text())
    expect(removeEntry).toHaveBeenCalledOnce()
  })

  it('leaves the canonical manifest untouched when it cannot archive the old bytes', async () => {
    const removeEntry = vi.fn()
    const kitDir = {
      getFileHandle: async () => ({
        createWritable: async () => {
          throw new DOMException('stale existing entry', 'InvalidStateError')
        },
        getFile: async () => {
          throw new DOMException('cannot read old manifest', 'InvalidStateError')
        },
      }),
      removeEntry,
    }
    const root = {
      getDirectoryHandle: async () => kitDir,
    } as unknown as FileSystemDirectoryHandle

    await expect(writeKitManifestLast(
      root,
      'beat',
      'beat-manifest.json',
      new Blob(['{}']),
    )).rejects.toMatchObject({ name: 'InvalidStateError' })
    expect(removeEntry).not.toHaveBeenCalled()
  })
})