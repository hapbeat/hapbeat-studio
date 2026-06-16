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

/**
 * Directory name under `clips/` for the library UI's "recycle bin" —
 * archived clips live here, hidden from the visible list but
 * recoverable from OS Explorer.
 *
 * We tried `_archive~` originally (tilde suffix = Unity asset-import
 * ignore convention) but Chrome's File System Access API rejects
 * names ending in `~` with "TypeError: Name is not allowed". Until
 * the browser side relaxes (or a different cross-engine sigil emerges),
 * we use plain `_archive`:
 *   - `_` prefix: sorts to top in OS Explorer, signals "managed by
 *     Studio, don't edit".
 *   - No Unity ignore protection — if users point their workdir at a
 *     Unity Assets/ tree, archived WAVs will get re-imported as
 *     AudioClip assets. Mitigation lives in docs ("add `_archive` to
 *     your `.gitignore` or place the workdir outside Assets/").
 *
 * Legacy `archive` (the original pre-rename name) is still recognised
 * via HIDDEN_CLIP_DIRS so kits authored before the rename keep their
 * archived clips invisible; `migrateLegacyArchiveFolders` also moves
 * its contents into `_archive/` on startup.
 */
export const ARCHIVE_CLIP_DIR = '_archive'
const LEGACY_ARCHIVE_CLIP_DIR = 'archive'
const HIDDEN_CLIP_DIRS = new Set([ARCHIVE_CLIP_DIR, LEGACY_ARCHIVE_CLIP_DIR])

/**
 * Folder names that Studio considers "managed internal — don't show
 * in any UI" regardless of where they appear (library scan, kit scan,
 * Devices > Streaming test browser, …). Used by `isHiddenStudioDir()`
 * so all browse paths skip the same set instead of each maintaining
 * its own list. Covers:
 *   - `_archive`      → canonical kit / clip archive
 *   - `_archive~`     → leftover from the short-lived tilde experiment
 *                       (browser blocks new creation, but the folder
 *                       can still exist if a user copied it manually)
 *   - `archive`       → legacy clip-archive name (pre-rename)
 */
const STUDIO_HIDDEN_DIRS = new Set(['_archive', '_archive~', 'archive'])

/**
 * Whether a folder name is one Studio manages internally and should
 * hide from any user-facing list. Folder browsers (Streaming test,
 * picker UIs) call this before adding an entry.
 */
export function isHiddenStudioDir(name: string): boolean {
  return STUDIO_HIDDEN_DIRS.has(name)
}

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

/**
 * Read a kit-event audio WAV from a kit folder's `install-clips/` or
 * `stream-clips/` subdir, i.e. `<root>/<kitName>/<subdir>/<filename>`.
 *
 * Kit-event audio does NOT live under the library `clips/` dir, so
 * `readClipFile` can't reach it. Returns null on any miss (folder / subdir /
 * file absent, or permission denied) so callers fall through cleanly.
 */
