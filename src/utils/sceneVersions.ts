import { VIEWER_DIR } from './sceneData'
import { isNotFound, readProjectFile, writeProjectFile, dirAt } from './sceneProject'
import { VIEWER_EDITS_FILE } from './sceneEdits'
import type { CueRoute, CueSfx, CueTable } from './sceneCueTable'

/**
 * The Scene tab's versions (DEC-112, contracts scene-recording §3.6): copies of viewer-edits.json and the cue table
 * kept in `Saved/HapticViewer/versions/<YYYYMMDD-HHMMSS>[-<slug>]/` with a `version.json`, so the user can go back.
 * Players never read them. A version is never deleted: 「消す」 moves its folder to `Saved/HapticViewer/_archive/versions/`.
 */

export const VERSIONS_DIR = `${VIEWER_DIR}/versions`
export const ARCHIVED_VERSIONS_DIR = `${VIEWER_DIR}/_archive/versions`
export const VERSION_FILE = 'version.json'
export const VERSION_FORMAT = 'hapbeat-scene-version@1'
export type VersionReason = 'before-edit' | 'manual' | 'before-restore'
export interface SceneVersion { id: string; savedAt: string; label: string; reason: VersionReason; /** Entries in its edits. */ firings: number }
/** What a version keeps: the edits file text (null: there was none) and the cue table text (null: none) under its file name. */
export interface VersionSnapshot { edits: string | null; table: string | null; tableFile: string; firings: number }

