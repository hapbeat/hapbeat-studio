import { create } from 'zustand'
import { parseStoredUiSettings, DEFAULT_UI_SETTINGS, UI_SETTINGS_STORAGE_KEY, type EditorUiSettings } from '@/utils/editorUiSettings'

interface EditorSettingsState extends EditorUiSettings {
  /** Bumped when settings are replaced wholesale (folder copy, import, reset) so the dock re-applies `dockLayout`. */
  layoutRevision: number
  update: (patch: Partial<EditorUiSettings>) => void
  replace: (settings: EditorUiSettings) => void
}

function read(): EditorUiSettings {
  try { return parseStoredUiSettings(localStorage.getItem(UI_SETTINGS_STORAGE_KEY)) ?? { ...DEFAULT_UI_SETTINGS } } catch { return { ...DEFAULT_UI_SETTINGS } }
}
export function editorUiSettings(state: EditorUiSettings): EditorUiSettings {
  const { loop, loopDelay, height, muted, sendHaptics, clipThumbnails, clipGroupBy, collapsedGroups, projectNames, dockLayout, sceneLeadSec, scenePostRollSec, trialScenes, clipScenes, eventMarks, reservesOpen, groupPlayback, candidateSounds, materialLinks, hapticOnPc, autoAssignOnRating, eventReserves, reservesBackfilled, revisePending, hapticPending, soundPending, trialProjectFilter, trialTargetFilter } = state
  return { loop, loopDelay, height, muted, sendHaptics, clipThumbnails, clipGroupBy, collapsedGroups, projectNames, dockLayout, sceneLeadSec, scenePostRollSec, trialScenes, clipScenes, eventMarks, reservesOpen, groupPlayback, candidateSounds, materialLinks, hapticOnPc, autoAssignOnRating, eventReserves, reservesBackfilled, revisePending, hapticPending, soundPending, trialProjectFilter, trialTargetFilter }
}
function store(settings: EditorUiSettings) {
  try { localStorage.setItem(UI_SETTINGS_STORAGE_KEY, JSON.stringify(settings)) } catch { /* UI preferences must not prevent editing. */ }
}
export const useEditorSettings = create<EditorSettingsState>((set, get) => ({
  ...read(), layoutRevision: 0,
  update: patch => { set(patch); store(editorUiSettings(get())) },
  replace: settings => { set({ ...settings, layoutRevision: get().layoutRevision + 1 }); store(editorUiSettings(get())) },
}))
