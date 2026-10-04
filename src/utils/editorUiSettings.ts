import { isProjectName } from './editorFolder'

/**
 * Waveform editor UI preferences (dock layout, panel set, clip list view,
 * playback options). Haptic targets use the shared Kit device selection (deviceStore). Kept in three places so a cleared browser or a
 * new PC does not lose them: localStorage, `.hapbeat-editor/ui-settings.json`
 * in the editor folder, and a user-exported JSON file.
 */
export const UI_SETTINGS_FORMAT = 'hapbeat-editor-ui@1'
export const UI_SETTINGS_FILE = 'ui-settings.json'
export const UI_SETTINGS_STORAGE_KEY = 'hapbeat-editor-settings'

export type ClipGroupBy = 'project' | 'source'
export interface EditorUiSettings {
  loop: boolean
  loopDelay: number
  /** Waveform display height in px. */
  height: number
  /** PC audio muted during editor playback. */
  muted: boolean
  /** Stream haptics to the selected devices during editor playback (off = PC-only audition). Kit is unaffected. */
  sendHaptics: boolean
  clipThumbnails: boolean
  clipGroupBy: ClipGroupBy
  /** Collapsed clip-list group keys. */
  collapsedGroups: string[]
  /** User-listed project names; a clip named `<name>-…` joins that project automatically (see clipProjects). */
  projectNames: string[]
  /** dockview `toJSON()` output; null = default layout. */
  dockLayout: Record<string, unknown> | null
}

export const DEFAULT_UI_SETTINGS: EditorUiSettings = {
  loop: false, loopDelay: 0, height: 180, muted: false, sendHaptics: true,
  clipThumbnails: false, clipGroupBy: 'project', collapsedGroups: [], projectNames: [], dockLayout: null,
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const clamp = (value: unknown, min: number, max: number, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback
const strings = (value: unknown, max: number): value is string[] => Array.isArray(value) && value.length <= max && value.every(item => typeof item === 'string' && item.length <= 200)
/** Shallow shape check; dockview itself rejects a layout it cannot restore. */
const isDockLayout = (value: unknown): value is Record<string, unknown> => isRecord(value) && isRecord(value.grid) && isRecord(value.panels)

/** Field-by-field: an invalid or missing field falls back to its default, the rest is kept. */
export function sanitizeUiSettings(value: unknown): EditorUiSettings {
  const v = isRecord(value) ? value : {}
  const d = DEFAULT_UI_SETTINGS
  return {
    loop: typeof v.loop === 'boolean' ? v.loop : d.loop,
    loopDelay: clamp(v.loopDelay, 0, 60, d.loopDelay),
    height: clamp(v.height, 100, 700, d.height),
    muted: typeof v.muted === 'boolean' ? v.muted : d.muted,
    sendHaptics: typeof v.sendHaptics === 'boolean' ? v.sendHaptics : d.sendHaptics,
    clipThumbnails: typeof v.clipThumbnails === 'boolean' ? v.clipThumbnails : d.clipThumbnails,
    clipGroupBy: v.clipGroupBy === 'source' || v.clipGroupBy === 'project' ? v.clipGroupBy : d.clipGroupBy,
    collapsedGroups: strings(v.collapsedGroups, 1000) ? v.collapsedGroups : d.collapsedGroups,
    projectNames: strings(v.projectNames, 500) ? [...new Set(v.projectNames.filter(isProjectName))] : d.projectNames,
    dockLayout: isDockLayout(v.dockLayout) ? v.dockLayout : d.dockLayout,
  }
}

export function serializeUiSettings(settings: EditorUiSettings): string {
  return JSON.stringify({ format: UI_SETTINGS_FORMAT, ...settings }, null, 2)
}

/** Strict parse for the folder copy and imported files: must be JSON carrying the format tag. */
export function parseUiSettingsFile(text: string): { ok: true; settings: EditorUiSettings } | { ok: false; error: string } {
  let data: unknown
  try { data = JSON.parse(text) } catch (error) { return { ok: false, error: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}` } }
  if (!isRecord(data) || data.format !== UI_SETTINGS_FORMAT) return { ok: false, error: `format must be "${UI_SETTINGS_FORMAT}"` }
  return { ok: true, settings: sanitizeUiSettings(data) }
}

/** Lenient read of the localStorage copy (also accepts entries written before the format tag existed). */
export function parseStoredUiSettings(text: string | null): EditorUiSettings | null {
  if (text === null) return null
  try { const data = JSON.parse(text); return isRecord(data) ? sanitizeUiSettings(data) : null } catch { return null }
}

export type UiSettingsSource = 'folder' | 'local' | 'default'
/**
 * Settings to use when an editor folder is opened: the folder copy wins when
 * it is valid, else the localStorage copy, else defaults. `folderMalformed`
 * carries the parse error of an unreadable folder copy so the UI can report it.
 */
export function resolveUiSettings(folderText: string | null, localText: string | null): { settings: EditorUiSettings; source: UiSettingsSource; folderMalformed?: string } {
  let folderMalformed: string | undefined
  if (folderText !== null) {
    const parsed = parseUiSettingsFile(folderText)
    if (parsed.ok) return { settings: parsed.settings, source: 'folder' }
    folderMalformed = parsed.error
  }
  const local = parseStoredUiSettings(localText)
  return local ? { settings: local, source: 'local', folderMalformed } : { settings: { ...DEFAULT_UI_SETTINGS }, source: 'default', folderMalformed }
}
