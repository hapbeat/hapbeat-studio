import { create } from 'zustand'
import { DEFAULT_SCENE_UI, parseStoredSceneUi, SCENE_UI_STORAGE_KEY, type SceneUiSettings } from '@/utils/sceneUiSettings'

interface SceneSettingsState extends SceneUiSettings {
  /** Bumped when settings are replaced wholesale (project copy, import, reset) so the dock re-applies `dockLayout`. */
  layoutRevision: number
  update: (patch: Partial<SceneUiSettings>) => void
  replace: (settings: SceneUiSettings) => void
}

/**
 * `editFirings` belongs to one project (it was confirmed there): never kept in localStorage, off until the project's
 * own settings file turns it on (useSceneSettingsFolderSync).
 */
function read(): SceneUiSettings {
  try { return { ...(parseStoredSceneUi(localStorage.getItem(SCENE_UI_STORAGE_KEY)) ?? DEFAULT_SCENE_UI), editFirings: false } } catch { return { ...DEFAULT_SCENE_UI } }
}
export function sceneUiSettings(state: SceneUiSettings): SceneUiSettings {
  const { pcSound, loop, sendHaptics, leadSec, dockLayout, editFirings } = state
  return { pcSound, loop, sendHaptics, leadSec, dockLayout, editFirings }
}
function store(settings: SceneUiSettings) {
  const { editFirings: _project, ...local } = settings
  try { localStorage.setItem(SCENE_UI_STORAGE_KEY, JSON.stringify(local)) } catch { /* UI preferences must not prevent work. */ }
}
export const useSceneSettings = create<SceneSettingsState>((set, get) => ({
  ...read(), layoutRevision: 0,
  update: patch => { set(patch); store(sceneUiSettings(get())) },
  replace: settings => { set({ ...settings, layoutRevision: get().layoutRevision + 1 }); store(sceneUiSettings(get())) },
}))
