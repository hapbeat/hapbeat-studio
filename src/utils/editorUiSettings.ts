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
/** Scene clip chosen for an AI trial in the Scene video panel: the Scene project and the clip's video file. */
export interface TrialSceneChoice { project: string; file: string }
/** An editor clip / AI candidate decided as an event's sound or haptic (clip-list badge). */
export interface EventMark { project: string; event: string; target: 'sound' | 'haptic' }
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
  /** Scene video panel: the video starts this many seconds before the cue mark when an audition plays. */
  sceneLeadSec: number
  /** Scene video panel: scene clip picked per AI trial id. */
  trialScenes: Record<string, TrialSceneChoice>
  /** Scene video panel: scene clip picked per editor clip id. */
  clipScenes: Record<string, TrialSceneChoice>
  /** Decisions per editor clip id or AI candidate (`<trialId>/<candidateId>`); newest last. */
  eventMarks: Record<string, EventMark[]>
  /** Events panel: height (px) of the event list above the detail. */
  eventsListHeight: number
  /** Editor clips opened from an event material ("Edit as clip"): edits are written back to that WAV. */
  materialLinks: Record<string, MaterialLink>
  /** Haptic auditions (AI haptic candidates, event haptic materials) also play their waveform on the PC (off: devices only). */
  hapticOnPc: boolean
  /** AI trials: saving a rating adds its ★4+ candidates to the material pool of the trial's first scene cue. */
  autoAssignOnRating: boolean
  /** Reserves per event (a trial's first scene cue): ★3 candidates kept aside, by reference — not in the cue table, never played by the game. */
  eventReserves: Record<string, ReserveRef[]>
  /** The one-time backfill of ★3 ratings saved before reserves existed has run. */
  reservesBackfilled: boolean
  /** "Remake" requests sent from the Events panel, shown on their material until a new trial for the cue arrives. */
  revisePending: RevisePending[]
  /** "Go to haptics" requests (cue, sent at), shown until a haptic trial for the cue arrives. */
  hapticPending: { cue: string; at: string }[]
  /** "Request a sound" requests (cue, sent at), shown until a sound trial for the cue arrives. */
  soundPending: { cue: string; at: string }[]
  /** AI trials panel project filter: '' = all, ' ' = trials without a project, else a project name. */
  trialProjectFilter: string
  /** AI trials panel target filter: '' = all, 'sound', 'haptic'. */
  trialTargetFilter: '' | 'sound' | 'haptic'
}

