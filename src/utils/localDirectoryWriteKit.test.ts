import { describe, it, expect } from 'vitest'
import { writeKitFolder } from './localDirectory'

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
