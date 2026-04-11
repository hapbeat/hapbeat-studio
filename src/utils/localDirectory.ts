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
const HANDLE_KEY = 'workdir'

async function getHandleDb() {
  return openDB(HANDLE_DB, 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(HANDLE_STORE)) {
        db.createObjectStore(HANDLE_STORE)
      }
    },
  })
}

export async function saveDirectoryHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  const db = await getHandleDb()
  await db.put(HANDLE_STORE, handle, HANDLE_KEY)
}

export async function loadDirectoryHandle(): Promise<FileSystemDirectoryHandle | null> {
  const db = await getHandleDb()
  return (await db.get(HANDLE_STORE, HANDLE_KEY)) ?? null
}

export async function clearDirectoryHandle(): Promise<void> {
  const db = await getHandleDb()
  await db.delete(HANDLE_STORE, HANDLE_KEY)
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

export async function pickWorkDirectory(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const handle = await window.showDirectoryPicker({
      id: 'hapbeat-workdir',
      mode: 'readwrite',
      startIn: 'documents',
    })
    await saveDirectoryHandle(handle)
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

export async function listClipFiles(
  root: FileSystemDirectoryHandle,
): Promise<{ name: string; file: File }[]> {
  const clipsDir = await ensureSubdir(root, 'clips')
  const results: { name: string; file: File }[] = []
  for await (const entry of clipsDir.values()) {
    if (entry.kind === 'file' && /\.(wav|mp3|ogg|flac|aac|m4a)$/i.test(entry.name)) {
      const file = await entry.getFile()
      results.push({ name: entry.name, file })
    }
  }
  return results
}

export async function readClipFile(
  root: FileSystemDirectoryHandle,
  filename: string,
): Promise<File | null> {
  try {
    const clipsDir = await ensureSubdir(root, 'clips')
    const fileHandle = await clipsDir.getFileHandle(filename)
    return fileHandle.getFile()
  } catch {
    return null
  }
}

export async function writeClipFile(
  root: FileSystemDirectoryHandle,
  filename: string,
  blob: Blob,
): Promise<void> {
  const clipsDir = await ensureSubdir(root, 'clips')
  const fileHandle = await clipsDir.getFileHandle(filename, { create: true })
  const writable = await fileHandle.createWritable()
  await writable.write(blob)
  await writable.close()
}

export async function deleteClipFile(
  root: FileSystemDirectoryHandle,
  filename: string,
): Promise<void> {
  const clipsDir = await ensureSubdir(root, 'clips')
  await clipsDir.removeEntry(filename)
}

// ---- Kit folder operations ----

export async function writeKitFolder(
  root: FileSystemDirectoryHandle,
  kitName: string,
  files: { path: string; blob: Blob }[],
): Promise<void> {
  const kitsDir = await ensureSubdir(root, 'kits')
  const kitDir = await kitsDir.getDirectoryHandle(kitName, { create: true })

  for (const { path, blob } of files) {
    // Handle nested paths like "clips/gunshot.wav"
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
