import { parseViewerData, parseViewerLib, VIEWER_DIR, withRecordingLayers, type SceneData, type SceneLib } from './sceneData'
import { newCueTable, parseCueTable, SceneFormatError, serializeCueTable, type CueTable } from './sceneCueTable'

/**
 * Scene tab file access inside the opened game project folder (File System
 * Access API). Reads what the standalone viewer read and writes what it wrote:
 * new WAVs into lib.paths.clips / lib.paths.sounds, then the cue table. Never
 * deletes anything. Also holds the Scene tab's own UI settings file.
 */

/** The tab's UI settings, next to the recording (scene-recording section 3.5: a new recording keeps it). */
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
/** Base names of the .wav files directly in `path`, sorted (none while the folder does not exist yet). */
export async function listWavs(base: FileSystemDirectoryHandle, path: string): Promise<string[]> {
  const out: string[] = []
  let dir: FileSystemDirectoryHandle
  try { dir = await dirAt(base, path) } catch (error) { if (isNotFound(error)) return out; throw error }
  for await (const [name, handle] of dir.entries()) if (handle.kind === 'file' && /\.wav$/i.test(name)) out.push(name.slice(0, -4))
  return out.sort()
}
export const isNotFound = (error: unknown) => error instanceof DOMException && error.name === 'NotFoundError'

export type SceneOpenResult =
  | { ok: true; lib: SceneLib; data: SceneData }
  /** Not a project folder (no lib), or a lib that cannot be read (`oldFormat`: another schema_version, to be migrated). */
  | { ok: false; reason: 'noLib'; error: string; oldFormat: boolean }
  /** A project that has not been recorded yet (or whose recording is of another format): the folder is still worth remembering. */
  | { ok: false; reason: 'noData'; lib: SceneLib; error: string; oldFormat: boolean }

const message = (error: unknown) => error instanceof Error ? error.message : String(error)

/** Reads the lib and the recording; the lib gets the recording's layers when it names none (withRecordingLayers). */
export async function openSceneProject(root: FileSystemDirectoryHandle): Promise<SceneOpenResult> {
  let lib: SceneLib
  try { lib = parseViewerLib(await (await readProjectFile(root, `${VIEWER_DIR}/viewer-lib.json`)).text()) }
  catch (error) { return { ok: false, reason: 'noLib', error: message(error), oldFormat: error instanceof SceneFormatError } }
  try {
    const data = parseViewerData(await (await readProjectFile(root, `${VIEWER_DIR}/viewer-data.json`)).text(), lib)
    return { ok: true, lib: withRecordingLayers(lib, data), data }
  } catch (error) { return { ok: false, reason: 'noData', lib, error: message(error), oldFormat: error instanceof SceneFormatError } }
}

export interface SceneTableFiles {
  table: CueTable
  /** WAV base names in lib.paths.clips. */
  clipFiles: string[]
  /** Cue sound candidates: every WAV in lib.paths.sounds. */
  soundFiles: string[]
}
/** The cue table and the WAVs; null when the project has no cue table yet (createSceneTable makes one). */
export async function readSceneTable(root: FileSystemDirectoryHandle, lib: SceneLib): Promise<SceneTableFiles | null> {
  let text: string
  try { text = await (await readProjectFile(root, lib.paths.cues)).text() } catch (error) { if (isNotFound(error)) return null; throw error }
  const table = parseCueTable(text)
  const clipFiles = await listWavs(root, lib.paths.clips)
  const soundFiles = await listWavs(root, lib.paths.sounds)
  return { table, clipFiles, soundFiles }
}

/** Writes a new cue table (newCueTable) at lib.paths.cues; refuses when one is there already (never overwritten). */
export async function createSceneTable(root: FileSystemDirectoryHandle, lib: SceneLib, data: SceneData): Promise<CueTable> {
  try { await readProjectFile(root, lib.paths.cues); throw new Error(`${lib.paths.cues} exists already`) }
  catch (error) { if (!isNotFound(error)) throw error }
  const table = newCueTable(lib, data.full.events)
  await writeProjectFile(root, lib.paths.cues, serializeCueTable(table))
  return table
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
  catch (error) { if (isNotFound(error)) return null; throw error }
}
export const writeSceneUiSettings = (root: FileSystemDirectoryHandle, text: string) => writeProjectFile(root, `${VIEWER_DIR}/${SCENE_UI_SETTINGS_FILE}`, text)
/** Keeps an unreadable settings file under a new name before it is overwritten (never deleted). */
export async function keepSceneUiSettingsCopy(root: FileSystemDirectoryHandle, text: string): Promise<string> {
  const name = `studio-scene-ui.unreadable-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  await writeProjectFile(root, `${VIEWER_DIR}/${name}`, text)
  return name
}
