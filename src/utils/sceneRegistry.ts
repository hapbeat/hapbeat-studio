import { openDB } from 'idb'

/**
 * Scene project registry: game project name (viewer-lib.json `project_name`,
 * the same name an AI trial's `scene.project` / `project` uses) → the project
 * folder handle. Shared by the Scene tab, the editor's Scene video panel and
 * the AI trials, so a project folder is picked once and then found by name.
 * Only handles live here (IndexedDB); the folder stays the source of truth.
 */
const DB = 'hapbeat-scene-projects'
const STORE = 'projects'

const db = () => openDB(DB, 1, { upgrade(d) { if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE) } })

export async function registerSceneProject(name: string, handle: FileSystemDirectoryHandle): Promise<void> {
  await (await db()).put(STORE, handle, name)
}
export async function lookupSceneProject(name: string): Promise<FileSystemDirectoryHandle | null> {
  return ((await (await db()).get(STORE, name)) as FileSystemDirectoryHandle | undefined) ?? null
}
export async function sceneProjectNames(): Promise<string[]> {
  return ((await (await db()).getAllKeys(STORE)) as string[]).sort()
}
