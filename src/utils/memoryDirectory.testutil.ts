/** In-memory FileSystemDirectoryHandle for Node tests (agent / knowledge folder flows). */
export class MemoryDirectory {
  readonly kind = 'directory'
  readonly files = new Map<string, { blob: Blob; lastModified: number }>()
  readonly dirs = new Map<string, MemoryDirectory>()
  /** When set, file handles have move(name) running this (e.g. throwing like Chrome in a local folder). */
  fileMove: ((from: string, to: string) => Promise<void>) | null = null
  constructor(readonly name: string, private readonly clock: { now: number } = { now: 0 }) {}
  async getDirectoryHandle(name: string, options?: { create?: boolean }) {
    let dir = this.dirs.get(name)
    if (!dir) {
      if (this.files.has(name)) throw new DOMException('not a directory', 'TypeMismatchError')
      if (!options?.create) throw new DOMException('missing', 'NotFoundError')
      dir = new MemoryDirectory(name, this.clock); this.dirs.set(name, dir)
    }
    return dir
  }
  private fileHandle(name: string) {
    return {
      kind: 'file' as const, name,
      getFile: async () => { const entry = this.files.get(name)!; return new File([entry.blob], name, { lastModified: entry.lastModified }) },
      createWritable: async () => {
        let pending: Blob = new Blob([])
        return {
          write: async (value: Blob | string) => { pending = typeof value === 'string' ? new Blob([value]) : value },
          close: async () => { this.files.set(name, { blob: pending, lastModified: this.clock.now }) },
          abort: async () => {},
        }
      },
      ...(this.fileMove ? { move: (to: string) => this.fileMove!(name, to) } : {}),
    }
  }
  async getFileHandle(name: string, options?: { create?: boolean }) {
    if (!this.files.has(name)) {
      if (this.dirs.has(name)) throw new DOMException('not a file', 'TypeMismatchError')
      if (!options?.create) throw new DOMException('missing', 'NotFoundError')
      this.files.set(name, { blob: new Blob([]), lastModified: this.clock.now })
    }
    return this.fileHandle(name)
  }
  async *entries() {
    for (const [name, dir] of this.dirs) yield [name, dir] as const
    for (const name of this.files.keys()) yield [name, this.fileHandle(name)] as const
  }
  async *values() {
    for await (const [, handle] of this.entries()) yield handle
  }
  async removeEntry(name: string) {
    if (!this.files.delete(name) && !this.dirs.delete(name)) throw new DOMException('missing', 'NotFoundError')
  }
  private walk(path: string, create: boolean): { dir: MemoryDirectory | undefined; leaf: string } {
    const parts = path.split('/'), leaf = parts.pop()!
    let dir: MemoryDirectory | undefined = this
    for (const part of parts) {
      if (!dir) break
      if (create && !dir.dirs.has(part)) dir.dirs.set(part, new MemoryDirectory(part, this.clock))
      dir = dir.dirs.get(part)
    }
    return { dir, leaf }
  }
  put(path: string, content: string | Blob, lastModified = this.clock.now) {
    const { dir, leaf } = this.walk(path, true)
    dir!.files.set(leaf, { blob: typeof content === 'string' ? new Blob([content]) : content, lastModified })
  }
  has(path: string) { const { dir, leaf } = this.walk(path, false); return !!dir && (dir.files.has(leaf) || dir.dirs.has(leaf)) }
  size(path: string) { const { dir, leaf } = this.walk(path, false); return dir!.files.get(leaf)!.blob.size }
  async text(path: string) { const { dir, leaf } = this.walk(path, false); return dir!.files.get(leaf)!.blob.text() }
  async json<T = unknown>(path: string): Promise<T> { return JSON.parse(await this.text(path)) }
  asHandle() { return this as unknown as FileSystemDirectoryHandle }
}
