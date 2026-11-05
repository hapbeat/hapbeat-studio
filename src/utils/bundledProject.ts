/**
 * A game project the player app bundles, read over HTTP as if it were a folder: `tree.json` lists every file and
 * each file is fetched from `<base><path>` (the app answers with Range support, so the video streams). The object
 * stands in for a FileSystemDirectoryHandle wherever sceneProject / sceneKit / sceneStore take one. Read-only: nothing
 * can be created, written or removed. A file's lastModified comes from the list, so it never changes while the app
 * runs, and the store's "changed outside Studio" checks (checkOutside, refreshKit) never see a change.
 */

interface TreeFile { path: string; size?: number; mtimeMs: number }

const readOnly = (what: string) => new DOMException(`${what}: the bundled project is read-only`, 'NoModificationAllowedError')
/** isNotFound() in sceneProject.ts tests exactly this name. */
const notFound = (what: string) => new DOMException(`${what} is not in the bundled project`, 'NotFoundError')
const mismatch = (what: string) => new DOMException(`${what} is another kind of entry`, 'TypeMismatchError')

const fileUrl = (base: string, path: string) => new URL(path.split('/').map(encodeURIComponent).join('/'), base).href

abstract class BundledEntry {
  abstract readonly kind: 'file' | 'directory'
  constructor(readonly name: string, readonly path: string, readonly base: string) {}
  async queryPermission(): Promise<PermissionState> { return 'granted' }
  async requestPermission(): Promise<PermissionState> { return 'granted' }
  async isSameEntry(other: unknown): Promise<boolean> { return other === this }
}

class BundledFile extends BundledEntry {
  readonly kind = 'file' as const
  constructor(name: string, path: string, base: string, private readonly mtimeMs: number) { super(name, path, base) }
  async getFile(): Promise<File> {
    const response = await fetch(fileUrl(this.base, this.path))
    if (response.status === 404) throw notFound(this.path)
    if (!response.ok) throw new Error(`${this.path}: HTTP ${response.status}`)
    const blob = await response.blob()
    return new File([blob], this.name, { type: blob.type || (response.headers.get('content-type') ?? ''), lastModified: this.mtimeMs })
  }
  async createWritable(): Promise<never> { throw readOnly(this.path) }
}

class BundledDirectory extends BundledEntry {
  readonly kind = 'directory' as const
  readonly children = new Map<string, BundledFile | BundledDirectory>()
  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<BundledDirectory> {
    const entry = this.children.get(name)
    if (!entry) throw options?.create ? readOnly(name) : notFound(name)
    if (entry.kind !== 'directory') throw mismatch(name)
    return entry
  }
  async getFileHandle(name: string, options?: { create?: boolean }): Promise<BundledFile> {
    const entry = this.children.get(name)
    if (!entry) throw options?.create ? readOnly(name) : notFound(name)
    if (entry.kind !== 'file') throw mismatch(name)
    return entry
  }
  async *entries(): AsyncGenerator<[string, BundledFile | BundledDirectory]> { yield* this.children.entries() }
  async *keys(): AsyncGenerator<string> { yield* this.children.keys() }
  async *values(): AsyncGenerator<BundledFile | BundledDirectory> { yield* this.children.values() }
  [Symbol.asyncIterator]() { return this.entries() }
  async removeEntry(name: string): Promise<never> { throw readOnly(name) }
  async resolve(descendant: unknown): Promise<string[] | null> {
    if (!(descendant instanceof BundledEntry) || descendant.base !== this.base) return null
    if (descendant.path === this.path) return []
    const prefix = this.path ? `${this.path}/` : ''
    return descendant.path.startsWith(prefix) ? descendant.path.slice(prefix.length).split('/') : null
  }
}

function buildTree(name: string, files: readonly TreeFile[], base: string): BundledDirectory {
  const root = new BundledDirectory(name, '', base)
  for (const file of files) {
    const parts = file.path.split('/').filter(Boolean)
    let dir = root
    parts.slice(0, -1).forEach((part, i) => {
      let next = dir.children.get(part)
      if (!next) { next = new BundledDirectory(part, parts.slice(0, i + 1).join('/'), base); dir.children.set(part, next) }
      if (next.kind !== 'directory') throw new Error(`tree.json: ${file.path} runs through a file`)
      dir = next
    })
    const leaf = parts[parts.length - 1]
    if (leaf) dir.children.set(leaf, new BundledFile(leaf, parts.join('/'), base, file.mtimeMs))
  }
  return root
}

/** Reads `<base>tree.json` and returns the read-only project (a relative base resolves against the page). */
export async function openBundledProject(base = '/__project/'): Promise<FileSystemDirectoryHandle> {
  const absolute = typeof location === 'undefined' ? base : new URL(base, location.href).href
  const response = await fetch(new URL('tree.json', absolute).href)
  if (!response.ok) throw new Error(`tree.json: HTTP ${response.status}`)
  const tree = await response.json() as { name?: unknown; files?: unknown }
  if (!Array.isArray(tree.files)) throw new Error('tree.json: no file list')
  return buildTree(typeof tree.name === 'string' ? tree.name : 'project', tree.files as TreeFile[], absolute) as unknown as FileSystemDirectoryHandle
}

export const isBundledProject = (handle: unknown) => handle instanceof BundledDirectory

/** The absolute URL of `path` under a bundled project folder; null for any other handle (a real folder). */
export function bundledFileUrl(handle: unknown, path: string): string | null {
  if (!(handle instanceof BundledDirectory)) return null
  return fileUrl(handle.base, handle.path ? `${handle.path}/${path}` : path)
}
