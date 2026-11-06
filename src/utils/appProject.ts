/**
 * The project folder the player app plays (the folder on disk the user chose there, the same one Studio's Scene tab
 * opens), read over HTTP as if it were a folder: the app answers `<base><path>` with the file (Range support, so the
 * video streams; its modification time in `x-mtime-ms`) and `<base><dir>?list` with a folder's entries. Nothing is
 * cached: every read goes to the disk, so what Studio saves into the folder (the cue table, the Kit, viewer-data.json,
 * WAVs) is what the next read returns, with its real lastModified, and the store's checks see the change. The object
 * stands in for a FileSystemDirectoryHandle wherever sceneProject / sceneKit / sceneStore take one. Read-only: nothing
 * can be created, written or removed from here (Studio writes the folder, the player only plays it).
 */

interface ListEntry { name: string; kind: 'file' | 'directory'; size: number; mtimeMs: number }

const readOnly = (what: string) => new DOMException(`${what}: the player does not write the project`, 'NoModificationAllowedError')
/** isNotFound() in sceneProject.ts tests exactly this name. */
const notFound = (what: string) => new DOMException(`${what} is not in the project folder`, 'NotFoundError')
const mismatch = (what: string) => new DOMException(`${what} is another kind of entry`, 'TypeMismatchError')

const join = (dir: string, name: string) => dir ? `${dir}/${name}` : name
const fileUrl = (base: string, path: string) => new URL(path.split('/').map(encodeURIComponent).join('/'), base).href

/** The entries of folder `path` (the app's `?list`); NotFoundError when it is not a folder of the project. */
async function list(base: string, path: string): Promise<ListEntry[]> {
  const response = await fetch(`${path ? fileUrl(base, path) : base}?list`, { cache: 'no-store' })
  if (response.status === 404) throw notFound(path || 'the project folder')
  if (!response.ok) throw new Error(`${path || '/'}: HTTP ${response.status}`)
  const body = await response.json() as { entries?: unknown }
  if (!Array.isArray(body.entries)) throw new Error(`${path || '/'}: no entry list`)
  return body.entries as ListEntry[]
}

abstract class AppEntry {
  abstract readonly kind: 'file' | 'directory'
  constructor(readonly name: string, readonly path: string, readonly base: string) {}
  async queryPermission(): Promise<PermissionState> { return 'granted' }
  async requestPermission(): Promise<PermissionState> { return 'granted' }
  async isSameEntry(other: unknown): Promise<boolean> {
    return other instanceof AppEntry && other.kind === this.kind && other.base === this.base && other.path === this.path
  }
}

class AppFile extends AppEntry {
  readonly kind = 'file' as const
  async getFile(): Promise<File> {
    const response = await fetch(fileUrl(this.base, this.path), { cache: 'no-store' })
    if (response.status === 404) throw notFound(this.path)
    if (!response.ok) throw new Error(`${this.path}: HTTP ${response.status}`)
    const blob = await response.blob()
    const mtime = Number(response.headers.get('x-mtime-ms'))
    return new File([blob], this.name, { type: blob.type || (response.headers.get('content-type') ?? ''), lastModified: Number.isFinite(mtime) ? mtime : 0 })
  }
  async createWritable(): Promise<never> { throw readOnly(this.path) }
}

class AppDirectory extends AppEntry {
  readonly kind = 'directory' as const
  private async entry(name: string, create: boolean | undefined, kind: 'file' | 'directory'): Promise<ListEntry> {
    const found = (await list(this.base, this.path)).find(e => e.name === name)
    if (!found) throw create ? readOnly(join(this.path, name)) : notFound(join(this.path, name))
    if (found.kind !== kind) throw mismatch(join(this.path, name))
    return found
  }
  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<AppDirectory> {
    await this.entry(name, options?.create, 'directory')
    return new AppDirectory(name, join(this.path, name), this.base)
  }
  async getFileHandle(name: string, options?: { create?: boolean }): Promise<AppFile> {
    await this.entry(name, options?.create, 'file')
    return new AppFile(name, join(this.path, name), this.base)
  }
  async *entries(): AsyncGenerator<[string, AppFile | AppDirectory]> {
    for (const e of await list(this.base, this.path)) {
      const path = join(this.path, e.name)
      yield [e.name, e.kind === 'directory' ? new AppDirectory(e.name, path, this.base) : new AppFile(e.name, path, this.base)]
    }
  }
  async *keys(): AsyncGenerator<string> { for await (const [name] of this.entries()) yield name }
  async *values(): AsyncGenerator<AppFile | AppDirectory> { for await (const [, handle] of this.entries()) yield handle }
  [Symbol.asyncIterator]() { return this.entries() }
  async removeEntry(name: string): Promise<never> { throw readOnly(join(this.path, name)) }
  async resolve(descendant: unknown): Promise<string[] | null> {
    if (!(descendant instanceof AppEntry) || descendant.base !== this.base) return null
    if (descendant.path === this.path) return []
    const prefix = this.path ? `${this.path}/` : ''
    return descendant.path.startsWith(prefix) ? descendant.path.slice(prefix.length).split('/') : null
  }
}

/**
 * The app's project folder as a directory handle named `name` (the folder's name); rejects with NotFoundError when the
 * app has no project (a relative base resolves against the page).
 */
export async function openAppProject(name: string, base = '/__project/'): Promise<FileSystemDirectoryHandle> {
  const absolute = typeof location === 'undefined' ? base : new URL(base, location.href).href
  await list(absolute, '')
  return new AppDirectory(name, '', absolute) as unknown as FileSystemDirectoryHandle
}

export const isAppProject = (handle: unknown) => handle instanceof AppDirectory

/** The absolute URL of `path` under the app's project folder; null for any other handle (a folder Studio opened itself). */
export function appProjectFileUrl(handle: unknown, path: string): string | null {
  if (!(handle instanceof AppDirectory)) return null
  return fileUrl(handle.base, join(handle.path, path))
}

/**
 * What the files of folder `dir` that `keep` picks are now (name, size, modification time; one listing, no file is
 * read): two stamps differ when one of them was written, added or removed. "" when the folder does not exist.
 */
export async function appFolderStamp(handle: unknown, dir: string, keep: (name: string) => boolean): Promise<string> {
  if (!(handle instanceof AppDirectory)) throw new Error('not the app project')
  let entries: ListEntry[]
  try { entries = await list(handle.base, join(handle.path, dir)) } catch (error) {
    if (error instanceof DOMException && error.name === 'NotFoundError') return ''
    throw error
  }
  return entries.filter(e => e.kind === 'file' && keep(e.name)).map(e => `${e.name}:${e.size}:${e.mtimeMs}`).sort().join('|')
}
