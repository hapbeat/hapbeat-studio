/**
 * Local directory access via File System Access API (Chrome/Edge).
 *
 * Provides read/write to a user-chosen folder:
 *   <chosen-dir>/
 *     clips/        ← user's audio clips
 *     kits/         ← exported kit folders
 *
 * The directory handle is persisted in IndexedDB so the user
 * doesn't need to re-pick every session (permission re-grant may
 * still be required).
 */

import { openDB } from 'idb'

// ---- Feature detection ----

export function isFileSystemAccessSupported(): boolean {
  return typeof window.showDirectoryPicker === 'function'
}

// ---- Handle persistence in IndexedDB ----

const HANDLE_DB = 'hapbeat-studio-fs'
const HANDLE_STORE = 'handles'

/** IDB key for each persisted handle. `workdir` = clip library root,
 *  `kitdir` = optional separate kit output root (e.g. Unity Assets). */
export type DirectoryHandleKey = 'workdir' | 'kitdir'

async function getHandleDb() {
  return openDB(HANDLE_DB, 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(HANDLE_STORE)) {
        db.createObjectStore(HANDLE_STORE)
      }
    },
  })
}

export async function saveDirectoryHandle(handle: FileSystemDirectoryHandle, key: DirectoryHandleKey = 'workdir'): Promise<void> {
  const db = await getHandleDb()
  await db.put(HANDLE_STORE, handle, key)
}

export async function loadDirectoryHandle(key: DirectoryHandleKey = 'workdir'): Promise<FileSystemDirectoryHandle | null> {
  const db = await getHandleDb()
  return (await db.get(HANDLE_STORE, key)) ?? null
}

export async function clearDirectoryHandle(key: DirectoryHandleKey = 'workdir'): Promise<void> {
  const db = await getHandleDb()
  await db.delete(HANDLE_STORE, key)
}

// ---- Permission ----

export async function verifyPermission(
  handle: FileSystemDirectoryHandle,
  write = true,
): Promise<boolean> {
  const opts: FileSystemHandlePermissionDescriptor = { mode: write ? 'readwrite' : 'read' }
  if ((await handle.queryPermission(opts)) === 'granted') return true
  if ((await handle.requestPermission(opts)) === 'granted') return true
  return false
}

// ---- Directory picker ----

export async function pickWorkDirectory(key: DirectoryHandleKey = 'workdir'): Promise<FileSystemDirectoryHandle | null> {
  // pickerId は key ごとに分けておくとブラウザが「最後に選んだフォルダ」を
  // それぞれ独立して記憶してくれる (library と kit-out で別フォルダに誘導できる)。
  const pickerId = key === 'kitdir' ? 'hapbeat-kitdir' : 'hapbeat-workdir'
  try {
    const handle = await window.showDirectoryPicker({
      id: pickerId,
      mode: 'readwrite',
      startIn: 'documents',
    })
    await saveDirectoryHandle(handle, key)
    return handle
  } catch (err) {
    // User cancelled
    if (err instanceof DOMException && err.name === 'AbortError') return null
    throw err
  }
}

// ---- Ensure subdirectories ----

async function ensureSubdir(
  root: FileSystemDirectoryHandle,
  name: string,
): Promise<FileSystemDirectoryHandle> {
  return root.getDirectoryHandle(name, { create: true })
}

// ---- Clip file operations ----

const AUDIO_EXT = /\.(wav|mp3|ogg|flac|aac|m4a)$/i

/** Directory names under clips/ that are hidden from the UI. */
const HIDDEN_CLIP_DIRS = new Set(['archive'])

/**
 * Recursively lists all audio files under clips/, skipping hidden folders
 * like clips/archive/. Subfolders are walked and returned with their
 * relative path so "template/booster.wav" is a distinct entry from
 * "booster.wav".
 */