const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, '0')
/** Local time as ISO 8601 with milliseconds and its offset (`2026-11-06T23:44:12.345+09:00`). */
export function localIso(date: Date): string {
  const off = -date.getTimezoneOffset()
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${off >= 0 ? '+' : '-'}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`
}
/** The label's ASCII words as a folder name suffix (`My mix!` → `my-mix`; none for a label without any), 32 characters at most. */
export const versionSlug = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '')
/** `<YYYYMMDD-HHMMSS>[-<slug>]` in local time. */
export function versionId(date: Date, label: string): string {
  const slug = versionSlug(label)
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  return slug ? `${stamp}-${slug}` : stamp
}

const REASONS: readonly string[] = ['before-edit', 'manual', 'before-restore']
/** version.json → its fields (id = the folder's name); null when it is not one. */
export function parseVersion(id: string, text: string): SceneVersion | null {
  try {
    const v = JSON.parse(text) as Record<string, unknown>
    if (!v || v.format !== VERSION_FORMAT || typeof v.savedAt !== 'string' || typeof v.label !== 'string' || !REASONS.includes(v.reason as string)
      || typeof v.firings !== 'number') return null
    return { id, savedAt: v.savedAt, label: v.label, reason: v.reason as VersionReason, firings: v.firings }
  } catch { return null }
}

const readText = async (root: FileSystemDirectoryHandle, path: string): Promise<string | null> => {
  try { return await (await readProjectFile(root, path)).text() } catch (error) { if (isNotFound(error)) return null; throw error }
}

/** The versions in the project, newest first (folders without a readable version.json are left out). */
export async function listVersions(root: FileSystemDirectoryHandle): Promise<SceneVersion[]> {
  let dir: FileSystemDirectoryHandle
  try { dir = await dirAt(root, VERSIONS_DIR) } catch (error) { if (isNotFound(error)) return []; throw error }
  const out: SceneVersion[] = []
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind !== 'directory') continue
    const text = await readText(root, `${VERSIONS_DIR}/${name}/${VERSION_FILE}`)
    const v = text === null ? null : parseVersion(name, text)
    if (v) out.push(v)
  }
  const at = (v: SceneVersion) => Date.parse(v.savedAt) || 0
  return out.sort((a, b) => at(b) - at(a) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
}

/** A version's files: its edits text (null: it had none) and its cue table text (null: it has no `tableFile`). */
export async function readVersion(root: FileSystemDirectoryHandle, id: string, tableFile: string): Promise<{ version: SceneVersion; edits: string | null; table: string | null }> {
  const text = await readText(root, `${VERSIONS_DIR}/${id}/${VERSION_FILE}`)
  const version = text === null ? null : parseVersion(id, text)
  if (!version) throw new Error(`${VERSIONS_DIR}/${id}: not a version`)
  return { version, edits: await readText(root, `${VERSIONS_DIR}/${id}/${VIEWER_EDITS_FILE}`), table: await readText(root, `${VERSIONS_DIR}/${id}/${tableFile}`) }
}

/**
 * Writes a version of `snapshot` (a new folder; a name already taken gets `-2`, `-3`, …); returns its id, or null when
 * `skipSame` and the newest version keeps the same edits and cue table texts already.
 */
export async function writeVersion(root: FileSystemDirectoryHandle, snapshot: VersionSnapshot, reason: VersionReason, label: string, date: Date, skipSame = false): Promise<string | null> {
  const versions = await listVersions(root)
  if (skipSame && versions.length) {
    const newest = await readVersion(root, versions[0].id, snapshot.tableFile).catch(() => null)
    if (newest && newest.edits === snapshot.edits && newest.table === snapshot.table) return null
  }
  const base = versionId(date, label), taken = new Set(versions.map(v => v.id))
  let id = base
  for (let n = 2; taken.has(id) || await readText(root, `${VERSIONS_DIR}/${id}/${VERSION_FILE}`) !== null; n++) id = `${base}-${n}`
  const dir = `${VERSIONS_DIR}/${id}`
  if (snapshot.edits !== null) await writeProjectFile(root, `${dir}/${VIEWER_EDITS_FILE}`, snapshot.edits)
  if (snapshot.table !== null) await writeProjectFile(root, `${dir}/${snapshot.tableFile}`, snapshot.table)
  // version.json last: a folder without it (a write that failed part way) is not listed.
  await writeProjectFile(root, `${dir}/${VERSION_FILE}`, `${JSON.stringify({ format: VERSION_FORMAT, savedAt: localIso(date), label, reason, firings: snapshot.firings }, null, 2)}\n`)
  return id
}

/** Copies every file and folder in `source` (sub-folders too, empty ones made) to `path` under `root`. */
async function copyFolder(root: FileSystemDirectoryHandle, source: FileSystemDirectoryHandle, path: string): Promise<void> {
  await dirAt(root, path, true)
  for await (const [name, handle] of source.entries()) {
    if (handle.kind === 'file') await writeProjectFile(root, `${path}/${name}`, await (handle as FileSystemFileHandle).getFile())
    else await copyFolder(root, handle as FileSystemDirectoryHandle, `${path}/${name}`)
  }
}

/**
 * Moves version `id` to `_archive/versions/<id>/` (a name already there gets `-2`, …): everything in it is copied
 * (sub-folders too), then the original folder is removed — only as this move, after the whole copy worked (Studio
 * never deletes files in the user's folder). Returns the path.
 */
export async function archiveVersion(root: FileSystemDirectoryHandle, id: string): Promise<string> {
  const versions = await dirAt(root, VERSIONS_DIR), source = await versions.getDirectoryHandle(id)
  const archive = await dirAt(root, ARCHIVED_VERSIONS_DIR, true)
  let name = id
  for (let n = 2; await archive.getDirectoryHandle(name).then(() => true, error => { if (isNotFound(error)) return false; throw error }); n++) name = `${id}-${n}`
  await copyFolder(root, source, `${ARCHIVED_VERSIONS_DIR}/${name}`)
  await versions.removeEntry(id, { recursive: true })
  return `${ARCHIVED_VERSIONS_DIR}/${name}`
}

/**
 * `current` with the strength values of `source` (a version's cue table): every route gain of an event (a cue or a
 * variant with its own haptics) when both have the same number of routes, its own sfx volume when both have one, a
 * variant's hapticsGain / sfxVolume (absent in `source`: removed). `skipped`: the events of `source` that could not be
 * set (not in `current`, or another number of routes). `current` itself when nothing changed.
 */
export function applyTableGains(current: CueTable, source: CueTable): { table: CueTable; skipped: string[] } {
  const table = JSON.parse(JSON.stringify(current)) as CueTable, skipped: string[] = []
  type Owner = { haptics?: CueRoute[]; sfx?: CueSfx | null; hapticsGain?: number; sfxVolume?: number }
  const copy = (key: string, to: Owner, from: Owner, variant: boolean) => {
    if (to.haptics || from.haptics) {
      if (to.haptics && from.haptics && to.haptics.length === from.haptics.length) to.haptics.forEach((r, i) => { r.gain = from.haptics![i].gain })
      else skipped.push(key)
    }
    if (to.sfx && from.sfx) to.sfx.volume = from.sfx.volume
    if (!variant) return
    for (const field of ['hapticsGain', 'sfxVolume'] as const) { if (from[field] === undefined) delete to[field]; else to[field] = from[field] }
  }
  for (const [name, from] of Object.entries(source.cues)) {
    const to = table.cues[name]
    if (!to) { skipped.push(name); continue }
    copy(name, to, from, false)
    for (const [v, fromVariant] of Object.entries(from.variants ?? {})) {
      const toVariant = to.variants?.[v]
      if (!toVariant) { skipped.push(`${name}:${v}`); continue }
      copy(`${name}:${v}`, toVariant, fromVariant, true)
    }
  }
  return { table: JSON.stringify(table) === JSON.stringify(current) ? current : table, skipped: [...new Set(skipped)] }
}
