import { parseViewerData, parseViewerLib, VIEWER_DIR, type SceneData, type SceneLib } from './sceneData'
import { parseCueTable, serializeCueTable, type CueTable } from './sceneCueTable'

/**
 * Scene tab file access inside the opened game project folder (File System
 * Access API). Reads what the standalone viewer read and writes what it wrote:
 * new WAVs into lib.paths.clips / lib.paths.sounds, then the cue table. Never
 * deletes anything. Also holds the Scene tab's own UI settings file.
 */

/** The tab's UI settings, next to the recording (build_viewer.py only replaces *.mp4 / *.csv there). */
export const SCENE_UI_SETTINGS_FILE = 'studio-scene-ui.json'

const split = (path: string): [string, string] => { const i = path.lastIndexOf('/'); return [path.slice(0, i), path.slice(i + 1)] }

export async function dirAt(base: FileSystemDirectoryHandle, path: string, create = false): Promise<FileSystemDirectoryHandle> {
  let d = base
  for (const p of path.split('/').filter(Boolean)) d = await d.getDirectoryHandle(p, { create })
  return d
}
export async function readProjectFile(base: FileSystemDirectoryHandle, path: string): Promise<File> {
  const [d, n] = split(path)
  return (await (await dirAt(base, d)).getFileHandle(n)).getFile()
}
export async function writeProjectFile(base: FileSystemDirectoryHandle, path: string, data: BufferSource | Blob | string): Promise<void> {
  const [d, n] = split(path)
  const handle = await (await dirAt(base, d, true)).getFileHandle(n, { create: true })
  const stream = await handle.createWritable()
  try { await stream.write(data); await stream.close() } catch (error) { await stream.abort().catch(() => {}); throw error }
}
/** Base names of the .wav files directly in `path`, sorted. */
export async function listWavs(base: FileSystemDirectoryHandle, path: string): Promise<string[]> {
  const out: string[] = []
  for await (const [name, handle] of (await dirAt(base, path)).entries()) if (handle.kind === 'file' && /\.wav$/i.test(name)) out.push(name.slice(0, -4))
  return out.sort()
}

export type SceneOpenResult =
  | { ok: true; lib: SceneLib; data: SceneData }
  /** Not a project folder (no lib), or a lib that cannot be read. */
  | { ok: false; reason: 'noLib'; error: string }
  /** A project that has not been recorded yet: the folder is still worth remembering. */
  | { ok: false; reason: 'noData'; lib: SceneLib; error: string }

const message = (error: unknown) => error instanceof Error ? error.message : String(error)

export async function openSceneProject(root: FileSystemDirectoryHandle): Promise<SceneOpenResult> {
  let lib: SceneLib
  try { lib = parseViewerLib(await (await readProjectFile(root, `${VIEWER_DIR}/viewer-lib.json`)).text()) }
  catch (error) { return { ok: false, reason: 'noLib', error: message(error) } }
  try { return { ok: true, lib, data: parseViewerData(await (await readProjectFile(root, `${VIEWER_DIR}/viewer-data.json`)).text()) } }
  catch (error) { return { ok: false, reason: 'noData', lib, error: message(error) } }
}

export interface SceneTableFiles {
  table: CueTable
  /** WAV base names in lib.paths.clips. */
  clipFiles: string[]
  /** Cue sound candidates: WAVs in lib.paths.sounds minus lib.loop_sounds. */
  soundFiles: string[]
}
export async function readSceneTable(root: FileSystemDirectoryHandle, lib: SceneLib): Promise<SceneTableFiles> {
  const table = parseCueTable(await (await readProjectFile(root, lib.paths.cues)).text())
  const clipFiles = await listWavs(root, lib.paths.clips)
  const soundFiles = (await listWavs(root, lib.paths.sounds)).filter(n => !lib.loop_sounds.includes(n))
  return { table, clipFiles, soundFiles }
}

export interface PendingWavs { clips: Record<string, ArrayBuffer>; sounds: Record<string, ArrayBuffer> }
/** New WAVs first, then the cue table (so the table never points at a WAV that was not written). */
export async function writeSceneSave(root: FileSystemDirectoryHandle, lib: SceneLib, table: CueTable, pending: PendingWavs): Promise<void> {
  for (const [name, buf] of Object.entries(pending.clips)) await writeProjectFile(root, `${lib.paths.clips}/${name}.wav`, buf)
  for (const [name, buf] of Object.entries(pending.sounds)) await writeProjectFile(root, `${lib.paths.sounds}/${name}.wav`, buf)
  await writeProjectFile(root, lib.paths.cues, serializeCueTable(table))
}

/** The UI settings file text, or null when absent. */
export async function readSceneUiSettings(root: FileSystemDirectoryHandle): Promise<string | null> {
  try { return await (await readProjectFile(root, `${VIEWER_DIR}/${SCENE_UI_SETTINGS_FILE}`)).text() }
  catch (error) { if (error instanceof DOMException && error.name === 'NotFoundError') return null; throw error }
}
export const writeSceneUiSettings = (root: FileSystemDirectoryHandle, text: string) => writeProjectFile(root, `${VIEWER_DIR}/${SCENE_UI_SETTINGS_FILE}`, text)
/** Keeps an unreadable settings file under a new name before it is overwritten (never deleted). */
export async function keepSceneUiSettingsCopy(root: FileSystemDirectoryHandle, text: string): Promise<string> {
  const name = `studio-scene-ui.unreadable-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  await writeProjectFile(root, `${VIEWER_DIR}/${name}`, text)
  return name
}