export const DEFAULT_UI_SETTINGS: EditorUiSettings = {
  loop: false, loopDelay: 0, height: 180, muted: false, sendHaptics: true,
  clipThumbnails: false, clipGroupBy: 'project', collapsedGroups: [], projectNames: [], dockLayout: null,
  sceneLeadSec: 1, trialScenes: {}, clipScenes: {}, eventMarks: {}, eventsListHeight: 220, materialLinks: {}, hapticOnPc: false, autoAssignOnRating: true, eventReserves: {}, reservesBackfilled: false, revisePending: [], hapticPending: [], soundPending: [], trialProjectFilter: '', trialTargetFilter: '',
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
/** The event material an editor clip edits: game project, event key, sound / haptic and the WAV name. */
export interface MaterialLink { project: string; event: string; target: 'sound' | 'haptic'; wav: string }
/** A "remake" request: the material of `cue`, sent at `at` (ISO). */
export interface RevisePending { cue: string; target: 'sound' | 'haptic'; material: string; at: string }
/** A reserved AI candidate: trial id + candidate id, and whether it is a sound or a haptic. */
export interface ReserveRef { trialId: string; candidateId: string; target: 'sound' | 'haptic' }
function reserves(value: unknown): Record<string, ReserveRef[]> {
  if (!isRecord(value)) return {}
  const out: Record<string, ReserveRef[]> = {}
  for (const [key, list] of Object.entries(value).slice(0, 500)) {
    if (!Array.isArray(list) || key.length > 200) continue
    const refs = list.filter((r): r is ReserveRef => isRecord(r) && typeof r.trialId === 'string' && typeof r.candidateId === 'string' && (r.target === 'sound' || r.target === 'haptic')
      && r.trialId.length <= 200 && r.candidateId.length <= 50).slice(0, 200).map(r => ({ trialId: r.trialId, candidateId: r.candidateId, target: r.target }))
    if (refs.length) out[key] = refs
  }
  return out
}
const clamp = (value: unknown, min: number, max: number, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback
const strings = (value: unknown, max: number): value is string[] => Array.isArray(value) && value.length <= max && value.every(item => typeof item === 'string' && item.length <= 200)
const isSceneChoice = (value: unknown): value is TrialSceneChoice => isRecord(value) && typeof value.project === 'string' && value.project.length <= 200
  && typeof value.file === 'string' && value.file.length <= 300
/** Choices keyed by AI trial / clip id (at most 2000); invalid entries are dropped. */
function sceneChoices(value: unknown): Record<string, TrialSceneChoice> {
  if (!isRecord(value)) return {}
  return Object.fromEntries(Object.entries(value).filter(([id, choice]) => /^[A-Za-z0-9_-]{1,80}$/.test(id) && isSceneChoice(choice)).slice(0, 2000)) as Record<string, TrialSceneChoice>
}
const isEventMark = (value: unknown): value is EventMark => isRecord(value) && typeof value.project === 'string' && value.project.length <= 200
  && typeof value.event === 'string' && value.event.length <= 200 && (value.target === 'sound' || value.target === 'haptic')
/** Marks keyed by clip id or `trialId/candidateId` (at most 2000 keys, 20 marks each); invalid entries are dropped. */
function eventMarks(value: unknown): Record<string, EventMark[]> {
  if (!isRecord(value)) return {}
  return Object.fromEntries(Object.entries(value)
    .filter((entry): entry is [string, unknown[]] => /^[A-Za-z0-9_-]{1,80}(\/[A-Za-z0-9_-]{1,16})?$/.test(entry[0]) && Array.isArray(entry[1]))
    .map(([id, marks]) => [id, marks.filter(isEventMark).slice(-20)] as const).filter(([, marks]) => marks.length).slice(0, 2000))
}
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
    sceneLeadSec: clamp(v.sceneLeadSec, 0, 10, d.sceneLeadSec),
    trialScenes: sceneChoices(v.trialScenes),
    clipScenes: sceneChoices(v.clipScenes),
    eventMarks: eventMarks(v.eventMarks),
    eventReserves: reserves(v.eventReserves),
    reservesBackfilled: v.reservesBackfilled === true,
    hapticPending: Array.isArray(v.hapticPending) ? v.hapticPending.filter((r): r is { cue: string; at: string } => isRecord(r) && typeof r.cue === 'string' && typeof r.at === 'string').slice(-200).map(r => ({ cue: r.cue, at: r.at })) : [],
    soundPending: Array.isArray(v.soundPending) ? v.soundPending.filter((r): r is { cue: string; at: string } => isRecord(r) && typeof r.cue === 'string' && typeof r.at === 'string').slice(-200).map(r => ({ cue: r.cue, at: r.at })) : [],
    revisePending: Array.isArray(v.revisePending) ? v.revisePending.filter((r): r is RevisePending => isRecord(r) && typeof r.cue === 'string' && typeof r.material === 'string' && typeof r.at === 'string'
      && (r.target === 'sound' || r.target === 'haptic')).slice(-200).map(r => ({ cue: r.cue, target: r.target, material: r.material, at: r.at })) : [],
    eventsListHeight: clamp(v.eventsListHeight, 80, 1200, d.eventsListHeight),
    hapticOnPc: v.hapticOnPc === true,
    materialLinks: isRecord(v.materialLinks) ? Object.fromEntries(Object.entries(v.materialLinks).filter((e): e is [string, MaterialLink] => isRecord(e[1]) && typeof e[1].project === 'string'
      && typeof e[1].event === 'string' && typeof e[1].wav === 'string' && (e[1].target === 'sound' || e[1].target === 'haptic')).slice(0, 500)
      .map(([id, l]) => [id, { project: l.project, event: l.event, target: l.target, wav: l.wav }])) : {},
    autoAssignOnRating: typeof v.autoAssignOnRating === 'boolean' ? v.autoAssignOnRating : d.autoAssignOnRating,
    trialProjectFilter: typeof v.trialProjectFilter === 'string' && v.trialProjectFilter.length <= 200 ? v.trialProjectFilter : d.trialProjectFilter,
    trialTargetFilter: v.trialTargetFilter === 'sound' || v.trialTargetFilter === 'haptic' ? v.trialTargetFilter : '',
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