export async function listClipFiles(
  root: FileSystemDirectoryHandle,
): Promise<{ name: string; file: File }[]> {
  const clipsDir = await ensureSubdir(root, 'clips')
  const results: { name: string; file: File }[] = []

  const walk = async (dir: FileSystemDirectoryHandle, prefix: string) => {
    for await (const entry of dir.values()) {
      if (entry.kind === 'file' && AUDIO_EXT.test(entry.name)) {
        const file = await entry.getFile()
        results.push({ name: prefix ? `${prefix}/${entry.name}` : entry.name, file })
      } else if (entry.kind === 'directory') {
        // Skip hidden top-level dirs (e.g. archive/) but recurse into others.
        if (prefix === '' && HIDDEN_CLIP_DIRS.has(entry.name)) continue
        const sub = await dir.getDirectoryHandle(entry.name)
        await walk(sub, prefix ? `${prefix}/${entry.name}` : entry.name)
      }
    }
  }
  await walk(clipsDir, '')
  return results
}

/**
 * Resolves a slash-separated relative path inside clips/ to a FileSystem
 * directory handle + final filename, creating intermediate directories when
 * `create` is true.
 */
async function resolveClipPath(
  root: FileSystemDirectoryHandle,
  relPath: string,
  create: boolean,
): Promise<{ dir: FileSystemDirectoryHandle; filename: string }> {
  const clipsDir = await ensureSubdir(root, 'clips')
  const parts = relPath.split('/').filter(Boolean)
  let dir = clipsDir
  for (let i = 0; i < parts.length - 1; i++) {
    dir = await dir.getDirectoryHandle(parts[i], { create })
  }
  return { dir, filename: parts[parts.length - 1] }
}

export async function readClipFile(
  root: FileSystemDirectoryHandle,
  relPath: string,
): Promise<File | null> {
  try {
    const { dir, filename } = await resolveClipPath(root, relPath, false)
    const fileHandle = await dir.getFileHandle(filename)
    return fileHandle.getFile()
  } catch {
    return null
  }
}

export async function writeClipFile(
  root: FileSystemDirectoryHandle,
  relPath: string,
  blob: Blob,
): Promise<void> {
  const { dir, filename } = await resolveClipPath(root, relPath, true)
  const fileHandle = await dir.getFileHandle(filename, { create: true })
  const writable = await fileHandle.createWritable()
  await writable.write(blob)
  await writable.close()
}

export async function deleteClipFile(
  root: FileSystemDirectoryHandle,
  relPath: string,
): Promise<void> {
  try {
    const { dir, filename } = await resolveClipPath(root, relPath, false)
    await dir.removeEntry(filename)
  } catch { /* ignore */ }
}

/**
 * clips/ 配下のファイル名のみを変更する（ディレクトリは維持）。
 * 新ファイル名はベース名のみ。拡張子は元ファイルから保持する。
 *
 * 衝突時: `name_2.wav` → `name_3.wav` …と連番を付与する。
 * 実装は File System Access API の `move(name)` を使い、
 * 非対応環境では copy → delete にフォールバックする。
 *
 * @returns 新しい相対パス（変更なし or 失敗時は null）
 */
