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

/** The project last opened (localStorage; a preference only): a page load opens it again before anything else. */
const LAST_PROJECT_KEY = 'hapbeat-events-project'
export const lastSceneProject = (): string | null => { try { return localStorage.getItem(LAST_PROJECT_KEY) } catch { return null } }
export const rememberSceneProject = (name: string) => { try { localStorage.setItem(LAST_PROJECT_KEY, name) } catch { /* preference only */ } }

export interface RestoreCandidate<H> { handle: H; permission: PermissionState }
/**
 * Which folder a page load opens without a click: the last opened project (found by name in the registry)
 * wins over the Scene tab's own remembered folder (`scenedir`). When that project needs a click for its
 * permission, nothing opens (no other project replaces it; the Events panel offers "allow").
 */
export function restoreSceneHandle<H>(last: RestoreCandidate<H> | null, sceneDir: RestoreCandidate<H> | null): H | null {
  if (last) return last.permission === 'granted' ? last.handle : null
  return sceneDir?.permission === 'granted' ? sceneDir.handle : null
}
