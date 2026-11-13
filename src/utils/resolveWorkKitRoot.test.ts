import { describe, expect, it } from 'vitest'
import { resolveWorkKitRoot } from './localDirectory'

type Node = { [name: string]: Node | 'file' }

/** A minimal FileSystemDirectoryHandle over a tree (created dirs are recorded in the tree). */
function dir(name: string, tree: Node): FileSystemDirectoryHandle {
  const h = {
    name,
    kind: 'directory',
    async getDirectoryHandle(n: string, opts?: { create?: boolean }) {
      if (!(n in tree)) { if (!opts?.create) throw new DOMException('missing', 'NotFoundError'); tree[n] = {} }
      if (tree[n] === 'file') throw new TypeError('not a dir')
      return dir(n, tree[n] as Node)
    },
    async getFileHandle(n: string) {
      if (tree[n] !== 'file') throw new DOMException('missing', 'NotFoundError')
      return { name: n, kind: 'file' }
    },
    async *values() {
      for (const [n, v] of Object.entries(tree)) yield v === 'file' ? { name: n, kind: 'file' } : dir(n, v)
    },
  }
  return h as unknown as FileSystemDirectoryHandle
}

describe('resolveWorkKitRoot', () => {
  it('uses kits/ when it exists, even beside a Kit folder directly in the work folder', async () => {
    const root = await resolveWorkKitRoot(dir('work', { clips: {}, kits: {}, old: { 'old-manifest.json': 'file' } }))
    expect(root.name).toBe('kits')
  })

  it('keeps a work folder from before kits/ (Kit folders directly in it) as it is', async () => {
    const tree: Node = { clips: {}, a: { 'a-manifest.json': 'file' } }
    const root = await resolveWorkKitRoot(dir('work', tree))
    expect(root.name).toBe('work')
    expect('kits' in tree).toBe(false)
  })

  it('makes kits/ in a work folder with no Kit yet', async () => {
    const tree: Node = { clips: {}, _archive: { x: { 'x-manifest.json': 'file' } } }
    const root = await resolveWorkKitRoot(dir('work', tree))
    expect(root.name).toBe('kits')
    expect('kits' in tree).toBe(true)
  })
})
