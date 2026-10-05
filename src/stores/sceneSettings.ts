import { create } from 'zustand'
import { DEFAULT_SCENE_UI, parseStoredSceneUi, SCENE_UI_STORAGE_KEY, type SceneUiSettings } from '@/utils/sceneUiSettings'

interface SceneSettingsState extends SceneUiSettings {
  /** Bumped when settings are replaced wholesale (project copy, import, reset) so the dock re-applies `dockLayout`. */
  layoutRevision: number
  update: (patch: Partial<SceneUiSettings>) => void
  replace: (settings: SceneUiSettings) => void
}

function read(): SceneUiSettings {
  try { return parseStoredSceneUi(localStorage.getItem(SCENE_UI_STORAGE_KEY)) ?? { ...DEFAULT_SCENE_UI } } catch { return { ...DEFAULT_SCENE_UI } }
}
export function sceneUiSettings(state: SceneUiSettings): SceneUiSettings {
  const { pcSound, hapticLeadMs, loop, sendHaptics, dockLayout } = state
  return { pcSound, hapticLeadMs, loop, sendHaptics, dockLayout }
}
function store(settings: SceneUiSettings) {
  try { localStorage.setItem(SCENE_UI_STORAGE_KEY, JSON.stringify(settings)) } catch { /* UI preferences must not prevent work. */ }
}
export const useSceneSettings = create<SceneSettingsState>((set, get) => ({
  ...read(), layoutRevision: 0,
  update: patch => { set(patch); store(sceneUiSettings(get())) },
  replace: settings => { set({ ...settings, layoutRevision: get().layoutRevision + 1 }); store(sceneUiSettings(get())) },
}))
