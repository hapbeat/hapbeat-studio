/**
 * Scene tab UI preferences (dock layout, PC sound, haptic lead, loop). Kept in
 * three places like the editor's: localStorage, `Saved/HapticViewer/studio-scene-ui.json`
 * in the opened game project, and a user-exported JSON file. "Send haptics"
 * is deliberately not stored: it starts OFF on every load (viewer behaviour,
 * so opening the tab never streams to a device by surprise).
 */
export const SCENE_UI_FORMAT = 'hapbeat-scene-ui@1'
export const SCENE_UI_STORAGE_KEY = 'hapbeat-scene-settings'

export interface SceneUiSettings {
  /** Play cue sounds on the PC (Web Audio). */
  pcSound: boolean
  /** Haptics are sent this much earlier than the video (ms; raise it when haptics feel late). */
  hapticLeadMs: number
  /** Loop the selected clip. */
  loop: boolean
  /** dockview `toJSON()` output; null = default layout. */
  dockLayout: Record<string, unknown> | null
}

export const DEFAULT_SCENE_UI: SceneUiSettings = { pcSound: true, hapticLeadMs: 0, loop: true, dockLayout: null }

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const isDockLayout = (value: unknown): value is Record<string, unknown> => isRecord(value) && isRecord(value.grid) && isRecord(value.panels)

/** Field-by-field: an invalid or missing field falls back to its default, the rest is kept. */
export function sanitizeSceneUi(value: unknown): SceneUiSettings {
  const v = isRecord(value) ? value : {}
  const d = DEFAULT_SCENE_UI
  return {
    pcSound: typeof v.pcSound === 'boolean' ? v.pcSound : d.pcSound,
    hapticLeadMs: typeof v.hapticLeadMs === 'number' && Number.isFinite(v.hapticLeadMs) ? Math.max(-200, Math.min(400, v.hapticLeadMs)) : d.hapticLeadMs,
    loop: typeof v.loop === 'boolean' ? v.loop : d.loop,
    dockLayout: isDockLayout(v.dockLayout) ? v.dockLayout : d.dockLayout,
  }
}

export function serializeSceneUi(settings: SceneUiSettings): string {
  return JSON.stringify({ format: SCENE_UI_FORMAT, ...settings }, null, 2)
}

/** Strict parse for the project copy and imported files: must be JSON carrying the format tag. */
export function parseSceneUiFile(text: string): { ok: true; settings: SceneUiSettings } | { ok: false; error: string } {
  let data: unknown
  try { data = JSON.parse(text) } catch (error) { return { ok: false, error: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}` } }
  if (!isRecord(data) || data.format !== SCENE_UI_FORMAT) return { ok: false, error: `format must be "${SCENE_UI_FORMAT}"` }
  return { ok: true, settings: sanitizeSceneUi(data) }
}

export function parseStoredSceneUi(text: string | null): SceneUiSettings | null {
  if (text === null) return null
  try { const data = JSON.parse(text); return isRecord(data) ? sanitizeSceneUi(data) : null } catch { return null }
}

/** Project copy when valid, else localStorage, else defaults; `folderMalformed` carries an unreadable project copy's error. */
export function resolveSceneUi(folderText: string | null, localText: string | null): { settings: SceneUiSettings; source: 'folder' | 'local' | 'default'; folderMalformed?: string } {
  let folderMalformed: string | undefined
  if (folderText !== null) {
    const parsed = parseSceneUiFile(folderText)
    if (parsed.ok) return { settings: parsed.settings, source: 'folder' }
    folderMalformed = parsed.error
  }
  const local = parseStoredSceneUi(localText)
  return local ? { settings: local, source: 'local', folderMalformed } : { settings: { ...DEFAULT_SCENE_UI }, source: 'default', folderMalformed }
}