export async function renameClipFile(
  root: FileSystemDirectoryHandle,
  relPath: string,
  newBaseName: string,
): Promise<string | null> {
  const { dir, filename } = await resolveClipPath(root, relPath, false)
  // 拡張子を保持
  const extMatch = filename.match(AUDIO_EXT)
  const ext = extMatch ? extMatch[0] : ''
  const oldStem = ext ? filename.slice(0, -ext.length) : filename
  const sanitized = newBaseName.trim().replace(/[\\/:*?"<>|]/g, '_')
  if (!sanitized || sanitized === oldStem) return null

  // 同一ディレクトリ内の既存ファイル名を収集して衝突回避
  const existing = new Set<string>()
  for await (const entry of dir.values()) {
    if (entry.kind === 'file') existing.add(entry.name)
  }
  let dest = `${sanitized}${ext}`
  if (existing.has(dest) && dest !== filename) {
    for (let i = 2; i < 10000; i++) {
      const cand = `${sanitized}_${i}${ext}`
      if (!existing.has(cand)) { dest = cand; break }
    }
  }

  const oldHandle = await dir.getFileHandle(filename)
  // 優先: FileSystemFileHandle.move(name) (Chromium ≥ 108)
  const moveFn = (oldHandle as unknown as { move?: (name: string) => Promise<void> }).move
  if (typeof moveFn === 'function') {
    await moveFn.call(oldHandle, dest)
  } else {
    // Fallback: copy → delete
    const file = await oldHandle.getFile()
    const blob = new Blob([await file.arrayBuffer()], { type: file.type || 'audio/wav' })
    const newHandle = await dir.getFileHandle(dest, { create: true })
    const w = await newHandle.createWritable()
    await w.write(blob)
    await w.close()
    await dir.removeEntry(filename)
  }

  const parts = relPath.split('/').filter(Boolean)
  parts[parts.length - 1] = dest
  return parts.join('/')
}

/**
 * Moves a clip file into clips/archive/<filename> preserving its basename.
 * If a file of the same basename already exists in archive/, appends a
 * numeric suffix. Returns the new relative path on success, or null if the
 * source file was not found.
 *
 * The archive is the studio-level "recycle bin" — hidden from the UI but
 * still on disk so the user can recover a clip by moving it back.
 */
export async function archiveClipFile(
  root: FileSystemDirectoryHandle,
  relPath: string,
): Promise<string | null> {
  const file = await readClipFile(root, relPath)
  if (!file) return null
  const blob = new Blob([await file.arrayBuffer()], { type: 'audio/wav' })

  const basename = relPath.split('/').pop() ?? relPath
  const archiveDir = await (await ensureSubdir(root, 'clips')).getDirectoryHandle('archive', { create: true })

  // Pick a non-colliding destination name.
  let destName = basename
  const existing = new Set<string>()
  for await (const entry of archiveDir.values()) {
    if (entry.kind === 'file') existing.add(entry.name)
  }
  if (existing.has(destName)) {
    const dot = basename.lastIndexOf('.')
    const stem = dot > 0 ? basename.slice(0, dot) : basename
    const ext = dot > 0 ? basename.slice(dot) : ''
    for (let i = 2; i < 10000; i++) {
      const candidate = `${stem}_${i}${ext}`
      if (!existing.has(candidate)) { destName = candidate; break }
    }
  }

  const fh = await archiveDir.getFileHandle(destName, { create: true })
  const writable = await fh.createWritable()
  await writable.write(blob)
  await writable.close()

  await deleteClipFile(root, relPath)
  return `archive/${destName}`
}

// ---- Kit folder operations ----

export async function writeKitFolder(
  root: FileSystemDirectoryHandle,
  kitName: string,
  files: { path: string; blob: Blob }[],
): Promise<void> {
  // 各 kit は必ず root 直下に kit 名のフォルダとして書き出す
  // (ライブラリ / kit-out どちらを root に指定してもこの階層構造)。
  // 以前は library workDir と共用する想定で `kits/` 階層を挟んでいたが、
  // フォルダを分離できるようになったため削除した。
  const kitDir = await root.getDirectoryHandle(kitName, { create: true })

  for (const { path, blob } of files) {
    // Handle nested paths like "install-clips/gunshot.wav"
    const parts = path.split('/')
    let dir = kitDir
    for (let i = 0; i < parts.length - 1; i++) {
      dir = await dir.getDirectoryHandle(parts[i], { create: true })
    }
    const fileHandle = await dir.getFileHandle(parts[parts.length - 1], { create: true })
    const writable = await fileHandle.createWritable()
    await writable.write(blob)
    await writable.close()
  }
}

/**
 * Recursively remove a kit folder under *root*. Used when the user
 * deletes a kit from the UI — without this the folder lingers on disk
 * and `importKitsFromOutputDir` resurrects the kit on the next refresh.
 *
 * Best-effort: missing folder = success, no-op. All errors are
 * swallowed and returned as `false` so callers stay simple.
 */
export async function deleteKitFolder(
  root: FileSystemDirectoryHandle,
  kitName: string,
): Promise<boolean> {
  try {
    // `recursive: true` (Chromium-only) lets us drop the whole subtree
    // in one call. The fallback walks and deletes per-entry.
    const removeOpts = { recursive: true } as { recursive?: boolean }
    try {
      await (root as FileSystemDirectoryHandle).removeEntry(kitName, removeOpts)
      return true
    } catch {
      // Manual recursion fallback
      const dir = await root.getDirectoryHandle(kitName)
      await emptyDirectory(dir)
      await root.removeEntry(kitName)
      return true
    }
  } catch {
    return false
  }
}

async function emptyDirectory(dir: FileSystemDirectoryHandle): Promise<void> {
  const names: string[] = []
  for await (const entry of dir.values()) names.push(entry.name)
  for (const name of names) {
    try {
      const sub = await dir.getDirectoryHandle(name)
      await emptyDirectory(sub)
      await dir.removeEntry(name)
    } catch {
      // not a directory — try as file
      try { await dir.removeEntry(name) } catch { /* ignore */ }
    }
  }
}

export async function listKitFolders(
  root: FileSystemDirectoryHandle,
): Promise<string[]> {
  const kitsDir = await ensureSubdir(root, 'kits')
  const names: string[] = []
  for await (const entry of kitsDir.values()) {
    if (entry.kind === 'directory') {
      names.push(entry.name)
    }
  }
  return names.sort()
}

/** Scan result for a single discovered kit folder. */
export interface DiscoveredKit {
  folderName: string
  manifestJson: unknown
  /** relPath (e.g. "clips/foo.wav" or "stream-clips/bar.wav") → File */
  clipFiles: Map<string, File>
}

/**
 * Scan `root` for immediate subfolders that look like an exported Hapbeat Kit
 * (= contain a `manifest.json`). For each one, parse the manifest and load
 * every wav under `clips/` and `stream-clips/` so the caller can register
 * them into the Studio library.
 *
 * 存在しない / 壊れた manifest は黙ってスキップする。
 */
export async function scanKitOutputFolder(
  root: FileSystemDirectoryHandle,
): Promise<DiscoveredKit[]> {
  const out: DiscoveredKit[] = []
  for await (const entry of root.values()) {
    if (entry.kind !== 'directory') continue
    const kitFolder = entry as FileSystemDirectoryHandle
    let manifestJson: unknown
    try {
      const mf = await kitFolder.getFileHandle('manifest.json')
      const text = await (await mf.getFile()).text()
      manifestJson = JSON.parse(text)
    } catch {
      // manifest.json が無い / parse 失敗 → この folder は Hapbeat kit ではない
      continue
    }
    const clipFiles = new Map<string, File>()
    for (const subName of ['install-clips', 'stream-clips'] as const) {
      try {
        const subDir = await kitFolder.getDirectoryHandle(subName)
        for await (const child of subDir.values()) {
          if (child.kind !== 'file') continue
          if (!child.name.toLowerCase().endsWith('.wav')) continue
          const fh = child as FileSystemFileHandle
          clipFiles.set(`${subName}/${child.name}`, await fh.getFile())
        }
      } catch {
        // このサブフォルダが無ければ単にスキップ (mode によっては片方しか存在しない)
      }
    }
    out.push({ folderName: kitFolder.name, manifestJson, clipFiles })
  }
  return out
}

// ---- Metadata JSON ----

export async function readMetadataJson<T>(
  root: FileSystemDirectoryHandle,
  filename: string,
): Promise<T | null> {
  try {
    const fileHandle = await root.getFileHandle(filename)
    const file = await fileHandle.getFile()
    const text = await file.text()
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

export async function writeMetadataJson(
  root: FileSystemDirectoryHandle,
  filename: string,
  data: unknown,
): Promise<void> {
  const fileHandle = await root.getFileHandle(filename, { create: true })
  const writable = await fileHandle.createWritable()
  await writable.write(JSON.stringify(data, null, 2))
  await writable.close()
}
