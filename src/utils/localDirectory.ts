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
 *  `kitdir` = optional separate kit output root (e.g. Unity Assets),
 *  `streamdir` = streaming-test source folder (browseable WAV/MP3 root). */
export type DirectoryHandleKey = 'workdir' | 'kitdir' | 'streamdir'

/** IDB key for individual *file* handles (separate from directory handles
 *  so a stale `firmwarefile` doesn't override a `workdir`). */
export type FileHandleKey = 'firmwarefile'

/** Single shared DB opener — both directory- and file-handle stores
 *  live in the same IndexedDB. We previously had two `openDB` callers
 *  with different version numbers (1 for directories, 2 for files),
 *  which guarantees a `VersionError` once both fire in the same tab:
 *  whichever opens second sees `requested < existing` and throws.
 *  Keep this opener as the only entry point and bump `IDB_VERSION`
 *  whenever the schema changes. */
const IDB_VERSION = 2

async function getHandleDb() {
  return openDB(HANDLE_DB, IDB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(HANDLE_STORE)) {
        db.createObjectStore(HANDLE_STORE)
      }
      if (!db.objectStoreNames.contains(FILE_HANDLE_STORE)) {
        db.createObjectStore(FILE_HANDLE_STORE)
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

// ---- File-handle persistence (separate logical key space) -----------

const FILE_HANDLE_STORE = 'file-handles'

export async function saveFileHandle(
  handle: FileSystemFileHandle,
  key: FileHandleKey,
): Promise<void> {
  const db = await getHandleDb()
  await db.put(FILE_HANDLE_STORE, handle, key)
}

export async function loadFileHandle(
  key: FileHandleKey,
): Promise<FileSystemFileHandle | null> {
  const db = await getHandleDb()
  return (await db.get(FILE_HANDLE_STORE, key)) ?? null
}

export async function clearFileHandle(key: FileHandleKey): Promise<void> {
  const db = await getHandleDb()
  await db.delete(FILE_HANDLE_STORE, key)
}

/** Pick a single local file via the File System Access API and persist
 *  the handle. Re-using the saved handle means we always read fresh
 *  bytes from disk via `handle.getFile()` — the bug-prone re-pick of
 *  `<input type=file>` (which silently no-ops on same-path) is gone. */
export async function pickFile(
  key: FileHandleKey,
  options: {
    types?: { description: string; accept: Record<string, string[]> }[]
    excludeAcceptAllOption?: boolean
  } = {},
): Promise<FileSystemFileHandle | null> {
  const w = window as unknown as {
    showOpenFilePicker?: (opts?: {
      id?: string
      multiple?: boolean
      excludeAcceptAllOption?: boolean
      types?: { description: string; accept: Record<string, string[]> }[]
      startIn?: 'desktop' | 'documents' | 'downloads' | FileSystemHandle
    }) => Promise<FileSystemFileHandle[]>
  }
  if (typeof w.showOpenFilePicker !== 'function') return null
  try {
    const [handle] = await w.showOpenFilePicker({
      id: `hapbeat-${key}`,
      multiple: false,
      excludeAcceptAllOption: options.excludeAcceptAllOption,
      types: options.types,
    })
    if (!handle) return null
    await saveFileHandle(handle, key)
    return handle
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return null
    throw err
  }
}

// ---- Permission ----

export async function verifyPermission(
  handle: FileSystemDirectoryHandle | FileSystemFileHandle,
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
  // それぞれ独立して記憶してくれる (library / kit-out / streaming で別フォルダに誘導できる)。
  const pickerId =
    key === 'kitdir'
      ? 'hapbeat-kitdir'
      : key === 'streamdir'
        ? 'hapbeat-streamdir'
        : 'hapbeat-workdir'
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

/** Top-level kit subdirectory used as the studio "recycle bin". When
 * a user removes a kit from the UI we move the entire folder under
 * `<root>/_archive/<kitName>/` instead of deleting it, so a true
 * delete still requires the user to act in their OS file explorer.
 *
 * Leading underscore keeps it sorted ahead of normal kits and signals
 * "managed by Studio, do not edit". `scanKitOutputFolder` skips it.
 */
export const ARCHIVE_KIT_DIR = '_archive'

/**
 * Move a kit folder under *root* into `_archive/`.
 * On collision (an archived kit of the same name already exists)
 * the moved folder is suffixed with `-2`, `-3`, … until unique.
 *
 * Implementation note: the File System Access API has no atomic move
 * across directories yet, so we recursively copy then delete. For a
 * typical kit (a few WAVs + manifest.json) this is fast enough; for
 * very large kits expect some delay.
 *
 * Returns the path under archive on success (e.g. "_archive/my-kit-2"),
 * or null if the source folder was missing or the move failed.
 */
export async function archiveKitFolder(
  root: FileSystemDirectoryHandle,
  kitName: string,
): Promise<string | null> {
  let srcDir: FileSystemDirectoryHandle
  try {
    srcDir = await root.getDirectoryHandle(kitName)
  } catch {
    return null
  }

  // Ensure _archive/ exists and pick a non-colliding destination name.
  const archiveRoot = await root.getDirectoryHandle(
    ARCHIVE_KIT_DIR, { create: true },
  )
  let destName = kitName
  if (await directoryExists(archiveRoot, destName)) {
    for (let i = 2; i < 10000; i++) {
      const cand = `${kitName}-${i}`
      if (!(await directoryExists(archiveRoot, cand))) {
        destName = cand
        break
      }
    }
  }

  try {
    const destDir = await archiveRoot.getDirectoryHandle(
      destName, { create: true },
    )
    await copyDirectoryRecursive(srcDir, destDir)
    await root.removeEntry(kitName, { recursive: true } as { recursive?: boolean })
  } catch {
    return null
  }
  return `${ARCHIVE_KIT_DIR}/${destName}`
}

async function directoryExists(
  parent: FileSystemDirectoryHandle, name: string,
): Promise<boolean> {
  try { await parent.getDirectoryHandle(name); return true } catch { return false }
}

async function copyDirectoryRecursive(
  src: FileSystemDirectoryHandle,
  dst: FileSystemDirectoryHandle,
): Promise<void> {
  for await (const entry of src.values()) {
    if (entry.kind === 'file') {
      const file = await (entry as FileSystemFileHandle).getFile()
      const dstHandle = await dst.getFileHandle(entry.name, { create: true })
      const writable = await dstHandle.createWritable()
      await writable.write(file)
      await writable.close()
    } else {
      const subSrc = await src.getDirectoryHandle(entry.name)
      const subDst = await dst.getDirectoryHandle(entry.name, { create: true })
      await copyDirectoryRecursive(subSrc, subDst)
    }
  }
}

/**
 * Recursively remove a kit folder under *root*. Hard-delete — used by
 * tests and emergency cleanup. UI flows should prefer
 * `archiveKitFolder` so the user can recover by hand.
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
    // _archive/ holds kits the user "deleted" from the UI. They stay on
    // disk for manual recovery but must not show up in the Studio list.
    if (entry.name === ARCHIVE_KIT_DIR) continue
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