export async function readKitClipFile(
  root: FileSystemDirectoryHandle,
  kitName: string,
  subdir: string,
  filename: string,
): Promise<File | null> {
  try {
    const kitDir = await root.getDirectoryHandle(kitName, { create: false })
    const sub = await kitDir.getDirectoryHandle(subdir, { create: false })
    const fileHandle = await sub.getFileHandle(filename)
    return await fileHandle.getFile()
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
  console.info('[archiveClipFile] start', { root: root.name, relPath })
  const file = await readClipFile(root, relPath)
  if (!file) {
    console.warn('[archiveClipFile] source file not found at clips/' + relPath)
    return null
  }
  const blob = new Blob([await file.arrayBuffer()], { type: 'audio/wav' })

  const basename = relPath.split('/').pop() ?? relPath
  const archiveDir = await (await ensureSubdir(root, 'clips')).getDirectoryHandle(ARCHIVE_CLIP_DIR, { create: true })
  console.info('[archiveClipFile] archive dir resolved:', `clips/${ARCHIVE_CLIP_DIR}/`)

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
  console.info('[archiveClipFile] wrote', `clips/${ARCHIVE_CLIP_DIR}/${destName}`, blob.size, 'bytes')

  await deleteClipFile(root, relPath)
  console.info('[archiveClipFile] deleted', `clips/${relPath}`)
  return `${ARCHIVE_CLIP_DIR}/${destName}`
}

// ---- Kit folder operations ----

/**
 * Filename Studio uses inside each `<kitId>/` folder to record the
 * per-WAV source-blob hashes that were last written to that folder.
 *
 * Lives **on disk**, next to the kit's `<kitId>-manifest.json`, so
 * the skip-write ledger survives:
 *   - browser data clears (was a problem with the previous IDB-based
 *     ledger),
 *   - switching browsers (Chrome ↔ Edge),
 *   - moving the kit folder between machines (e.g. a synced cloud
 *     folder).
 *
 * Naming: dot-prefix follows the industry convention for tool-internal
 * metadata (`.git`, `.vscode`, …) so it's hidden on Unix and easy to
 * gitignore. Windows shows it but the name signals "not user data".
 *
 * Format: see `KitDiskCache` below. Device / Helper / SDK never read
 * this file — it's purely a Studio runtime optimization. `buildKitZip`
 * also doesn't include it in the Deploy ZIP (the ZIP is built from
 * `ExportFile[]` and this file isn't in that list).
 */
export const STUDIO_CACHE_FILENAME = '.studio-cache.json'

/**
 * Per-kit skip-write ledger persisted as `<kitId>/.studio-cache.json`.
 *
 * `wavs` maps **kit-relative path** (e.g. `install-clips/foo.wav`) to
 * the SHA-1 hex of the **on-disk WAV bytes** that were last written
 * to that path. `flushKitFolderNow` compares the prospective output's
 * hash against this — if they match, the file currently on disk is
 * already bit-exact what we'd write, so the disk write can be skipped.
 *
 * Why outputHash, not sourceHash:
 *   schema v1 keyed by the *source* audio's hash. That broke after a
 *   hard reload + folder re-pick, because `importKitsFromOutputDir`
 *   re-imports each event's audio from the on-disk WAV — so the
 *   "source" in IDB is the **previous save's encoded output**, not
 *   the original drop. The source hash changes between sessions even
 *   when the audio bytes on disk are unchanged. outputHash sidesteps
 *   this by comparing the encoded blob's hash against the on-disk
 *   file's hash — both are deterministic functions of the same
 *   source audio, so they match across import boundaries (provided
 *   the encoder is deterministic, which `encodeWavBlob` /
 *   `encodeStereoWavBlob` are for PCM16 inputs).
 */
export interface KitDiskCache {
  /** Schema version. v1 stored sourceHash; v2 stores outputHash.
   *  Loaders treat any non-v2 file as missing (= write everything,
   *  rebuild cache as v2). */
  schemaVersion: 2
  /** Per-WAV: relative path → SHA-1 hex of the on-disk file bytes. */
  wavs: Record<string, string>
  /** ISO timestamp of the last successful flush (debug only). */
  writtenAt?: string
  /** Kit name at write time. Helps human inspection when the folder
   *  has been renamed without an accompanying flush. */
  writtenByKitName?: string
}

export async function loadKitDiskCache(
  root: FileSystemDirectoryHandle,
  kitId: string,
): Promise<KitDiskCache | null> {
  try {
    const kitDir = await root.getDirectoryHandle(kitId, { create: false })
    const fileHandle = await kitDir.getFileHandle(STUDIO_CACHE_FILENAME, { create: false })
    const text = await (await fileHandle.getFile()).text()
    const parsed = JSON.parse(text) as Partial<KitDiskCache>
    if (
      parsed && typeof parsed === 'object'
      && parsed.schemaVersion === 2
      && parsed.wavs && typeof parsed.wavs === 'object'
    ) {
      return parsed as KitDiskCache
    }
    // v1 files: previous design used sourceHash, which doesn't survive
    // a hard-reload re-import. Treat as missing — caller writes
    // everything once + saves a fresh v2 cache. One-time cost.
    return null
  } catch {
    // File not found / unreadable / malformed JSON — caller falls back
    // to "write everything". This is the first-save path for any kit
    // that pre-dates the disk cache or was authored outside Studio.
    return null
  }
}

export async function saveKitDiskCache(
  root: FileSystemDirectoryHandle,
  kitId: string,
  cache: KitDiskCache,
): Promise<void> {
  try {
    const kitDir = await root.getDirectoryHandle(kitId, { create: true })
    const fileHandle = await kitDir.getFileHandle(STUDIO_CACHE_FILENAME, { create: true })
    const writable = await fileHandle.createWritable()
    await writable.write(JSON.stringify(cache, null, 2))
    await writable.close()
  } catch (err) {
    // Cache save failure must not fail the export — the WAVs and
    // manifest landed correctly; we'll just be unable to skip writes
    // on the next flush. Surface in the console for debugging.
    console.warn('[kit] disk cache save failed', err)
  }
}

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
 * Naming:
 *  - `_` prefix: sorts it ahead of normal kits in OS Explorer and signals
 *    "managed by Studio, do not edit".
 *  - No tilde suffix: Chrome's File System Access API rejects directory
 *    names ending in `~` ("TypeError: Name is not allowed"). Unity's
 *    asset-import ignore convention requires trailing tilde, so we
 *    can't satisfy both — browser writes win because they're a hard
 *    blocker. Users pointing their workdir at a Unity project should
 *    add `_archive` to their `.gitignore` (or place the workdir
 *    outside the Assets/ tree).
 *
 * `scanKitOutputFolder` skips this folder.
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
 * Locate the kit manifest file inside *kitFolder*.
 *
 * Convention (2026-05-17): kits write `<folderName>-manifest.json`
 * so multiple kits stay identifiable in OS Explorer. We try the
 * preferred name first, then fall back to any file named
 * `*manifest*.json` (covers legacy `manifest.json` and any custom
 * suffix). Returns null if no manifest-like file exists.
 */
export async function findKitManifestHandle(
  kitFolder: FileSystemDirectoryHandle,
): Promise<FileSystemFileHandle | null> {
  // 1) Preferred: `<folderName>-manifest.json` exact match.
  try {
    return await kitFolder.getFileHandle(`${kitFolder.name}-manifest.json`)
  } catch { /* fall through */ }
  // 2) Fallback: scan for any `*manifest*.json`. Returns the first
  //    match — kits shouldn't ship more than one manifest per folder.
  try {
    for await (const child of kitFolder.values()) {
      if (child.kind !== 'file') continue
      const n = child.name.toLowerCase()
      if (n.endsWith('.json') && n.includes('manifest')) {
        return child as FileSystemFileHandle
      }
    }
  } catch { /* directory iteration failed */ }
  return null
}

/**
 * Scan `root` for immediate subfolders that look like an exported Hapbeat Kit
 * (= contain a `<name>-manifest.json` or any `*manifest*.json` fallback). For
 * each one, parse the manifest and load every wav under `install-clips/` and
 * `stream-clips/` so the caller can register them into the Studio library.
 *
 * 存在しない / 壊れた manifest は黙ってスキップする。
 */
export async function scanKitOutputFolder(
  root: FileSystemDirectoryHandle,
): Promise<DiscoveredKit[]> {
  const out: DiscoveredKit[] = []
  // Track folders we touched but couldn't claim as a kit so the caller
  // (libraryStore) can console.warn them. Helps diagnose the case where
  // a user expects an old kit to load but the manifest file got renamed
  // or removed externally.
  const skipped: { folder: string; reason: string }[] = []
  for await (const entry of root.values()) {
    if (entry.kind !== 'directory') continue
    // _archive/ holds kits the user "deleted" from the UI. They stay
    // on disk for manual recovery but must not show up in the Studio
    // list. (We also skip `_archive~` so any folder accidentally
    // created with that name by an earlier tilde-suffix attempt
    // doesn't appear as a kit.)
    if (entry.name === ARCHIVE_KIT_DIR || entry.name === '_archive~') continue
    // Also skip the library's own `clips/` workdir — it isn't a kit.
    if (entry.name === 'clips') continue
    const kitFolder = entry as FileSystemDirectoryHandle
    let manifestJson: unknown
    const mf = await findKitManifestHandle(kitFolder)
    if (!mf) {
      skipped.push({ folder: kitFolder.name, reason: 'no manifest file' })
      continue
    }
    try {
      const text = await (await mf.getFile()).text()
      manifestJson = JSON.parse(text)
    } catch (err) {
      // manifest 読込失敗 → この folder は Hapbeat kit ではない
      skipped.push({
        folder: kitFolder.name,
        reason: `manifest parse failed (${err instanceof Error ? err.message : 'unknown'})`,
      })
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
  if (skipped.length > 0) {
    console.warn(
      '[scanKitOutputFolder] skipped',
      skipped.length,
      'sub-folder(s) under',
      root.name,
      '(no Hapbeat kit recognised). Details:',
      skipped,
      '— a Hapbeat kit folder must contain `<folder-name>-manifest.json` or any `*manifest*.json`.',
    )
  }
  return out
}

// ---- Legacy archive folder migration ----
//
// History:
//   - Clip archive used to live at `clips/archive/`; renamed to
//     `clips/_archive/` for naming consistency with the kit archive.
//   - Kit archive has always been at `_archive/` (unchanged).
//   - A brief attempt at `_archive~/` (tilde suffix, Unity ignore
//     convention) was reverted because Chrome's File System Access
//     API rejects trailing `~` in directory names. Any workdir that
//     was opened during that window may have a `_archive~/` folder
//     created OUTSIDE of Studio (e.g., manual file move from OS), so
//     we sweep it into the canonical `_archive/` on the next run.
//
// Best-effort: failures log a warning but never abort startup. On
// collision the source is suffixed with `_2`, `_3`, … to make room.

async function moveAllEntries(
  src: FileSystemDirectoryHandle,
  dst: FileSystemDirectoryHandle,
): Promise<void> {
  for await (const entry of src.values()) {
    if (entry.kind === 'file') {
      const srcFile = await (entry as FileSystemFileHandle).getFile()
      // Pick a non-colliding destination name.
      const existing = new Set<string>()
      for await (const e of dst.values()) existing.add(e.name)
      let destName = entry.name
      if (existing.has(destName)) {
        const dot = entry.name.lastIndexOf('.')
        const stem = dot > 0 ? entry.name.slice(0, dot) : entry.name
        const ext = dot > 0 ? entry.name.slice(dot) : ''
        for (let i = 2; i < 10000; i++) {
          const candidate = `${stem}_${i}${ext}`
          if (!existing.has(candidate)) { destName = candidate; break }
        }
      }
      const dstFile = await dst.getFileHandle(destName, { create: true })
      const writable = await dstFile.createWritable()
      await writable.write(await srcFile.arrayBuffer())
      await writable.close()
      try { await src.removeEntry(entry.name) } catch { /* leave behind on conflict */ }
    } else if (entry.kind === 'directory') {
      // Recurse — kit subfolders contain install-clips/ / stream-clips/.
      const srcSub = entry as FileSystemDirectoryHandle
      const dstSub = await dst.getDirectoryHandle(entry.name, { create: true })
      await moveAllEntries(srcSub, dstSub)
      try { await src.removeEntry(entry.name, { recursive: true }) } catch { /* ignore */ }
    }
  }
}

/**
 * Sweep legacy / aborted-rename archive locations into the canonical
 * `_archive/` directories. Call this once per session right after the
 * workdir handle is restored / picked. Safe to call repeatedly —
 * when no legacy folder exists (most users) it's a no-op.
 *
 * Migrations:
 *   - `<workdir>/clips/archive/`  → `<workdir>/clips/_archive/`
 *   - `<workdir>/_archive~/`      → `<workdir>/_archive/`           (aborted tilde experiment)
 *   - `<workdir>/clips/_archive~/` → `<workdir>/clips/_archive/`    (same)
 *
 * The `_archive~` sweep can't be triggered by Studio itself (the
 * File System Access API would reject the name on `getDirectoryHandle`)
 * but the folder may exist on disk if the user manually copied a
 * folder from elsewhere with that name. The sweep tries to read it
 * via `getDirectoryHandle` — if the read also fails, we just leave
 * the folder in place.
 */
export async function migrateLegacyArchiveFolders(
  workDirHandle: FileSystemDirectoryHandle,
): Promise<void> {
  const sweep = async (
    parent: FileSystemDirectoryHandle,
    fromName: string,
    toName: string,
    label: string,
  ) => {
    try {
      const src = await parent.getDirectoryHandle(fromName, { create: false })
      const dst = await parent.getDirectoryHandle(toName, { create: true })
      await moveAllEntries(src, dst)
      try { await parent.removeEntry(fromName, { recursive: true }) } catch { /* ignore */ }
      console.info(`[archive-migration] ${label} done`)
    } catch {
      // Source doesn't exist (typical case) or browser rejected the
      // name (e.g. `_archive~`) — silent no-op.
    }
  }

  // Kit archive at workdir root — only the tilde sweep is relevant
  // (the canonical name `_archive` was unchanged across versions).
  await sweep(workDirHandle, '_archive~', ARCHIVE_KIT_DIR, '_archive~/ → _archive/ (kit)')

  // Clip archive under clips/.
  try {
    const clipsDir = await workDirHandle.getDirectoryHandle('clips', { create: false })
    await sweep(clipsDir, LEGACY_ARCHIVE_CLIP_DIR, ARCHIVE_CLIP_DIR, 'clips/archive/ → clips/_archive/')
    await sweep(clipsDir, '_archive~', ARCHIVE_CLIP_DIR, 'clips/_archive~/ → clips/_archive/')
  } catch { /* no clips/ dir yet */ }
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
