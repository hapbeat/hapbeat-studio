import { create } from 'zustand'
import type { LibraryClip, KitDefinition, KitEvent, KitEventMode, LibraryFilter, BuiltinClipMeta, BuiltinLibraryIndex, LibraryViewMode, ClipAmpPreset } from '@/types/library'
import {
  saveClip,
  listClips,
  deleteClip,
  updateClipMeta,
  loadClipAudio,
  saveKitEventAudio,
  loadKitEventAudio,
  deleteKitEventAudio,
  deleteEncodedWavsForEvent,
  listKits,
  deleteKit,
} from '@/utils/libraryStorage'
import { useLogStore } from '@/stores/logStore'
import { encodeWavBlob } from '@/utils/wavIO'
import type { SampleRate } from '@/types/waveform'
import {
  isFileSystemAccessSupported,
  pickWorkDirectory,
  loadDirectoryHandle,
  clearDirectoryHandle,
  verifyPermission,
  listClipFiles,
  writeClipFile,
  deleteClipFile,
  readClipFile,
  archiveClipFile,
  renameClipFile,
  writeMetadataJson,
  readMetadataJson,
  scanKitOutputFolder,
  archiveKitFolder,
  writeKitFolder,
  loadKitDiskCache,
  saveKitDiskCache,
  migrateLegacyArchiveFolders,
  isHiddenStudioDir,
  type DiscoveredKit,
  type KitDiskCache,
} from '@/utils/localDirectory'
import {
  exportKitAsPack,
  manifestFileName,
  toKitId,
  type ExportFile,
} from '@/utils/kitExporter'

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

/** Derive display name from filename: "impact/gunshot_1.wav" → "gunshot_1". 拡張子のみ除去、ハイフン/アンダースコアは保持 */
function filenameToDisplayName(filename: string): string {
  const parts = filename.replace(/\\/g, '/').split('/')
  return parts[parts.length - 1].replace(/\.(wav|mp3|ogg|flac|aac|m4a)$/i, '')
}

/** 旧実装（2026-04-20 以前）が生成していた display name。
 *  既存 metadata の自動生成名がこれと一致していたら新実装に書き換える。 */
function legacyFilenameToDisplayName(filename: string): string {
  const parts = filename.replace(/\\/g, '/').split('/')
  const base = parts[parts.length - 1].replace(/\.(wav|mp3|ogg|flac|aac|m4a)$/i, '')
  return base
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

/**
 * Sanitize a single Event ID part to match the contracts regex
 * `^[a-z][a-z0-9_-]{0,63}$`. Used for both kit name (category) and
 * clip name (event-id name part).
 */
export function sanitizeEventIdPart(s: string): string {
  let out = (s || '').toLowerCase().replace(/[^a-z0-9_-]/g, '_').replace(/_{2,}/g, '_')
  out = out.replace(/^[_-]+/, '').replace(/[_-]+$/, '')
  // 先頭は英小文字必須
  if (!/^[a-z]/.test(out)) out = `c${out ? '_' + out : ''}`
  return out.slice(0, 64)
}

/**
 * Compose `eventId = "<kitName>.<clipName>"` (both sanitized).
 *
 * The kit's name is the **only** source of the category. Clip
 * sourceFilename is no longer consulted — `clip.name` is the user-
 * editable identifier and feeds the name part.
 *
 * Returns "" if either part is empty (caller treats that as "needs
 * filling in" and blocks Save).
 */
export function composeKitEventId(kitName: string, clipName: string): string {
  const cat = sanitizeEventIdPart(kitName)
  const name = sanitizeEventIdPart(clipName)
  if (!cat || !name) return ''
  return `${cat}.${name}`
}

/**
 * Validate a kit name. Aligned with contracts' `kit_id` pattern
 * `^[a-z][a-z0-9-]*$` so kit_id, manifest.name, and the on-disk
 * folder name can all share a single value (no need for separate
 * id-vs-display variants). Underscores are NOT allowed — use `-`.
 *
 * Returns null on success, otherwise an error message.
 */
export function validateKitName(name: string): string | null {
  if (!name) return 'Kit name is required'
  if (name.length > 64) return 'Kit name must be 64 chars or fewer'
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    return 'Kit name must start with a-z and use only [a-z 0-9 -]'
  }
  return null
}

/** Source tab for the library view */
export type LibraryTab = 'builtin' | 'user'

interface LibraryState {
  // Clip library
  clips: LibraryClip[]
  isLoading: boolean

  // Built-in library
  builtinIndex: BuiltinClipMeta[] | null
  builtinLoading: boolean
  builtinAudioCache: Map<string, Blob>
  activeTab: LibraryTab
  viewMode: LibraryViewMode

  // Local work directory (File System Access API)
  workDirHandle: FileSystemDirectoryHandle | null
  workDirName: string | null
  workDirSupported: boolean
  /** Optional: separate output folder for exported Kits (e.g. Unity's
   *  Assets/HapbeatKits). When null, kits are saved under workDir/kits/. */
  kitDirHandle: FileSystemDirectoryHandle | null
  kitDirName: string | null

  // Kit management
  kits: KitDefinition[]
  activeKitId: string | null

  /**
   * Global "what's the local file system doing right now" indicator.
   * Updated by every write path (clip rename / archive / kit save / kit
   * archive / metadata flush). The footer reads this to surface a
   * single Studio-wide status pill so the user knows their edits are
   * really hitting disk.
   *
   * - saving: a write is in flight
   * - saved: write landed
   * - retrying: a write failed but auto-retry is in progress
   *   (warning, not an error — the user need not act)
   * - error: retry budget exhausted, the user must intervene
   */
  localFsStatus: 'idle' | 'saving' | 'saved' | 'retrying' | 'error'
  localFsLastMsg: string
  localFsLastTs: number
  setLocalFsStatus: (
    status: LibraryState['localFsStatus'],
    msg?: string,
  ) => void

  /**
   * Build the kit ZIP and write `<outRoot>/<kitId>/` to disk *now*.
   * Validates silently — invalid kits / missing outRoot return null.
   * Updates the per-kit ZIP cache used by Deploy.
   */
  flushKitFolderNow: (kitId: string) => Promise<{ files: ExportFile[]; kitId: string } | null>
  /**
   * Same as flushKitFolderNow but seeds an `opMsg` first so the
   * footer status pill announces `saving → saved` (or `error`) to the
   * user. Use this for *explicit* save actions (e.g. the
   * "Save Folder" button) where we want UI feedback. Direct
   * `flushKitFolderNow`
   * stays silent on success so background-build callers (Deploy
   * pre-flight) don't spam the pill.
   */
  requestKitFolderSave: (kitId: string, opMsg: string) => Promise<{ files: ExportFile[]; kitId: string } | null>
  /**
   * Debounced wrapper around flushKitFolderNow. Replaces any pending
   * timer for the same kit. Pass delayMs=0 to flush on the next
   * microtask without awaiting (used by createKit to make the folder
   * pop up in Explorer immediately).
   */
  scheduleKitFlush: (kitId: string, delayMs?: number) => void
  /** Cancel any pending flush for kitId (called from removeKit so the
   *  archived folder is not recreated by a stale debounce timer). */
  cancelKitFlush: (kitId: string) => void
  /** Latest Save Folder output for a kit (file list, no ZIP). Deploy
   *  builds the ZIP on demand from this via `buildKitZip` — Save Folder
   *  never needs a ZIP, so we skip the encode/decode round trip. */
  getLastBuiltKit: (kitId: string) => { files: ExportFile[]; kitId: string } | undefined

  /** Clip id currently open in the inline editor (Clips panel). Set from
   *  either the Clips panel itself or from a Kit event row's Edit action so
   *  the user lands in the same editor regardless of entry point. */
  editingClipId: string | null

  /**
   * Page-wide single-card selection. Lives in the store so the Clips
   * panel and the Kit Editor share one source of truth — clicking a
   * card in either panel deselects whatever the other panel had
   * highlighted. This is what determines which card the keyboard's
   * Space / ↑↓ / ←→ shortcuts target, and the visual "currently
   * selected" highlight is also driven by it.
   *
   * `panel` identifies which list the id belongs to; `id` is the
   * LibraryClip.id for `'library'` and the KitEvent.id for `'kit'`.
   * `null` = no selection.
   */
  activeSelection: { panel: 'library' | 'kit'; id: string } | null

  /** Whether clip cards show the details row (duration / sample rate /
   *  channels / file size / tags). Global toggle so library and kit stay
   *  visually in sync. */
  showClipDetails: boolean

  // Filter
  filter: LibraryFilter
  builtinCategoryFilter: string | null

  // Clip actions
  loadLibrary: () => Promise<void>
  loadBuiltinIndex: () => Promise<void>
  fetchBuiltinClipAudio: (builtinId: string) => Promise<Blob | undefined>
  importBuiltinToLocal: (builtinId: string) => Promise<string | undefined>
  /**
   * Imports every built-in clip into the current clip collection.
   * Called automatically when the user picks a fresh work directory so
   * they start with the shipped library available as ordinary clips
   * they can edit, tag, rename or delete.
   */
  importAllBuiltinClips: () => Promise<number>
  addClipFromBuffer: (
    buffer: AudioBuffer,
    name: string,
    sampleRate: SampleRate,
    sourceFilename: string
  ) => Promise<string>
  addClipFromFile: (file: File) => Promise<string>
  removeClip: (id: string) => Promise<void>
  /** Move a clip into clips/archive/. Preferred over removeClip — the file
   *  is preserved on disk so the user can recover it by moving it back.
   *  Returns true on success. */
  archiveClip: (id: string) => Promise<boolean>
  updateClip: (id: string, updates: Partial<LibraryClip>) => Promise<void>
  /** name の現在値に合わせて clips/ 配下の実ファイル名を同期する（Edit modal の確定時などに呼ぶ） */
  commitClipRename: (id: string) => Promise<void>
  /** Library の amp (libraryIntensity) を更新。workDir に永続化される。 */
  setLibraryIntensity: (id: string, value: number) => Promise<void>

  // Amp preset actions
  ampPresets: ClipAmpPreset[]
  loadAmpPresets: () => Promise<void>
  saveAmpPreset: (name: string) => Promise<void>
  applyAmpPreset: (name: string) => Promise<void>
  deleteAmpPreset: (name: string) => Promise<void>

  getClipAudio: (id: string) => Promise<Blob | undefined>
  /** Resolve audio for a KitEvent (independent of library — see
   *  `saveKitEventAudio` / `KitEvent.id` IDB key). */
  getKitEventAudio: (kitEventId: string) => Promise<Blob | undefined>

  // Work directory actions
  pickWorkDir: () => Promise<boolean>
  restoreWorkDir: () => Promise<boolean>
  disconnectWorkDir: () => Promise<void>
  // Kit output directory (separate folder for kit exports)
  pickKitDir: () => Promise<boolean>
  restoreKitDir: () => Promise<boolean>
  disconnectKitDir: () => Promise<void>
  /** Scan kitDirHandle for kit subfolders (manifest.json + clips/ + stream-clips/)
   *  and merge them into the in-memory kits[] + clips[]. Called automatically
   *  when the kit output folder is chosen or restored on startup. */
  importKitsFromOutputDir: () => Promise<number>
  syncClipsToDir: () => Promise<void>
  syncClipsFromDir: () => Promise<void>
  /** Re-scan work dir clips/ folder and update clips list (adds new, removes deleted) */
  refreshClipsFromDir: () => Promise<void>

  // Kit actions
  createKit: (name: string) => Promise<string>
  removeKit: (id: string) => Promise<void>
  setActiveKit: (id: string | null) => void
  setEditingClipId: (id: string | null) => void
  /** Page-wide single-card selection setter. Pass null to clear. */
  setActiveSelection: (selection: { panel: 'library' | 'kit'; id: string } | null) => void
  setShowClipDetails: (show: boolean) => void
  /**
   * Adds an event to a kit. The caller passes an event *without* the stable
   * per-kit id; the store generates it. Returns the generated id on success
   * so the UI can scroll to / highlight the new row if desired.
   *
   * Duplicate eventIds are now allowed (e.g. the same clip added with two
   * different amps as two distinct events).
   */
  /**
   * Add a kit event. The caller must pass the audio blob — the store
   * saves it into the kit-event-owned IDB slot under the new event's
   * generated id. `null` is no longer a valid value post schema 2.0.0
   * (clip required in both buckets); kept in the signature for the
   * gradual call-site cleanup.
   */
  addEventToKit: (kitId: string, event: Omit<KitEvent, 'id'>, audioBlob: Blob | null) => Promise<string | null>
  /** Remove an event by its per-kit id (not eventId — duplicates are allowed). */
  removeEventFromKit: (kitId: string, kitEventId: string) => Promise<void>
  updateKitEvent: (kitId: string, kitEventId: string, updates: Partial<KitEvent>) => Promise<void>
  updateKit: (id: string, updates: Partial<KitDefinition>) => Promise<void>

  // Tab / filter actions
  setActiveTab: (tab: LibraryTab) => void
  setViewMode: (mode: LibraryViewMode) => void
  setBuiltinCategoryFilter: (category: string | null) => void
  setFilter: (filter: Partial<LibraryFilter>) => void
  resetFilter: () => void

  // Computed
  filteredClips: () => LibraryClip[]
  filteredBuiltinClips: () => BuiltinClipMeta[]
  allTags: () => string[]
  allGroups: () => string[]
  builtinCategories: () => string[]
}

const DEFAULT_FILTER: LibraryFilter = {
  searchQuery: '',
  selectedTags: [],
  selectedGroup: null,
  // Default to alphabetical by name — users find clips by reading
  // labels far more often than by recency. The `kitSort` UI on the
  // Kit panel already defaults the same way, so the two panels read
  // consistently on first open.
  sortBy: 'name',
  sortOrder: 'asc',
}

const CLIPS_META_FILE = 'clips-meta.json'
const KITS_META_FILE = 'kits-meta.json'
const AMP_PRESETS_FILE = 'amp-presets.json'

// localStorage key for the sort preference. We persist ONLY the sort
// fields (not the whole filter): search / tag / group selections are
// session-transient — bringing back the same search query across
// reloads would surprise users. The sort, in contrast, is a stable
// "how I like my list" preference that should survive.
const LIBRARY_SORT_KEY = 'hapbeat-studio-library-sort'

function loadPersistedSort(): Pick<LibraryFilter, 'sortBy' | 'sortOrder'> | null {
  try {
    const raw = localStorage.getItem(LIBRARY_SORT_KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as Partial<LibraryFilter>
    // Validate before adopting — a corrupted entry shouldn't break
    // the whole page on load.
    const validBy = v.sortBy === 'name' || v.sortBy === 'date' || v.sortBy === 'duration'
    const validOrder = v.sortOrder === 'asc' || v.sortOrder === 'desc'
    if (!validBy || !validOrder) return null
    return { sortBy: v.sortBy as LibraryFilter['sortBy'], sortOrder: v.sortOrder as LibraryFilter['sortOrder'] }
  } catch { return null }
}

function savePersistedSort(filter: LibraryFilter): void {
  try {
    localStorage.setItem(LIBRARY_SORT_KEY, JSON.stringify({
      sortBy: filter.sortBy, sortOrder: filter.sortOrder,
    }))
  } catch { /* ignore — quota or disabled storage */ }
}


/** Save clips metadata to the local work directory */
async function saveClipsMetaToDir(handle: FileSystemDirectoryHandle, clips: LibraryClip[]) {
  await writeMetadataJson(handle, CLIPS_META_FILE, clips)
}

/**
 * Upgrade legacy KitDefinitions to the current shape. Currently handles:
 *  - missing stable `id` per event
 *  - legacy single-mode field (`mode?`) → multi-mode array (`modes: [mode]`).
 *    Default is `['command']` when neither field is present.
 *  - legacy `clipId` / `localName` references → snapshot fields
 *    (`clipName`, `clipSourceFilename`, clip*) copied off the current
 *    LibraryClip list. This is the structural migration that turned
 *    KitEvents into independent owners of their clip data.
 *
 * Pass the current library `clips` list so the migrator can resolve a
 * legacy event's `clipId` back to a snapshot. When the library entry is
 * missing (e.g. user already archived it before this code shipped) the
 * event keeps a placeholder name and the on-disk WAV in the kit folder
 * stays the source of truth.
 *
 * Idempotent: re-running on an already-migrated kit is a no-op.
 *
 * Note: audio blob migration (copying `STORE_AUDIO[clipId]` to
 * `STORE_AUDIO[event.id]`) lives in `migrateKitAudioAsync` below — sync
 * vs async paths are split so this function can stay pure / cheap to
 * call from render-adjacent code paths.
 */
function migrateKit(kit: KitDefinition, libraryClips: LibraryClip[]): KitDefinition {
  let changed = false
  const events = kit.events.map((e) => {
    let next = e
    if (!next.id) {
      next = { ...next, id: generateId() }
      changed = true
    }
    if (!Array.isArray(next.modes) || next.modes.length === 0) {
      const legacy = (next as unknown as { mode?: KitEventMode }).mode
      const seed: KitEventMode[] = [legacy ?? 'command']
      const { mode: _drop, ...rest } = next as unknown as KitEvent & { mode?: KitEventMode }
      void _drop
      next = { ...rest, modes: seed }
      changed = true
    }
    // clipName missing → this is a legacy event that referenced its
    // clip indirectly via `clipId`. Snapshot the relevant fields off
    // the library clip + drop the now-stale clipId / localName keys.
    // When the library entry is gone we fall back to localName (kit-
    // side rename, if any) or a placeholder so the event stays valid.
    const legacyRef = next as unknown as KitEvent & {
      clipId?: string; localName?: string
    }
    if (next.clipName === undefined) {
      const libClip = legacyRef.clipId
        ? libraryClips.find((c) => c.id === legacyRef.clipId)
        : undefined
      const fallbackName = legacyRef.localName ?? libClip?.name ?? '(missing clip)'
      const seed: Partial<KitEvent> = {
        clipName: fallbackName,
        clipSourceFilename: libClip?.sourceFilename ?? `${fallbackName}.wav`,
        clipDuration: libClip?.duration ?? 0,
        clipChannels: libClip?.channels ?? 1,
        clipSampleRate: libClip?.sampleRate ?? 16000,
        clipFileSize: libClip?.fileSize ?? 0,
      }
      const {
        clipId: _id, localName: _ln, ...rest
      } = legacyRef
      void _id; void _ln
      next = { ...rest, ...seed } as KitEvent
      changed = true
    }
    return next
  })
  return changed ? { ...kit, events } : kit
}

/**
 * Walk a list of (pre-migration) kits and collect the `event.id →
 * legacy clipId` map so `migrateKitAudioAsync` can copy the right blob
 * AFTER `migrateKit` has already stripped the clipId from the in-memory
 * shape. Skips entries that aren't legacy (= already migrated) so it's
 * safe to call on a mixed-state list.
 */
function collectLegacyClipAudioMap(kits: KitDefinition[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const k of kits) {
    for (const e of k.events) {
      const legacy = e as unknown as { clipId?: string; clipName?: string; id?: string }
      if (legacy.clipName === undefined && legacy.clipId && legacy.id) {
        out.set(legacy.id, legacy.clipId)
      }
    }
  }
  return out
}

/**
 * Best-effort async companion to `migrateKit` that copies the legacy
 * library audio blob into the kit event's own IDB slot. Called once
 * per legacy event during `loadLibrary` so previewing a migrated kit
 * works without needing to re-import the WAV from the kit folder.
 *
 * Silent / idempotent: if the destination already has a blob or the
 * source is missing, nothing happens. Failures are logged and swallowed
 * — the on-disk WAV inside the kit folder is the ultimate fallback.
 */
async function migrateKitAudioAsync(
  legacyClipIdByEventId: Map<string, string>,
): Promise<void> {
  for (const [eventId, legacyClipId] of legacyClipIdByEventId) {
    try {
      const existing = await loadKitEventAudio(eventId)
      if (existing) continue
      const sourceBlob = await loadClipAudio(legacyClipId)
      if (!sourceBlob) continue
      await saveKitEventAudio(eventId, sourceBlob)
    } catch (err) {
      console.warn('[migrateKitAudio] failed for event', eventId, err)
    }
  }
}

/** Save kits metadata to the local work directory */
async function saveKitsMetaToDir(handle: FileSystemDirectoryHandle, kits: KitDefinition[]) {
  await writeMetadataJson(handle, KITS_META_FILE, kits)
}

// ---- Kit folder persistence (module-level state) ------------------------
//
// Per-kit debounce timers, last-written kitId (for rename → archive
// old folder) and last-built ZIP cache (for Deploy). These live outside
// zustand state because they're internal bookkeeping that should not
// trigger React re-renders.

const kitFlushTimers = new Map<string, number>()
const lastWrittenKitId = new Map<string, string>()
/**
 * Last successful Save Folder output per kit. The `files` array is the
 * ExportFile[] produced by `exportKitAsPack` (no zip generation
 * involved); Deploy builds the ZIP on demand from this array via
 * `buildKitZip`. Cleared on archive / kit folder change / kit
 * removal so a stale build can't end up on the wire.
 */
const lastBuiltKit = new Map<string, { files: ExportFile[]; kitId: string }>()
// Skip-write ledger is no longer in-memory: the IDB encoded-wavs cache
// already records (sourceHash → encodedBlob) per (eventId, mode), so
// `flushKitFolderNow` reads `ExportFile.cached` (set by exportKitAsPack
// when loadEncodedWav hits) + a kitFileExists check to decide whether
// to skip the disk write. Earlier versions kept an in-memory map here,
// but that was empty after browser reload — defeating the skip on the
// very first Save Folder of a session.

/**
 * Per-kit flush mutex. Prevents two `flushKitFolderNow` calls for the
 * same kit from interleaving — the File System Access API throws
 * `InvalidStateError` ("operation that depends on state cached in an
 * interface object …") when `getFileHandle` / `getFile` reads against
 * a directory that another concurrent call is in the middle of
 * overwriting. We chain new requests onto the in-flight promise so
 * each kit's writes are strictly serialized.
 */
const kitFlushChain = new Map<string, Promise<unknown>>()

/**
 * Per-kit auto-retry state. When `flushKitFolderNow` fails (typically
 * a transient `InvalidStateError` from a racy directory read), we
 * schedule another attempt after exponential backoff so the user
 * never has to manually retry. A successful flush — or a fresh user
 * action arriving via scheduleKitFlush — resets the attempt counter.
 */
const retryAttempts = new Map<string, number>()
const retryTimers = new Map<string, number>()
const RETRY_MAX_ATTEMPTS = 8
function retryDelayMs(attempt: number): number {
  // 500, 1000, 2000, 4000, 5000, 5000, …
  return Math.min(500 * 2 ** (attempt - 1), 5000)
}

/**
 * Per-kit pending operation description. Each mutation sets a
 * human-readable string (e.g. `kit "X" の "old.wav" → "new.wav"`)
 * which the status pill surfaces while the flush is queued and once
 * it lands on disk. Coalesced mutations show the *latest* message.
 */
const lastOpMessage = new Map<string, string>()
function setOp(kitId: string, msg: string) {
  lastOpMessage.set(kitId, msg)
  useLibraryStore.getState().setLocalFsStatus('saving', msg)
}

/**
 * Drop all per-kit module-level bookkeeping. Called when the user
 * switches kitDir / disconnects it — the previous folder's kits go
 * out of scope and any pending writes targeting them must NOT fire
 * against the new folder.
 */
function resetKitMemory() {
  for (const t of kitFlushTimers.values()) window.clearTimeout(t)
  kitFlushTimers.clear()
  for (const t of retryTimers.values()) window.clearTimeout(t)
  retryTimers.clear()
  retryAttempts.clear()
  kitFlushChain.clear()
  lastWrittenKitId.clear()
  lastBuiltKit.clear()
  lastOpMessage.clear()
}

/**
 * Check whether `<root>/<kitId>/<relPath>` exists. Used by the
 * skip-write heuristic so a manually-deleted WAV on disk is detected
 * and re-emitted instead of left missing. Returns `false` on any
 * lookup error (kit dir missing, sub-folder missing, file not
 * found) — caller should write the file in that case.
 */
async function kitFileExists(
  root: FileSystemDirectoryHandle,
  kitId: string,
  relPath: string,
): Promise<boolean> {
  try {
    const parts = relPath.split('/')
    let dir = await root.getDirectoryHandle(kitId, { create: false })
    for (let i = 0; i < parts.length - 1; i++) {
      dir = await dir.getDirectoryHandle(parts[i], { create: false })
    }
    await dir.getFileHandle(parts[parts.length - 1], { create: false })
    return true
  } catch {
    return false
  }
}

/**
 * Read the text content of a file at `<root>/<kitId>/<relPath>`.
 * Returns `null` on any lookup failure (file missing, sub-folder
 * missing, permission, etc). Used by the manifest-unchanged detector
 * so a kit save with identical on-disk manifest reports "変更なし".
 */
async function readKitFileText(
  root: FileSystemDirectoryHandle,
  kitId: string,
  relPath: string,
): Promise<string | null> {
  try {
    const parts = relPath.split('/')
    let dir = await root.getDirectoryHandle(kitId, { create: false })
    for (let i = 0; i < parts.length - 1; i++) {
      dir = await dir.getDirectoryHandle(parts[i], { create: false })
    }
    const handle = await dir.getFileHandle(parts[parts.length - 1], { create: false })
    const file = await handle.getFile()
    return await file.text()
  } catch {
    return null
  }
}

export const useLibraryStore = create<LibraryState>((set, get) => ({
  clips: [],
  isLoading: false,
  builtinIndex: null,
  builtinLoading: false,
  builtinAudioCache: new Map(),
  activeTab: 'builtin' as LibraryTab,
  viewMode: 'side' as LibraryViewMode,
  workDirHandle: null,
  workDirName: null,
  workDirSupported: isFileSystemAccessSupported(),
  kitDirHandle: null,
  kitDirName: null,
  kits: [],
  activeKitId: null,
  editingClipId: null,
  activeSelection: null,
  showClipDetails: true,
  // Initial filter = defaults overlaid with the persisted sort (if
  // any) so the user's preferred sort survives reload but session-
  // local fields (search / tags / group) start fresh.
  filter: { ...DEFAULT_FILTER, ...(loadPersistedSort() ?? {}) },
  builtinCategoryFilter: null,
  ampPresets: [],
  localFsStatus: 'idle',
  localFsLastMsg: '',
  localFsLastTs: 0,
  setLocalFsStatus: (status, msg = '') => {
    set({
      localFsStatus: status,
      localFsLastMsg: msg,
      localFsLastTs: Date.now(),
    })
  },

  // ---- Kit folder persistence -------------------------------------------

  flushKitFolderNow: async (kitId) => {
    // Serialize concurrent flushes for the same kit. The actual work
    // runs in `doFlush`; if a flush is already in flight, we await it
    // first then run our own (so the latest store state hits disk last).
    const doFlush = async (): Promise<{ files: ExportFile[]; kitId: string } | null> => {
    const state = get()
    const kit = state.kits.find((k) => k.id === kitId)
    if (!kit) return null
    if (validateKitName(kit.name)) {
      // Invalid kit name — clear 'saving' status to avoid stuck pill.
      state.setLocalFsStatus('idle')
      return null
    }
    const outRoot = state.kitDirHandle ?? state.workDirHandle
    if (!outRoot) {
      // No folder selected — clear 'saving' status so the pill doesn't
      // stay stuck (the caller sets 'saving' before scheduleKitFlush,
      // but if we bail here we'd never set 'saved' or 'error').
      state.setLocalFsStatus('idle')
      return null
    }

    // The mutation that scheduled this flush set 'saving' with a
    // descriptive op message. If no op message is recorded (e.g. a
    // direct flushKitFolderNow call from the Deploy code path), we
    // intentionally don't broadcast a vague "kit X を保存" — that
    // confuses the user. Only error / retry surface a fallback so
    // problems are never silent.
    const opMsg = lastOpMessage.get(kit.id)
    try {
      // exportKitAsPack returns ExportFile[] directly (no ZIP encode
      // / decode round-trip). For unchanged audio the IDB encoded-WAV
      // cache also skips decode + re-encode. The remaining disk writes
      // are pruned below by lastWrittenWavs.
      const result = await exportKitAsPack(kit)

      // Race-condition guard: kit may have been removed (× clicked)
      // while exportKitAsPack was running. Bail before any disk write.
      if (!useLibraryStore.getState().kits.some((k) => k.id === kit.id)) {
        return null
      }

      const kitId = result.kitId

      // Rename: if this kit was previously written under a different
      // kitId, archive the stale folder so it stops appearing in OS
      // Explorer. The new folder is written below.
      const prevKitId = lastWrittenKitId.get(kit.id)
      const kitIdChanged = !!prevKitId && prevKitId !== kitId
      if (kitIdChanged) {
        try { await archiveKitFolder(outRoot, prevKitId!) } catch { /* ignore */ }
      }

      // Version-bump history: snapshot the existing manifest under
      // history/manifest-<oldVersion>.json before overwriting. WAVs
      // aren't kept (size cost) — just the small manifest. The
      // preferred filename is `<kitId>-manifest.json`; we fall back
      // to legacy `manifest.json` so kits saved before the rename
      // (2026-05-17) still produce a history entry on first re-save.
      try {
        const thisKitDir = await outRoot.getDirectoryHandle(kitId, { create: false })
        const preferredName = manifestFileName(kitId)
        let oldHandle: FileSystemFileHandle | null = null
        try {
          oldHandle = await thisKitDir.getFileHandle(preferredName, { create: false })
        } catch {
          try {
            oldHandle = await thisKitDir.getFileHandle('manifest.json', { create: false })
          } catch { /* no prior manifest */ }
        }
        if (oldHandle) {
          const oldText = await (await oldHandle.getFile()).text()
          const oldVersion = String((JSON.parse(oldText) as { version?: unknown }).version ?? '')
          if (oldVersion && oldVersion !== (kit.version || '1.0.0')) {
            const histDir = await thisKitDir.getDirectoryHandle('history', { create: true })
            const safeVer = oldVersion.replace(/[^a-zA-Z0-9_.-]/g, '_')
            const archHandle = await histDir.getFileHandle(`manifest-${safeVer}.json`, { create: true })
            const w = await archHandle.createWritable()
            await w.write(oldText)
            await w.close()
          }
        }
      } catch { /* no existing manifest — first save */ }

      // ---- Skip-write heuristic ----
      //
      // Source of truth: `<kitId>/.studio-cache.json` (KitDiskCache v2).
      // It records the SHA-1 of the on-disk WAV bytes from the last
      // flush. We compare against the prospective output's hash — if
      // they match (and the file is still present), the bytes we'd
      // write are bit-exact what's already on disk, so skip the write.
      //
      // Living on disk with the kit, the cache survives:
      //   - browser data clears,
      //   - switching browsers (Chrome ↔ Edge),
      //   - moving the kit folder between machines (e.g. cloud sync),
      //   - hard reload + folder re-pick (the previous design's blind
      //     spot — re-import gave each event a new id and a different
      //     "source" blob, so a sourceHash-keyed ledger always missed).
      //
      // Decision per ExportFile:
      //   - `outputHash === null` (manifest.json)   → write (always)
      //   - kitId just changed (kit rename)         → write (new folder)
      //   - disk cache lacks an entry for this path  → write (first save)
      //   - disk cache hash differs from current     → write (audio changed)
      //   - on-disk file is missing                  → write (user deleted)
      //   - otherwise                                → skip
      //
      // The IDB encoded-wavs cache still helps separately — it lets
      // exportKitAsPack skip decode + re-encode when source audio is
      // unchanged. The disk cache governs disk writes; the IDB cache
      // governs CPU work. They're independent.
      const diskCache = await loadKitDiskCache(outRoot, kitId)
      const prevOutputHash: Record<string, string> = diskCache?.wavs ?? {}
      const filesToWrite: ExportFile[] = []
      let skippedCount = 0
      let manifestSkipped = false
      for (const f of result.files) {
        if (f.outputHash === null) {
          // manifest.json — compare bytes against the on-disk copy.
          // If identical, skip the write so amp-only-with-no-change
          // saves can report "変更なし". Comparison is cheap (the
          // manifest is small + we already have the proposed bytes).
          if (!kitIdChanged) {
            const onDisk = await readKitFileText(outRoot, kitId, f.path)
            const proposed = await f.blob.text()
            if (onDisk !== null && onDisk === proposed) {
              manifestSkipped = true
              continue
            }
          }
          filesToWrite.push(f)
          continue
        }
        if (kitIdChanged) {
          filesToWrite.push(f)
          continue
        }
        if (prevOutputHash[f.path] !== f.outputHash) {
          filesToWrite.push(f)
          continue
        }
        const exists = await kitFileExists(outRoot, kitId, f.path)
        if (!exists) {
          filesToWrite.push(f)
          continue
        }
        skippedCount++
      }
      if (skippedCount > 0) {
        console.info(
          `[kit] flush "${kit.name}": ${skippedCount} WAV(s) unchanged, skipped write`,
        )
      }
      await writeKitFolder(outRoot, kitId, filesToWrite)

      // Update the on-disk cache file with the CURRENT output hashes.
      // This happens every flush — even when no WAVs were written —
      // so the cache always reflects the actual state on disk (manifest
      // may have just been refreshed, or a v1 cache may have been
      // present and been ignored). Failure is non-fatal.
      const newCache: KitDiskCache = {
        schemaVersion: 2,
        wavs: {},
        writtenAt: new Date().toISOString(),
        writtenByKitName: kit.name,
      }
      for (const f of result.files) {
        if (f.outputHash !== null) newCache.wavs[f.path] = f.outputHash
      }
      await saveKitDiskCache(outRoot, kitId, newCache)

      // One-shot migration: the manifest is now `<kitId>-manifest.json`
      // (kitExporter writes it under that name from 2026-05-17). If a
      // legacy `manifest.json` is still sitting in this kit folder
      // (e.g. the kit was first exported under the old name), drop it
      // now so SDK / Helper discovery doesn't have to pick between two
      // copies. No backwards compat — pre-release project.
      try {
        const kitDirForClean = await outRoot.getDirectoryHandle(kitId, { create: false })
        const newName = manifestFileName(kitId)
        if (newName !== 'manifest.json') {
          try { await kitDirForClean.removeEntry('manifest.json') } catch { /* no legacy file */ }
        }
      } catch { /* kit dir vanished */ }

      // Prune stale WAVs in install-clips/ and stream-clips/. Kept
      // narrow by intent: we only delete files whose basename doesn't
      // match ANY current event of this kit — i.e. true orphans from
      // a rename or a removed event. Files that match a current event
      // but live in the "wrong" subfolder (e.g. left over after a
      // FIRE → CLIP mode toggle) are LEFT IN PLACE. That stops the
      // file churn the user would otherwise see whenever they flip a
      // mode pill: the WAV stays put even when the manifest no longer
      // references it.
      //
      // Trade-off (intentional): a mode toggle that's been bounced
      // both ways will leave the WAV in both subfolders, ~doubling
      // disk for that event. The device firmware still only plays
      // what the manifest says, so the extra file just sits unused
      // on LittleFS until the next clean kit re-export.
      const ownedBasenames = new Set<string>()
      for (const ev of kit.events) {
        const candidate = (ev.clipName || ev.clipSourceFilename || '').trim()
        if (!candidate) continue
        const stem = candidate.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '_')
        if (stem) ownedBasenames.add(`${stem}.wav`)
      }
      try {
        const kitDir = await outRoot.getDirectoryHandle(kitId)
        for (const subName of ['install-clips', 'stream-clips'] as const) {
          let sub: FileSystemDirectoryHandle
          try {
            sub = await kitDir.getDirectoryHandle(subName)
          } catch { continue /* sub-folder doesn't exist */ }
          const stale: string[] = []
          for await (const entry of sub.values()) {
            if (entry.kind !== 'file') continue
            if (!ownedBasenames.has(entry.name)) stale.push(entry.name)
          }
          for (const n of stale) {
            try { await sub.removeEntry(n) } catch { /* ignore */ }
          }
        }
      } catch { /* kit dir vanished — caller will see no folder */ }

      lastWrittenKitId.set(kit.id, kitId)
      lastBuiltKit.set(kit.id, { files: result.files, kitId })

      // Success: reset retry bookkeeping for this kit.
      retryAttempts.delete(kit.id)
      const pendingRetry = retryTimers.get(kit.id)
      if (pendingRetry !== undefined) {
        window.clearTimeout(pendingRetry)
        retryTimers.delete(kit.id)
      }
      lastOpMessage.delete(kit.id)

      // Only surface a "saved" pill when there's an actual operation
      // to report. Silent flushes (Deploy build) shouldn't broadcast.
      // Append a per-flush summary so the user sees *what* changed:
      // "WAV 3 件更新 / 12 件 skip" beats a generic "保存しました".
      // Also push the same summary to the bottom log drawer so the
      // user has a scrollable history of save outcomes.
      const wavsWritten = filesToWrite.filter((f) => f.outputHash !== null).length
      const wavsSkipped = skippedCount
      const summary = (() => {
        if (wavsWritten === 0 && wavsSkipped === 0 && manifestSkipped) {
          // Truly identical to what's on disk.
          return '変更なし'
        }
        if (wavsWritten === 0 && wavsSkipped === 0) {
          // Kit with no events — manifest landed but no audio at all.
          return '設定のみ保存 (events 0 件)'
        }
        if (wavsWritten === 0 && manifestSkipped) {
          // Edge case: all WAVs skipped AND manifest identical. Treat
          // as no-op (manifest write was avoided too).
          return `変更なし (WAV ${wavsSkipped} 件 skip)`
        }
        if (wavsWritten === 0) {
          // Manifest changed (amp / wiper / loop / target_device 等)
          // — all WAVs were bit-exact to disk.
          return `設定のみ更新 (WAV ${wavsSkipped} 件は skip)`
        }
        if (wavsSkipped === 0) {
          return `WAV ${wavsWritten} 件書き込み`
        }
        return `WAV ${wavsWritten} 件更新 / ${wavsSkipped} 件 skip`
      })()
      if (opMsg) {
        state.setLocalFsStatus('saved', `${opMsg}: ${summary}`)
      }
      // Mirror the save outcome into the bottom log drawer. Use a
      // stable `source` so users can filter / spot it among device
      // chatter. We push for both explicit (opMsg present) and
      // silent flushes — the log is meant to be a scrollable history
      // even when the pill doesn't surface anything.
      try {
        useLogStore.getState().push('kit', `${kit.name}: ${summary}`)
      } catch { /* logStore unavailable shouldn't break the flush */ }
      return { files: result.files, kitId }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('flushKitFolderNow failed:', err)

      // Auto-retry with exponential backoff. Most failures are
      // transient FS-API races (`InvalidStateError`) that resolve on
      // the next attempt. A fresh user action via scheduleKitFlush
      // resets the counter independently — see scheduleKitFlush.
      const attempt = (retryAttempts.get(kit.id) ?? 0) + 1
      retryAttempts.set(kit.id, attempt)
      // Build a label even when the caller didn't seed an op message
      // — failures must never be silent.
      const label = opMsg ?? `kit "${kit.name}" の自動保存`
      if (attempt <= RETRY_MAX_ATTEMPTS) {
        // Soft state: warning, not error. The retry mechanism will
        // recover on its own — the user doesn't have to do anything.
        state.setLocalFsStatus(
          'retrying',
          `${label}（リトライ中... ${attempt}/${RETRY_MAX_ATTEMPTS}）`,
        )
        const existingTimer = retryTimers.get(kit.id)
        if (existingTimer !== undefined) window.clearTimeout(existingTimer)
        const delay = retryDelayMs(attempt)
        const t = window.setTimeout(() => {
          retryTimers.delete(kit.id)
          void get().flushKitFolderNow(kit.id)
        }, delay)
        retryTimers.set(kit.id, t)
      } else {
        // Retry budget exhausted — this is a real failure that needs
        // user intervention. Surface what was being attempted plus
        // a hint at the most common recovery (re-pick the folder).
        state.setLocalFsStatus(
          'error',
          `「${label}」が失敗しました (${msg}) — Library / Kit Folder を選び直して再試行してください`,
        )
      }
      return null
    }
    } // end doFlush

    const prev = kitFlushChain.get(kitId) ?? Promise.resolve()
    const next = prev.catch(() => null).then(() => doFlush())
    kitFlushChain.set(kitId, next)
    try {
      return await next
    } finally {
      // Clear only if still the latest in chain — otherwise leave it
      // so the next pending flush waits on its predecessor.
      if (kitFlushChain.get(kitId) === next) kitFlushChain.delete(kitId)
    }
  },

  requestKitFolderSave: async (kitId, opMsg) => {
    // Seed the module-private op message so `flushKitFolderNow` knows
    // to surface a "saved" pill on success (silent on background
    // Deploy builds). Also flips the pill to `saving` immediately so
    // the user gets feedback even before flush completes.
    const kit = get().kits.find((k) => k.id === kitId)
    if (!kit) return null
    setOp(kit.id, opMsg)
    return get().flushKitFolderNow(kitId)
  },

  scheduleKitFlush: (kitId, delayMs = 400) => {
    // Note: we deliberately do NOT touch retry timers / counters
    // here. If a retry was pending, letting it fire on its original
    // schedule lets disk catch up *sooner* than the new debounce
    // window. The chain mutex inside flushKitFolderNow always reads
    // the latest store state, so the retry writes whatever the user
    // just typed (no stale data).
    const existing = kitFlushTimers.get(kitId)
    if (existing) window.clearTimeout(existing)
    if (delayMs <= 0) {
      // Run on next microtask without awaiting — caller doesn't block.
      kitFlushTimers.delete(kitId)
      void get().flushKitFolderNow(kitId)
      return
    }
    const handle = window.setTimeout(() => {
      kitFlushTimers.delete(kitId)
      void get().flushKitFolderNow(kitId)
    }, delayMs)
    kitFlushTimers.set(kitId, handle)
  },

  cancelKitFlush: (kitId) => {
    const existing = kitFlushTimers.get(kitId)
    if (existing) {
      window.clearTimeout(existing)
      kitFlushTimers.delete(kitId)
    }
    const pendingRetry = retryTimers.get(kitId)
    if (pendingRetry !== undefined) {
      window.clearTimeout(pendingRetry)
      retryTimers.delete(kitId)
    }
    retryAttempts.delete(kitId)
  },

  getLastBuiltKit: (kitId) => lastBuiltKit.get(kitId),

  loadLibrary: async () => {
    set({ isLoading: true })
    try {
      // Try to restore work directory first
      const restored = await get().restoreWorkDir()
      // Kit output dir is optional and independent — restore silently
      await get().restoreKitDir().catch(() => { /* ignore permission loss */ })

      if (restored) {
        // Load from local directory
        await get().syncClipsFromDir()
      } else {
        // No workdir picked → don't try to hydrate `kits` from
        // anywhere browser-local. Disk is the source of truth for
        // kits (workdir's `kits-meta.json` + per-kit `manifest.json`).
        // The IDB `kits` store is a legacy leftover (sticky from a
        // pre-fix bug) — reading it would surface phantom rows.
        //
        // The Devices → Kit panel used to need libraryStore.kits to
        // resolve `intensity` per event; that responsibility now
        // lives on the device firmware itself (`cmdKitList` includes
        // `parameters.intensity` in each event object), so the UI
        // works without a local kit hydration step. See
        // `instructions/instructions-kit-list-include-intensity-…`
        // in hapbeat-device-firmware for the firmware change spec.
        //
        // Library `clips` are still loaded from IDB here — same
        // pre-workdir story (drop a clip, it lives in IDB until you
        // pick a folder).
        const clips = await listClips()
        set({ clips, kits: [] })
      }
      // Load the built-in index so subsequent auto-import can consult it.
      await get().loadBuiltinIndex()
      // Fill any missing built-ins (first run after upgrade, or user removed
      // template/ but wants the default library back).
      const { builtinIndex, clips } = get()
      if (builtinIndex && builtinIndex.length > 0) {
        const have = new Set(clips.map((c) => c.builtinId).filter((x): x is string => !!x))
        const missing = builtinIndex.some((b) => !have.has(b.id))
        if (missing) await get().importAllBuiltinClips()
      }
      set({ isLoading: false })
    } catch (err) {
      console.error('ライブラリの読み込みに失敗:', err)
      set({ isLoading: false })
    }
  },

  loadBuiltinIndex: async () => {
    set({ builtinLoading: true })
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}library/index.json`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data: BuiltinLibraryIndex = await res.json()
      set({ builtinIndex: data.clips, builtinLoading: false })
    } catch (err) {
      console.error('ビルトインライブラリの読み込みに失敗:', err)
      set({ builtinIndex: [], builtinLoading: false })
    }
  },

  fetchBuiltinClipAudio: async (builtinId: string) => {
    const { builtinIndex, builtinAudioCache } = get()
    // Check cache first
    const cached = builtinAudioCache.get(builtinId)
    if (cached) return cached

    const meta = builtinIndex?.find((c) => c.id === builtinId)
    if (!meta) return undefined

    try {
      const res = await fetch(`${import.meta.env.BASE_URL}library/clips/${meta.filename}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const blob = await res.blob()
      // Cache it
      set((state) => {
        const newCache = new Map(state.builtinAudioCache)
        newCache.set(builtinId, blob)
        return { builtinAudioCache: newCache }
      })
      return blob
    } catch (err) {
      console.error(`ビルトインクリップの取得に失敗: ${builtinId}`, err)
      return undefined
    }
  },

  importBuiltinToLocal: async (builtinId: string) => {
    const { builtinIndex, clips, fetchBuiltinClipAudio } = get()
    const meta = builtinIndex?.find((c) => c.id === builtinId)
    if (!meta) return undefined

    // Check if already imported
    const existing = clips.find((c) => c.builtinId === builtinId)
    if (existing) return existing.id

    get().setLocalFsStatus('saving', `built-in "${meta.name}" を import 中…`)
    const blob = await fetchBuiltinClipAudio(builtinId)
    if (!blob) {
      get().setLocalFsStatus('error', `built-in "${meta.name}" の audio 取得失敗`)
      return undefined
    }

    const now = new Date().toISOString()
    const clip: LibraryClip = {
      id: generateId(),
      name: meta.name,
      // Preserve the source filename in `note` (same rule as
      // `addClipFromFile`) so user-side rename doesn't lose the
      // waveform-descriptive label.
      note: meta.filename,
      tags: [...meta.tags],
      group: meta.category,
      duration: meta.duration_ms / 1000,
      channels: meta.channels,
      sampleRate: meta.sample_rate,
      fileSize: meta.filesize_bytes,
      sourceFilename: meta.filename,
      createdAt: now,
      updatedAt: now,
      builtinId,
    }
    await saveClip(clip, blob)
    const newClips = [clip, ...get().clips]
    set({ clips: newClips })
    // Mirror to work directory
    const { workDirHandle: wdh } = get()
    if (wdh) {
      await writeClipFile(wdh, meta.filename, blob)
      await saveClipsMetaToDir(wdh, newClips)
    }
    get().setLocalFsStatus('saved', `built-in "${meta.name}" を追加`)
    return clip.id
  },

  importAllBuiltinClips: async () => {
    // Make sure we have the index (lazy-load if not yet fetched).
    if (get().builtinIndex === null) await get().loadBuiltinIndex()
    const { builtinIndex, fetchBuiltinClipAudio, workDirHandle } = get()
    if (!builtinIndex || builtinIndex.length === 0) return 0

    get().setLocalFsStatus('saving', `built-in library を import 中 (${builtinIndex.length} 件)…`)
    const now = new Date().toISOString()
    const toAdd: LibraryClip[] = []
    const existingBuiltinIds = new Set(
      get().clips.map((c) => c.builtinId).filter((x): x is string => !!x)
    )

    let failed = 0
    for (const meta of builtinIndex) {
      if (existingBuiltinIds.has(meta.id)) continue
      const blob = await fetchBuiltinClipAudio(meta.id)
      if (!blob) { failed++; continue }
      // Built-ins land in clips/template/<filename>. The user can freely
      // move them out, edit them or delete them — nothing else depends on
      // the subfolder location, it's purely for organisation.
      const relPath = `template/${meta.filename}`
      const clip: LibraryClip = {
        id: generateId(),
        name: meta.name,
        // Preserve the source filename in `note` for later reference
        // (see `addClipFromFile` comment) — survives any user rename.
        note: meta.filename,
        tags: [...meta.tags],
        group: meta.category || 'template',
        duration: meta.duration_ms / 1000,
        channels: meta.channels,
        sampleRate: meta.sample_rate,
        fileSize: meta.filesize_bytes,
        sourceFilename: relPath,
        createdAt: now,
        updatedAt: now,
        builtinId: meta.id,
      }
      await saveClip(clip, blob)
      if (workDirHandle) await writeClipFile(workDirHandle, relPath, blob)
      toAdd.push(clip)
    }

    if (toAdd.length === 0) {
      // Nothing imported — could be "all already present" or "all failed".
      if (failed > 0) get().setLocalFsStatus('error', `built-in import 失敗: ${failed} 件取得不可`)
      else get().setLocalFsStatus('saved', 'built-in は全て import 済み')
      return 0
    }
    const newClips = [...toAdd, ...get().clips]
    set({ clips: newClips })
    if (workDirHandle) await saveClipsMetaToDir(workDirHandle, newClips)
    const tailMsg = failed > 0 ? ` (${failed} 件取得失敗)` : ''
    get().setLocalFsStatus('saved', `built-in ${toAdd.length} 件を追加${tailMsg}`)
    return toAdd.length
  },

  // ---- Work directory actions ----

  pickWorkDir: async () => {
    if (!isFileSystemAccessSupported()) return false
    const handle = await pickWorkDirectory()
    if (!handle) return false
    set({ workDirHandle: handle, workDirName: handle.name })

    // One-shot rename of the pre-tilde archive folders before any
    // scan/listing runs — keeps the workdir tidy and avoids two
    // co-existing archive directories.
    try { await migrateLegacyArchiveFolders(handle) }
    catch (err) { console.warn('[pickWorkDir] archive migration failed:', err) }

    // If the new directory already has clips, just adopt them.
    // Otherwise auto-seed it with the full built-in library so the user
    // can edit those clips freely from the start.
    const existingFiles = await listClipFiles(handle)
    if (existingFiles.length > 0) {
      await get().syncClipsFromDir()
    } else {
      await get().syncClipsToDir()
      if (get().clips.length === 0) {
        await get().importAllBuiltinClips()
      }
    }
    await get().loadAmpPresets()
    return true
  },

  restoreWorkDir: async () => {
    if (!isFileSystemAccessSupported()) return false
    const handle = await loadDirectoryHandle()
    if (!handle) return false
    const granted = await verifyPermission(handle, true)
    if (!granted) return false
    set({ workDirHandle: handle, workDirName: handle.name })
    // Run the legacy → tilde-suffixed rename before syncClipsFromDir
    // / importKitsFromOutputDir kick in; they read the new folder
    // names directly and would otherwise expose stale legacy state.
    try { await migrateLegacyArchiveFolders(handle) }
    catch (err) { console.warn('[restoreWorkDir] archive migration failed:', err) }
    await get().loadAmpPresets()
    return true
  },

  disconnectWorkDir: async () => {
    await clearDirectoryHandle()
    set({ workDirHandle: null, workDirName: null, ampPresets: [] })
  },

  pickKitDir: async () => {
    if (!isFileSystemAccessSupported()) return false
    const handle = await pickWorkDirectory('kitdir')
    if (!handle) return false
    // Switching the kit folder = changing the source of truth for
    // kits. Drop the in-memory kit list and all per-kit bookkeeping
    // BEFORE pointing outRoot at the new folder, so:
    //   1) The new folder's contents are loaded as-is (no merge with
    //      the previous folder's kits).
    //   2) No leftover scheduleKitFlush / retry timer fires against
    //      the new folder and copies a previous-folder kit into it.
    // Disk on either side is untouched: we just re-orient Studio.
    resetKitMemory()
    set({ kits: [], activeKitId: null, kitDirHandle: handle, kitDirName: handle.name })
    // Discover kits already living under the newly chosen folder.
    await get().importKitsFromOutputDir().catch((err) => console.error('Auto-import after pickKitDir failed:', err))
    return true
  },

  restoreKitDir: async () => {
    if (!isFileSystemAccessSupported()) return false
    const handle = await loadDirectoryHandle('kitdir')
    if (!handle) return false
    const granted = await verifyPermission(handle, true)
    if (!granted) return false
    set({ kitDirHandle: handle, kitDirName: handle.name })
    // 起動時の復元でも同様に自動取り込み (ローカル ≥ IDB)
    await get().importKitsFromOutputDir().catch((err) => console.error('Auto-import after restoreKitDir failed:', err))
    return true
  },

  disconnectKitDir: async () => {
    await clearDirectoryHandle('kitdir')
    // Same reasoning as pickKitDir — drop kits keyed to the folder
    // we just disconnected. Then fall back to scanning the library
    // workdir if one is configured (kits live there by default when
    // no dedicated kitDir is set).
    resetKitMemory()
    set({ kits: [], activeKitId: null, kitDirHandle: null, kitDirName: null })
    if (get().workDirHandle) {
      await get().importKitsFromOutputDir().catch((err) => console.error('Re-scan after disconnectKitDir failed:', err))
    }
  },

  importKitsFromOutputDir: async () => {
    // Kits live under either a dedicated kit folder (kitDirHandle —
    // e.g. Unity's Assets/HapbeatKits) or, if that's unset, directly
    // under the library workdir. Match the same outRoot that
    // KitExportSection uses when writing kits, so what gets read back
    // matches what was written.
    const { kitDirHandle, workDirHandle } = get()
    const outRoot = kitDirHandle ?? workDirHandle
    if (!outRoot) return 0

    const discovered = await scanKitOutputFolder(outRoot)
    // Diagnostic — surfaces in DevTools so users can tell *why* a kit
    // disappeared (folder missing / manifest filename mismatch / parse
    // failure). Skip when discovered is non-empty AND every kit has a
    // valid manifest, to keep the console quiet on the happy path.
    if (discovered.length === 0) {
      console.warn(
        '[libraryStore] importKitsFromOutputDir: no kit folders found in',
        outRoot.name,
        '— directories present must contain either `<folder>-manifest.json`',
        'or any `*manifest*.json` file to be picked up.',
      )
      return 0
    }
    const malformed = discovered.filter((d) => !d.manifestJson || typeof d.manifestJson !== 'object')
    if (malformed.length > 0) {
      console.warn(
        '[libraryStore] importKitsFromOutputDir: ignoring',
        malformed.length,
        'kit folder(s) with unreadable manifest:',
        malformed.map((d) => d.folderName),
      )
    }

    const ctx = new AudioContext()
    const now = new Date().toISOString()
    const updatedClips = [...get().clips]
    // We need the existing kits for ev.id / audio preservation matching
    // below. At init time, restoreKitDir runs us BEFORE loadLibrary has
    // populated zustand state, so `get().kits` may be empty even though
    // the user has kits from a previous session.
    //
    // Source of truth (priority order):
    //   1. zustand state — if already populated by an earlier call
    //   2. workdir's `kits-meta.json` — disk-side persisted kit list,
    //      written on every save. Preserves ev.id across browsers / reloads
    //      / data clears. This is the new primary path; it removes the
    //      need to write kits into the IDB `kits` store at all.
    //   3. IDB `listKits()` + dedupe — legacy fallback for first-time
    //      load after the disk-only refactor. Cleans up duplicates
    //      accumulated by an earlier bug (saveKit called with fresh
    //      generateId on every reload → hundreds of stale rows seen in
    //      the wild). After one successful disk save, kits-meta.json
    //      covers everything and this branch never runs again.
    let updatedKits = [...get().kits]
    if (updatedKits.length === 0 && workDirHandle) {
      try {
        const savedKits = await readMetadataJson<KitDefinition[]>(
          workDirHandle, KITS_META_FILE,
        )
        if (savedKits && savedKits.length > 0) {
          updatedKits = savedKits.map((k) => migrateKit(k, updatedClips))
        }
      } catch (err) {
        console.warn('[importKitsFromOutputDir] kits-meta.json read failed:', err)
      }
    }
    if (updatedKits.length === 0) {
      try {
        const idbKits = await listKits()
        if (idbKits.length > 0) {
          // Group by name. Within each group, sort by updatedAt desc
          // (fallback createdAt) and keep the first. The rest are
          // deleted from IDB so they don't reappear next time.
          const byName = new Map<string, KitDefinition[]>()
          for (const k of idbKits) {
            const arr = byName.get(k.name)
            if (arr) arr.push(k)
            else byName.set(k.name, [k])
          }
          const survivors: KitDefinition[] = []
          let dropped = 0
          for (const group of byName.values()) {
            group.sort((a, b) => {
              const ta = a.updatedAt || a.createdAt || ''
              const tb = b.updatedAt || b.createdAt || ''
              return tb.localeCompare(ta)
            })
            survivors.push(group[0])
            for (const stale of group.slice(1)) {
              try { await deleteKit(stale.id) } catch { /* ignore */ }
              dropped++
            }
          }
          if (dropped > 0) {
            console.info(
              `[importKitsFromOutputDir] removed ${dropped} duplicate IDB kit row(s)`,
              `(survivors: ${survivors.map((k) => k.name).join(', ')})`,
            )
          }
          updatedKits = survivors.map((k) => migrateKit(k, updatedClips))
        }
      } catch (err) {
        console.warn('[importKitsFromOutputDir] legacy IDB preload failed:', err)
      }
    }

    // NOTE — `ensureClip` (library auto-import from kit folder) was
    // intentionally removed. The library and kits are independent now:
    //
    //   - Adding library → kit = copy (kit owns its own snapshot + blob)
    //   - Archive / rename library = no effect on kits
    //   - Kit scan = no effect on library
    //
    // The previous implementation re-imported any kit WAV that didn't
    // basename-match a current library entry, then **wrote it back to
    // clips/ on disk**. That fought the user's library curation in two
    // ways: archived clips resurrected themselves on the next reload
    // (kit folder still had the WAV → import re-created it), and a
    // library rename produced a phantom duplicate (kit had the old
    // name, basename match failed, library got a new clip + new file).
    //
    // Kit-event audio is still saved (`saveKitEventAudio(eventId, blob)`
    // below), so previews / exports / deploys keep working without
    // touching the library at all.

    let importedCount = 0
    for (const { folderName, manifestJson, clipFiles } of discovered as DiscoveredKit[]) {
      if (!manifestJson || typeof manifestJson !== 'object') continue
      // `name` is the only kit identifier in modern manifests; older
      // exports also carried `kit_id` which we now ignore (it always
      // equalled `name` anyway).
      const m = manifestJson as {
        schema_version?: string
        name?: string; version?: string; description?: string
        created_at?: string
        // schema 1.x: `events` は command / stream / source 混在 (mode field で区別)
        // schema 2.0.0 (DEC-031): `events` を command 専用に narrow + `stream_events` を新設
        events?: Record<string, unknown>
        stream_events?: Record<string, unknown>
        target_device?: {
          firmware_version_min?: string
          firmware_version_max?: string
          board?: string
          volume_level?: number
          volume_wiper?: number
          volume_steps?: number
        }
      }
      // The on-disk folder name is the truth for the kit identifier.
      // What the user sees in OS Explorer must match what they see in
      // Studio. manifest.name (or any legacy kit_id) is ignored — if
      // the user renames the folder externally, Studio follows.
      const kitId = folderName.trim()
      if (!kitId) continue

      // ---- Parse + group manifest entries into KitEvents -----------------
      //
      // schema 2.0.0 (DEC-031): `events` (command-only) + `stream_events` 2 buckets.
      //   Mode is derived from the bucket; clip subdir is derived from the bucket.
      //   Same eventId in both buckets = BOTH mode authored — merged into a
      //   single KitEvent with `modes: ['command', 'stream_clip']`.
      //
      //   注: `events` という名前は schema 1.x からの継承 (command-mode 専用に
      //   narrow 化されただけで rename していない)。device firmware の
      //   kit_loader が既に `doc["events"]` を読んでいるため、bucket 名を
      //   保つことで firmware 無変更で済む (DEC-031 Option C)。
      //
      // schema 1.x (legacy): 同じく `events` だが command / stream / source が
      //   混在し、各 entry の `mode` field で区別。Multi-mode events は
      //   `<eventId>.fire` / `<eventId>.clip` で JSON-key dedup されていた。
      //   検出は schema_version (>= "2.") または「stream_events フィールドが
      //   存在する」or「いずれの events entry にも mode field / suffix が
      //   無い」で行う。検出後、suffix を strip + mode を suffix から復元する。
      type RawEv = {
        eventId: string       // base eventId (suffix already stripped if legacy)
        mode: KitEventMode    // 'command' or 'stream_clip' (bucket-derived for v2 / suffix-derived for legacy)
        clipFilename: string  // basename only — on-disk filename inside install-clips/ or stream-clips/
        clipName: string      // display-friendly name derived from filename
        clipDuration: number
        clipChannels: number
        clipSampleRate: number
        clipFileSize: number
        clipBlob?: Blob       // raw bytes for kit-event audio store
        intensity: number
        loop: boolean
        deviceWiper: number | null
      }

      const raws: RawEv[] = []

      const decodeAndPushRaw = async (
        eventId: string,
        mode: KitEventMode,
        rawEv: unknown,
        subdir: 'install-clips' | 'stream-clips',
      ) => {
        if (!rawEv || typeof rawEv !== 'object') return
        const ev = rawEv as { clip?: string; parameters?: Record<string, unknown> }
        let clipFile: File | undefined
        let clipFilename = ''
        if (ev.clip) {
          // schema 2.0.0: bare filename. Legacy v1.x stream entries may carry
          // a `stream-clips/foo.wav` prefixed path — both forms resolve here.
          const relKey = ev.clip.includes('/') ? ev.clip : `${subdir}/${ev.clip}`
          clipFile = clipFiles.get(relKey) ?? clipFiles.get(ev.clip)
          clipFilename = (ev.clip.split('/').pop() || ev.clip)
        }

        let clipDuration = 0, clipChannels = 1, clipSampleRate = 16000, clipFileSize = 0
        let clipBlob: Blob | undefined
        if (clipFile) {
          try {
            const arrayBuffer = await clipFile.arrayBuffer()
            const decoded = await ctx.decodeAudioData(arrayBuffer.slice(0))
            clipDuration = decoded.duration
            clipChannels = decoded.numberOfChannels
            clipSampleRate = decoded.sampleRate
            clipFileSize = clipFile.size
            clipBlob = new Blob([arrayBuffer], { type: clipFile.type || 'audio/wav' })
          } catch (err) {
            console.warn(`[importKitsFromOutputDir] decode failed for ${clipFilename}:`, err)
          }
        }

        const params = (ev.parameters ?? {}) as { intensity?: number; loop?: boolean; device_wiper?: number }
        const clipName = clipFilename.replace(/\.wav$/i, '') || eventId

        raws.push({
          eventId,
          mode,
          clipFilename,
          clipName,
          clipDuration,
          clipChannels,
          clipSampleRate,
          clipFileSize,
          clipBlob,
          intensity: typeof params.intensity === 'number' ? params.intensity : 0.5,
          loop: params.loop ?? false,
          deviceWiper: typeof params.device_wiper === 'number' ? params.device_wiper : null,
        })
      }

      // v2 検出 — 以下のいずれかで「これは schema 2.0.0 manifest」と判定:
      //   (a) schema_version が "2." で始まる (明示宣言)
      //   (b) stream_events フィールドが存在する (legacy v1.x には無い field)
      //   (c) (a)/(b) いずれも無いが、events 内のどの entry にも mode field /
      //       .fire/.clip/.source suffix が無い → 暗黙的に command-only と解釈
      //
      // v1.x (legacy) は events に command/stream_clip/source が混在し、
      // 各 entry に mode field または .fire/.clip suffix が付く。
      const eventsObj = m.events ?? {}
      const hasV2Marker = (m.schema_version?.startsWith('2.') ?? false)
        || (m.stream_events !== undefined)
      const hasLegacyMarker = Object.entries(eventsObj).some(([k, v]) => {
        if (k.endsWith('.fire') || k.endsWith('.clip') || k.endsWith('.source')) return true
        const ev = v as { mode?: string } | null
        return !!(ev && typeof ev === 'object' && typeof ev.mode === 'string')
      })
      const isV2 = hasV2Marker || !hasLegacyMarker

      if (isV2) {
        // schema 2.0.0 path — `events` は command 専用、`stream_events` は stream 専用。
        for (const [eventId, rawEv] of Object.entries(eventsObj)) {
          await decodeAndPushRaw(eventId, 'command', rawEv, 'install-clips')
        }
        for (const [eventId, rawEv] of Object.entries(m.stream_events ?? {})) {
          await decodeAndPushRaw(eventId, 'stream_clip', rawEv, 'stream-clips')
        }
      } else {
        // Legacy v1.x path — single `events` dict with mode field + optional
        // `.fire` / `.clip` suffix for multi-mode. Strip suffix to recover the
        // base eventId; mode comes from explicit field or from suffix.
        const stripLegacySuffix = (key: string): { base: string; mode: KitEventMode | null } => {
          if (key.endsWith('.fire')) return { base: key.slice(0, -5), mode: 'command' }
          if (key.endsWith('.clip')) return { base: key.slice(0, -5), mode: 'stream_clip' }
          // 旧 .source は schema 2.0.0 で廃止 — base のみ取り出して command 扱い
          if (key.endsWith('.source')) return { base: key.slice(0, -7), mode: 'command' }
          return { base: key, mode: null }
        }
        for (const [manifestKey, rawEv] of Object.entries(eventsObj)) {
          if (!rawEv || typeof rawEv !== 'object') continue
          const evObj = rawEv as { mode?: string }
          const explicitMode = evObj.mode as string | undefined
          const { base, mode: suffixMode } = stripLegacySuffix(manifestKey)
          // 旧 stream_source は schema 2.0.0 で廃止 → command 扱いに正規化
          const normalized: KitEventMode =
            explicitMode === 'stream_clip' ? 'stream_clip' :
            explicitMode === 'command' ? 'command' :
            suffixMode ?? 'command'
          const subdir: 'install-clips' | 'stream-clips' =
            normalized === 'command' ? 'install-clips' : 'stream-clips'
          await decodeAndPushRaw(base, normalized, rawEv, subdir)
        }
      }

      // Bucket by eventId — same eventId in `events` (command) + stream_events
      // (or `.fire`/`.clip` siblings in legacy v1.x) merge into one KitEvent.
      const buckets = new Map<string, RawEv[]>()
      for (const r of raws) {
        const arr = buckets.get(r.eventId)
        if (arr) arr.push(r)
        else buckets.set(r.eventId, [r])
      }

      const events: KitEvent[] = []
      // Queue of (eventId, blob) pairs to write into STORE_AUDIO once
      // the kit list is committed to state. Defer writes until after
      // the loop so a mid-loop failure doesn't leave half-saved blobs.
      const eventAudioToSave: Array<{ eventId: string; blob: Blob }> = []

      // ---- Match-and-preserve against existing IDB kit ----
      //
      // If the user already has a kit in IDB with this kitId, we want
      // to **preserve the existing ev.id** for any event whose wire
      // `eventId` is the same — and crucially, **keep the existing
      // audio blob in IDB** rather than overwriting it with whatever
      // is currently on disk.
      //
      // Why this matters: on the FIRST Save Folder the source audio
      // is the user's original drop (e.g. 44.1 kHz stereo). We encode
      // it to 16 kHz PCM16 and write that to disk. If we later
      // **re-import** from disk (after a hard reload / folder
      // re-pick), the disk WAV — being already 16 kHz PCM16 — becomes
      // the new "source" if we let it overwrite IDB. That changes
      // sourceHash, busts the encoded-wavs cache, and produces
      // slightly different bytes on re-encode (float ⇄ int16 round
      // trip costs ~1 ULP per sample). Net effect: every Save Folder
      // after a reload would rewrite every WAV even though nothing
      // user-visible changed.
      //
      // By keeping IDB audio when the matched event already has audio,
      // we keep the ORIGINAL source bytes across reloads. sourceHash
      // stays stable, encoded-wavs cache hits, outputHash stays stable,
      // and the disk skip-write check matches.
      const existingKitForMatch = updatedKits.find((k) => k.name === kitId)
      const existingEventByWireId = new Map<string, KitEvent>()
      if (existingKitForMatch) {
        for (const ev of existingKitForMatch.events) {
          existingEventByWireId.set(ev.eventId, ev)
        }
      }

      for (const [baseEventId, group] of buckets) {
        // Mergeable when both buckets reference the same WAV with identical
        // intensity / loop. device_wiper is only on the command side in
        // schema 2.0.0 so we don't require its equality.
        const mergeable =
          group.length > 1 &&
          group.every((r) =>
            r.clipFilename === group[0].clipFilename &&
            Math.abs(r.intensity - group[0].intensity) < 1e-6 &&
            r.loop === group[0].loop
          )

        // Look up an existing event by wire eventId to potentially
        // preserve its ev.id and audio. If the new modes list disagrees
        // with the existing event (e.g. user toggled FIRE → CLIP outside
        // Studio), we still preserve ev.id; subsequent saves will reflect
        // the new modes via the manifest.
        const existingEv = existingEventByWireId.get(baseEventId)
        const shouldKeepAudio = async (eventId: string): Promise<boolean> => {
          try {
            const blob = await loadKitEventAudio(eventId)
            return !!blob
          } catch { return false }
        }

        if (mergeable) {
          const order: Record<KitEventMode, number> = { command: 0, stream_clip: 1 }
          const modes = group.map((r) => r.mode).sort((a, b) => order[a] - order[b])
          // command 側に device_wiper があれば優先 (stream 側には記録されないため)
          const cmdEntry = group.find((r) => r.mode === 'command')
          const seed = cmdEntry ?? group[0]
          const newId = existingEv?.id ?? generateId()
          events.push({
            id: newId,
            eventId: baseEventId,
            clipName: seed.clipName,
            clipSourceFilename: seed.clipFilename,
            clipDuration: seed.clipDuration,
            clipChannels: seed.clipChannels,
            clipSampleRate: seed.clipSampleRate,
            clipFileSize: seed.clipFileSize,
            modes,
            loop: seed.loop,
            intensity: seed.intensity,
            deviceWiper: seed.deviceWiper,
          })
          // Only import disk audio when IDB doesn't already have one
          // for this ev.id. Preserves the original source bytes.
          if (seed.clipBlob && !(existingEv && await shouldKeepAudio(newId))) {
            eventAudioToSave.push({ eventId: newId, blob: seed.clipBlob })
          }
        } else {
          for (const r of group) {
            const newId = existingEv?.id ?? generateId()
            events.push({
              id: newId,
              eventId: r.eventId,
              clipName: r.clipName,
              clipSourceFilename: r.clipFilename,
              clipDuration: r.clipDuration,
              clipChannels: r.clipChannels,
              clipSampleRate: r.clipSampleRate,
              clipFileSize: r.clipFileSize,
              modes: [r.mode],
              loop: r.loop,
              intensity: r.intensity,
              deviceWiper: r.deviceWiper,
            })
            if (r.clipBlob && !(existingEv && await shouldKeepAudio(newId))) {
              eventAudioToSave.push({ eventId: newId, blob: r.clipBlob })
            }
          }
        }
      }

      // Persist kit-event audio. Failures are non-fatal — the kit
      // folder on disk still has the WAVs so a follow-up scan or
      // manual re-import recovers them.
      for (const { eventId, blob } of eventAudioToSave) {
        try { await saveKitEventAudio(eventId, blob) }
        catch (err) { console.warn('[importKitsFromOutputDir] saveKitEventAudio failed:', err) }
      }

      const existingIdx = updatedKits.findIndex((k) => k.name === kitId)
      // Author tuning context — read every supported field, drop the
      // ones that are absent so we don't leave stale numeric defaults.
      const td = m.target_device ?? {}
      const targetDevice: KitDefinition['targetDevice'] = {}
      if (td.firmware_version_min) targetDevice.firmware_version_min = td.firmware_version_min
      if (td.firmware_version_max) targetDevice.firmware_version_max = td.firmware_version_max
      if (td.board) targetDevice.board = td.board
      if (typeof td.volume_level === 'number') targetDevice.volume_level = td.volume_level
      if (typeof td.volume_wiper === 'number') targetDevice.volume_wiper = td.volume_wiper
      if (typeof td.volume_steps === 'number') targetDevice.volume_steps = td.volume_steps
      const kit: KitDefinition = {
        id: existingIdx >= 0 ? updatedKits[existingIdx].id : generateId(),
        // Folder name = display name. Lossless round-trip with disk.
        name: kitId,
        version: String(m.version ?? '1.0.0'),
        description: String(m.description ?? ''),
        events,
        createdAt: existingIdx >= 0 ? updatedKits[existingIdx].createdAt : (m.created_at ?? now),
        updatedAt: now,
        targetDevice: Object.keys(targetDevice).length > 0 ? targetDevice : undefined,
      }
      if (existingIdx >= 0) updatedKits[existingIdx] = kit
      else updatedKits.push(kit)
      // (Disk-as-truth) Persistence happens via saveKitsMetaToDir at the
      // end of this function — we no longer mirror to the IDB `kits`
      // store. See top of function for rationale.
      // Track the kitId we just imported so a subsequent kit rename
      // archives this folder rather than orphaning it on disk.
      lastWrittenKitId.set(kit.id, kitId)
      importedCount++
    }

    set({ clips: updatedClips, kits: updatedKits })
    if (workDirHandle) {
      await saveClipsMetaToDir(workDirHandle, updatedClips)
      await saveKitsMetaToDir(workDirHandle, updatedKits)
    }
    return importedCount
  },

  syncClipsToDir: async () => {
    const { workDirHandle, clips } = get()
    if (!workDirHandle) return
    // Write metadata
    await saveClipsMetaToDir(workDirHandle, clips)
    // Write each clip's audio file
    for (const clip of clips) {
      const blob = await loadClipAudio(clip.id)
      if (blob) {
        const filename = clip.sourceFilename || `${clip.id}.wav`
        await writeClipFile(workDirHandle, filename, blob)
      }
    }
    // Also save kits metadata
    const { kits } = get()
    await saveKitsMetaToDir(workDirHandle, kits)
  },

  syncClipsFromDir: async () => {
    const { workDirHandle } = get()
    if (!workDirHandle) return

    // Read metadata and kits from dir
    const savedClips = await readMetadataJson<LibraryClip[]>(workDirHandle, CLIPS_META_FILE)
    const savedKits = await readMetadataJson<KitDefinition[]>(workDirHandle, KITS_META_FILE)

    // Scan actual files in clips/
    const fileList = await listClipFiles(workDirHandle)
    const metaMap = new Map((savedClips ?? []).map((c) => [c.sourceFilename, c]))

    const clips: LibraryClip[] = []
    const ctx = new AudioContext()

    // For each file in clips/, use existing metadata or create new
    for (const { name: filename, file } of fileList) {
      const existing = metaMap.get(filename)
      if (existing) {
        // 旧実装の自動生成名だったら新実装で上書き（ユーザが編集した名前は保持）
        if (existing.name === legacyFilenameToDisplayName(existing.sourceFilename)) {
          existing.name = filenameToDisplayName(existing.sourceFilename)
        }
        clips.push(existing)
        // Sync to IndexedDB
        const blob = new Blob([await file.arrayBuffer()], { type: 'audio/wav' })
        await saveClip(existing, blob)
      } else {
        // New file — auto-generate metadata from filename
        try {
          const arrayBuffer = await file.arrayBuffer()
          const buffer = await ctx.decodeAudioData(arrayBuffer.slice(0))
          const now = new Date().toISOString()
          const clip: LibraryClip = {
            id: generateId(),
            name: filenameToDisplayName(filename),
            // Preserve the discovered filename in `note` so a later
            // rename doesn't erase the waveform-descriptive label
            // (matches `addClipFromFile`).
            note: filename.split('/').pop() ?? filename,
            tags: [],
            group: '',
            duration: buffer.duration,
            channels: buffer.numberOfChannels,
            sampleRate: buffer.sampleRate,
            fileSize: file.size,
            sourceFilename: filename,
            createdAt: now,
            updatedAt: now,
          }
          clips.push(clip)
          await saveClip(clip, new Blob([arrayBuffer], { type: 'audio/wav' }))
        } catch (err) {
          console.error(`Failed to import ${filename} from work dir:`, err)
        }
      }
    }

    // Files in clips/ are the source of truth — clips deleted from folder are removed
    set({ clips })
    await saveClipsMetaToDir(workDirHandle, clips)

    // Kits: the real master is each `<kitId>/<kitId>-manifest.json`
    // file on disk, NOT the cached kitsMeta.json. We do a live folder
    // scan so that kits added/edited/removed via OS Explorer (or by
    // another tool) are picked up on next load.
    //
    // `importKitsFromOutputDir` falls back to `workDirHandle` when no
    // dedicated `kitDirHandle` is set, so it covers both layouts:
    //   - workdir/<kitId>/<kitId>-manifest.json   (default — kits inside library)
    //   - kitDir/<kitId>/<kitId>-manifest.json    (dedicated kit-out folder)
    // Discovery falls back to any `*manifest*.json` so kits authored
    // under the legacy `manifest.json` name still load.
    //
    // If the scan finds nothing (brand-new workdir, kits never deployed),
    // fall back to the kits-meta.json snapshot we just read. We do
    // NOT consult the IDB `kits` store any more: it accumulated stale
    // rows from a pre-2026-05-26 bug and is no longer trusted. Disk
    // is the source of truth for kits (workdir's kits-meta.json + each
    // <kitId>/<kitId>-manifest.json). If both the disk scan and the
    // metadata snapshot return empty, the kit list stays empty — the
    // user picks up where they left off when they next deploy / save a kit.
    const importedKitCount = await get().importKitsFromOutputDir().catch((err) => {
      console.warn('Kit folder scan failed, falling back to metadata:', err)
      return 0
    })
    if (importedKitCount === 0 && savedKits) {
      const currentClips = get().clips
      const legacyAudio = collectLegacyClipAudioMap(savedKits)
      const migrated = savedKits.map((k) => migrateKit(k, currentClips))
      // (Disk-as-truth) Don't mirror to IDB. State + saveKitsMetaToDir
      // (already done via syncClipsFromDir) are the persistence.
      set({ kits: migrated })
      if (legacyAudio.size > 0) void migrateKitAudioAsync(legacyAudio)
    }
  },

  refreshClipsFromDir: async () => {
    const { workDirHandle } = get()
    if (!workDirHandle) return

    const fileList = await listClipFiles(workDirHandle)
    const fileNames = new Set(fileList.map((f) => f.name))
    const existingClips = get().clips
    const existingByFile = new Map(existingClips.map((c) => [c.sourceFilename, c]))

    let changed = false
    const updatedClips: LibraryClip[] = []

    // Keep clips whose files still exist
    for (const clip of existingClips) {
      if (fileNames.has(clip.sourceFilename)) {
        updatedClips.push(clip)
        fileNames.delete(clip.sourceFilename) // mark as handled
      } else {
        // File was deleted from folder — remove from list
        changed = true
        try { await deleteClip(clip.id) } catch { /* ignore */ }
      }
    }

    // Add new files that appeared in the folder
    // fileNames now contains only unmatched (new) files
    if (fileNames.size > 0) {
      changed = true
      const ctx = new AudioContext()
      for (const { name: filename, file } of fileList) {
        if (!existingByFile.has(filename) && fileNames.has(filename)) {
          try {
            const arrayBuffer = await file.arrayBuffer()
            const buffer = await ctx.decodeAudioData(arrayBuffer.slice(0))
            const now = new Date().toISOString()
            const clip: LibraryClip = {
              id: generateId(),
              name: filenameToDisplayName(filename),
              // Preserve original filename in note (matches other
              // import paths). See `addClipFromFile`.
              note: filename.split('/').pop() ?? filename,
              tags: [],
              group: '',
              duration: buffer.duration,
              channels: buffer.numberOfChannels,
              sampleRate: buffer.sampleRate,
              fileSize: file.size,
              sourceFilename: filename,
              createdAt: now,
              updatedAt: now,
            }
            updatedClips.push(clip)
            await saveClip(clip, new Blob([arrayBuffer], { type: 'audio/wav' }))
          } catch (err) {
            console.error(`Failed to import ${filename}:`, err)
          }
        }
      }
    }

    if (changed) {
      set({ clips: updatedClips })
      await saveClipsMetaToDir(workDirHandle, updatedClips)
    }
  },

  // ---- Clip actions ----

  addClipFromBuffer: async (buffer, name, sampleRate, sourceFilename) => {
    const blob = await encodeWavBlob(buffer, sampleRate)
    const now = new Date().toISOString()
    const clip: LibraryClip = {
      id: generateId(),
      name,
      tags: [],
      group: '',
      duration: buffer.duration,
      channels: buffer.numberOfChannels,
      sampleRate,
      fileSize: blob.size,
      sourceFilename,
      createdAt: now,
      updatedAt: now,
    }
    await saveClip(clip, blob)
    const newClips = [clip, ...get().clips]
    set({ clips: newClips })
    // Mirror to work directory
    const { workDirHandle } = get()
    if (workDirHandle) {
      await writeClipFile(workDirHandle, sourceFilename, blob)
      await saveClipsMetaToDir(workDirHandle, newClips)
    }
    return clip.id
  },

  addClipFromFile: async (file) => {
    get().setLocalFsStatus('saving', `clip "${file.name}" を import 中…`)
    try {
      const arrayBuffer = await file.arrayBuffer()
      const ctx = new AudioContext()
      const buffer = await ctx.decodeAudioData(arrayBuffer)
      const blob = new Blob([arrayBuffer], { type: file.type || 'audio/wav' })
      const now = new Date().toISOString()
      const clip: LibraryClip = {
        id: generateId(),
        name: filenameToDisplayName(file.name),
        // Seed `note` with the *original* file name so the
        // waveform-descriptive label (e.g. `sin_100hz.wav`) is
        // preserved even after the user renames the clip to an
        // action-style label (e.g. `z1_pin_hit`). The Edit modal's
        // Swap button toggles the two strings; on hover the card
        // tooltip shows whichever string is currently in `note`.
        // Users who don't care can edit / clear it any time.
        note: file.name,
        tags: [],
        group: '',
        duration: buffer.duration,
        channels: buffer.numberOfChannels,
        sampleRate: buffer.sampleRate,
        fileSize: file.size,
        sourceFilename: file.name,
        createdAt: now,
        updatedAt: now,
      }
      await saveClip(clip, blob)
      const newClips = [clip, ...get().clips]
      set({ clips: newClips })
      // Mirror to work directory
      const { workDirHandle } = get()
      if (workDirHandle) {
        await writeClipFile(workDirHandle, file.name, blob)
        await saveClipsMetaToDir(workDirHandle, newClips)
      }
      get().setLocalFsStatus('saved', `clip "${clip.name}" を追加`)
      return clip.id
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      get().setLocalFsStatus('error', `clip "${file.name}" の追加失敗: ${msg}`)
      throw err
    }
  },

  removeClip: async (id) => {
    const { clips, workDirHandle } = get()
    const clip = clips.find((c) => c.id === id)
    const clipLabel = clip?.name || clip?.sourceFilename || id
    get().setLocalFsStatus('saving', `clip "${clipLabel}" を削除中…`)
    await deleteClip(id)
    const newClips = clips.filter((c) => c.id !== id)
    set({ clips: newClips })
    // Remove from work directory
    let diskErr: unknown = null
    if (workDirHandle && clip?.sourceFilename) {
      try { await deleteClipFile(workDirHandle, clip.sourceFilename) }
      catch (err) { diskErr = err }
      await saveClipsMetaToDir(workDirHandle, newClips)
    }
    if (diskErr) {
      const msg = diskErr instanceof Error ? diskErr.message : String(diskErr)
      get().setLocalFsStatus('error', `clip "${clipLabel}" の disk 削除失敗: ${msg}`)
    } else {
      get().setLocalFsStatus('saved', `clip "${clipLabel}" を削除`)
    }
  },

  archiveClip: async (id) => {
    const { clips, workDirHandle } = get()
    const clip = clips.find((c) => c.id === id)
    console.info('[archiveClip] called', {
      id,
      foundClip: !!clip,
      hasWorkDir: !!workDirHandle,
      sourceFilename: clip?.sourceFilename,
    })
    if (!clip) return false
    const clipLabel = clip.name || clip.sourceFilename || id
    get().setLocalFsStatus('saving', `clip "${clipLabel}" を archive 移動中…`)

    // Move the file into clips/_archive/. If there's no work dir, just
    // drop the entry from the list (IndexedDB path) — there's no on-disk
    // file to move in that case.
    let moveErr: unknown = null
    let movedPath: string | null = null
    if (workDirHandle && clip.sourceFilename) {
      try {
        movedPath = await archiveClipFile(workDirHandle, clip.sourceFilename)
        console.info('[archiveClip] archiveClipFile result:', movedPath ?? '(null — source not found?)')
      } catch (err) {
        moveErr = err
        console.error('[archiveClip] archiveClipFile threw:', err)
      }
    } else if (!workDirHandle) {
      console.warn('[archiveClip] skipping disk move — workDirHandle is null')
    } else if (!clip.sourceFilename) {
      console.warn('[archiveClip] skipping disk move — clip.sourceFilename is empty', clip)
    }

    // Drop from the in-memory list and IndexedDB cache. The file lives on
    // in clips/_archive/ — the user can move it back to recover it,
    // which our next dir refresh will pick up as a regular clip again.
    await deleteClip(id)
    const newClips = clips.filter((c) => c.id !== id)
    set({ clips: newClips })
    if (workDirHandle) await saveClipsMetaToDir(workDirHandle, newClips)
    // Surface the result. Status messages distinguish "moved on disk",
    // "list-only drop (no workdir)" and "tried to move but failed" so
    // a user staring at the footer pill can act if needed.
    if (moveErr) {
      const msg = moveErr instanceof Error ? moveErr.message : String(moveErr)
      get().setLocalFsStatus('error', `clip "${clipLabel}" の archive 失敗: ${msg}`)
    } else if (movedPath) {
      // Don't surface the literal `_archive` folder name — it's an
      // internal Studio-managed location the user isn't meant to
      // think about. Just say "archived".
      get().setLocalFsStatus('saved', `clip "${clipLabel}" を archive`)
    } else if (workDirHandle && clip.sourceFilename) {
      // archiveClipFile returned null = source not found on disk
      get().setLocalFsStatus('saved', `clip "${clipLabel}" を list から削除 (disk file 不在)`)
    } else {
      get().setLocalFsStatus('saved', `clip "${clipLabel}" を list から削除`)
    }
    return true
  },

  updateClip: async (id, updates) => {
    get().setLocalFsStatus('saving', 'clip metadata 更新中…')
    await updateClipMeta(id, updates)
    const prev = get().clips.find((c) => c.id === id)
    const newClips = get().clips.map((c) =>
      c.id === id ? { ...c, ...updates, updatedAt: new Date().toISOString() } : c
    )
    set({ clips: newClips })

    // Kit events used to mirror clip renames here (cascade-update eventId
    // when the library clip's name changed). That coupling was removed
    // when KitEvent became an independent snapshot owner (clipName lives
    // on the event itself). Library renames now stay in the library —
    // kits keep whatever name they were authored with. Rename a kit
    // event by editing the card name inside the kit instead.
    const nameChanged =
      updates.name !== undefined && prev !== undefined && updates.name !== prev.name
    void nameChanged

    // Update metadata in work directory
    const { workDirHandle } = get()
    if (workDirHandle) {
      await saveClipsMetaToDir(workDirHandle, newClips)
    }
    get().setLocalFsStatus('saved', `clip "${updates.name ?? prev?.name ?? ''}" を保存`)
  },

  commitClipRename: async (id) => {
    const { workDirHandle, clips } = get()
    if (!workDirHandle) return
    const clip = clips.find((c) => c.id === id)
    if (!clip || !clip.sourceFilename) return
    const oldBase = clip.sourceFilename.split('/').pop()?.replace(/\.(wav|mp3|ogg|flac|aac|m4a)$/i, '') ?? ''
    const desired = clip.name.trim().replace(/[\\/:*?"<>|]/g, '_')
    if (!desired || desired === oldBase) return
    get().setLocalFsStatus('saving', `clip file rename "${oldBase}" → "${desired}"…`)
    try {
      const newPath = await renameClipFile(workDirHandle, clip.sourceFilename, desired)
      if (!newPath) {
        get().setLocalFsStatus('error', `clip file rename 失敗: "${oldBase}" の disk 上のファイルが見つかりません`)
        return
      }
      // 新 filename を反映。name は拡張子を除いた実ベース名に再同期する。
      const newBase = newPath.split('/').pop()?.replace(/\.(wav|mp3|ogg|flac|aac|m4a)$/i, '') ?? clip.name
      const patch = { sourceFilename: newPath, name: newBase }
      await updateClipMeta(id, patch)
      const updated = get().clips.map((c) =>
        c.id === id ? { ...c, ...patch, updatedAt: new Date().toISOString() } : c
      )
      set({ clips: updated })
      await saveClipsMetaToDir(workDirHandle, updated)
      get().setLocalFsStatus('saved', `clip file "${oldBase}" → "${newBase}" rename`)
    } catch (err) {
      console.error('renameClipFile failed:', err)
      const msg = err instanceof Error ? err.message : String(err)
      get().setLocalFsStatus('error', `clip file rename 失敗: ${msg}`)
    }
  },

  setLibraryIntensity: async (id, value) => {
    const clamped = Math.max(0, Math.min(1, value))
    await get().updateClip(id, { libraryIntensity: Math.round(clamped * 100) / 100 })
  },

  loadAmpPresets: async () => {
    const { workDirHandle } = get()
    if (!workDirHandle) { set({ ampPresets: [] }); return }
    const list = await readMetadataJson<ClipAmpPreset[]>(workDirHandle, AMP_PRESETS_FILE)
    set({ ampPresets: list ?? [] })
  },

  saveAmpPreset: async (name) => {
    const trimmed = name.trim()
    if (!trimmed) return
    const { workDirHandle, clips, ampPresets } = get()
    if (!workDirHandle) return
    const values: Record<string, number> = {}
    for (const c of clips) values[c.id] = c.libraryIntensity ?? 0.5
    const entry: ClipAmpPreset = {
      name: trimmed,
      createdAt: new Date().toISOString(),
      values,
    }
    const others = ampPresets.filter((p) => p.name !== trimmed)
    const next = [...others, entry].sort((a, b) => a.name.localeCompare(b.name))
    set({ ampPresets: next })
    await writeMetadataJson(workDirHandle, AMP_PRESETS_FILE, next)
  },

  applyAmpPreset: async (name) => {
    const { ampPresets, clips, workDirHandle } = get()
    const preset = ampPresets.find((p) => p.name === name)
    if (!preset) return
    const updated = clips.map((c) => {
      const v = preset.values[c.id]
      if (typeof v !== 'number') return c
      return { ...c, libraryIntensity: Math.round(Math.max(0, Math.min(1, v)) * 100) / 100, updatedAt: new Date().toISOString() }
    })
    set({ clips: updated })
    // Persist each changed clip
    for (const c of updated) {
      if (preset.values[c.id] !== undefined) await updateClipMeta(c.id, { libraryIntensity: c.libraryIntensity })
    }
    if (workDirHandle) await saveClipsMetaToDir(workDirHandle, updated)
  },

  deleteAmpPreset: async (name) => {
    const { workDirHandle, ampPresets } = get()
    const next = ampPresets.filter((p) => p.name !== name)
    set({ ampPresets: next })
    if (workDirHandle) await writeMetadataJson(workDirHandle, AMP_PRESETS_FILE, next)
  },

  getClipAudio: async (id) => {
    // Try work directory first, fallback to IndexedDB
    const { workDirHandle, clips } = get()
    if (workDirHandle) {
      const clip = clips.find((c) => c.id === id)
      if (clip?.sourceFilename) {
        const file = await readClipFile(workDirHandle, clip.sourceFilename)
        if (file) return new Blob([await file.arrayBuffer()], { type: 'audio/wav' })
      }
    }
    return loadClipAudio(id)
  },

  getKitEventAudio: async (kitEventId) => {
    // Kit-event audio lives under its own IDB key (`saveKitEventAudio`
    // wrote it on add / migration). IDB-first because the kit folder
    // on disk holds the *resampled* (16 kHz) version — the original
    // bytes the user dropped are what we cached, and what previews
    // should sound like. Fall back to scanning kit folder install-clips
    // would be possible but isn't currently needed (events all carry
    // their own blob post-migration).
    return loadKitEventAudio(kitEventId)
  },

  // Kit actions
  createKit: async (name) => {
    const now = new Date().toISOString()
    const kit: KitDefinition = {
      id: generateId(),
      name,
      version: '1.0.0',
      description: '',
      events: [],
      createdAt: now,
      updatedAt: now,
    }
    // (Disk-as-truth) Persistence: zustand state + kits-meta.json on
    // disk (via saveKitsMetaToDir). No mirror to IDB.
    const newKits = [...get().kits, kit]
    set({ kits: newKits, activeKitId: kit.id })
    const { workDirHandle } = get()
    if (workDirHandle) await saveKitsMetaToDir(workDirHandle, newKits)
    // Materialize the kit folder immediately so the user sees it pop
    // up in their OS file explorer right after "+ Kit". 0-delay path
    // skips the debounce and runs on the next microtask.
    setOp(kit.id, `kit/${kit.name} (new)`)
    get().scheduleKitFlush(kit.id, 0)
    return kit.id
  },

  removeKit: async (id) => {
    const kit = get().kits.find((k) => k.id === id)
    get().setLocalFsStatus('saving', `kit "${kit?.name ?? id}" を archive 移動中…`)
    // Cancel any pending autosave so it doesn't recreate the folder
    // we're about to archive.
    get().cancelKitFlush(id)
    // Prune per-event audio + encoded-WAV cache for this kit. The
    // encoded-WAV cache was added in DB v2 so older browsers may not
    // have the store yet — wrap each in try/catch so a stale entry
    // doesn't block kit removal.
    if (kit) {
      for (const ev of kit.events) {
        try { await deleteKitEventAudio(ev.id) } catch { /* ignore */ }
        try { await deleteEncodedWavsForEvent(ev.id) } catch { /* ignore */ }
      }
    }
    await deleteKit(id)
    const newKits = get().kits.filter((k) => k.id !== id)
    set({
      kits: newKits,
      activeKitId: get().activeKitId === id ? null : get().activeKitId,
    })
    const { workDirHandle, kitDirHandle } = get()
    if (workDirHandle) await saveKitsMetaToDir(workDirHandle, newKits)

    // Move the on-disk folder into `_archive/` instead of deleting
    // it outright — the user can recover by hand from their OS file
    // explorer. `scanKitOutputFolder` skips that folder so the kit
    // stops appearing in the UI on the next refresh.
    if (kit) {
      // Archive whatever kitId we last wrote (covers the rename case
      // where in-memory kit.name no longer matches the folder on disk).
      const kitId = lastWrittenKitId.get(kit.id) ?? toKitId(kit.name)
      const outRoot = kitDirHandle ?? workDirHandle
      if (outRoot) {
        await archiveKitFolder(outRoot, kitId)
      }
      lastWrittenKitId.delete(kit.id)
      lastBuiltKit.delete(kit.id)
    }
    get().setLocalFsStatus('saved', `kit "${kit?.name ?? id}" を archive`)
  },

  setActiveKit: (id) => {
    set({ activeKitId: id })
  },

  setEditingClipId: (id) => {
    set({ editingClipId: id })
  },

  setActiveSelection: (selection) => {
    set({ activeSelection: selection })
  },

  setShowClipDetails: (show) => {
    set({ showClipDetails: show })
  },

  addEventToKit: async (kitId, event, audioBlob) => {
    const { kits } = get()
    const kit = kits.find((k) => k.id === kitId)
    if (!kit) return null

    // Independence: the new KitEvent already carries its own clipName /
    // clipDuration / clipSourceFilename / etc (copied from the source
    // library clip by the caller). We save the audio blob under the
    // generated event id so future preview / export / deploy can find
    // it WITHOUT having to look up the library entry — even if that
    // library entry is later archived or deleted.
    const composedId = event.clipName
      ? composeKitEventId(kit.name, event.clipName)
      : event.eventId  // last resort (caller didn't set a clipName)

    const newEvent: KitEvent = { id: generateId(), ...event, eventId: composedId }
    if (audioBlob) {
      try { await saveKitEventAudio(newEvent.id, audioBlob) }
      catch (err) { console.error('saveKitEventAudio failed:', err) }
    }
    const updated = { ...kit, events: [...kit.events, newEvent], updatedAt: new Date().toISOString() }
    // (Disk-as-truth) State + kits-meta.json on disk. No IDB kit mirror.
    const newKits = kits.map((k) => (k.id === kitId ? updated : k))
    set({ kits: newKits })
    const { workDirHandle } = get()
    if (workDirHandle) await saveKitsMetaToDir(workDirHandle, newKits)
    // Kit folder Pack rebuild (resample + install-clips/ + manifest)
    // is deferred to the Deploy button — it was the dominant cause
    // of UI lag while editing. Metadata is still flushed eagerly to
    // kits-meta.json above so the kit list survives a reload.
    return newEvent.id
  },

  removeEventFromKit: async (kitId, kitEventId) => {
    const { kits } = get()
    const kit = kits.find((k) => k.id === kitId)
    if (!kit) return
    const ev = kit.events.find((e) => e.id === kitEventId)
    const clipName = ev?.clipName ?? '?'

    const updated = { ...kit, events: kit.events.filter((e) => e.id !== kitEventId), updatedAt: new Date().toISOString() }
    // (Disk-as-truth) State + kits-meta.json. No IDB kit mirror.
    const newKits = kits.map((k) => (k.id === kitId ? updated : k))
    set({ kits: newKits })
    // Drop the kit-owned audio blob so removed events don't leak into
    // IDB indefinitely. Best-effort; a missing blob is fine (e.g. for
    // events whose audio failed to import).
    try { await deleteKitEventAudio(kitEventId) } catch { /* ignore */ }
    // Drop the encoded-WAV cache too so the removed event doesn't keep
    // a stale device-format blob around. Failure is non-fatal.
    try { await deleteEncodedWavsForEvent(kitEventId) } catch { /* ignore */ }
    const { workDirHandle } = get()
    if (workDirHandle) await saveKitsMetaToDir(workDirHandle, newKits)
    // Pack rebuild deferred to Deploy (see addEventToKit comment).
    // The removed event will disappear from install-clips/ /
    // stream-clips/ only on the next deploy — until then the kit
    // folder retains the WAV. Harmless: nothing in the kit's manifest
    // references it any more.
    void clipName
  },

  updateKitEvent: async (kitId, kitEventId, updates) => {
    const { kits } = get()
    const kit = kits.find((k) => k.id === kitId)
    if (!kit) return
    const prev = kit.events.find((e) => e.id === kitEventId)
    const prevName = prev?.clipName ?? '?'

    const updated = {
      ...kit,
      events: kit.events.map((e) => e.id === kitEventId ? { ...e, ...updates } : e),
      updatedAt: new Date().toISOString(),
    }
    // (Disk-as-truth) State + kits-meta.json. No IDB kit mirror.
    const newKits = kits.map((k) => (k.id === kitId ? updated : k))
    set({ kits: newKits })
    const { workDirHandle } = get()
    if (workDirHandle) await saveKitsMetaToDir(workDirHandle, newKits)
    // Metadata-only update — no Pack rebuild. Mode toggle / intensity
    // drag / rename used to trigger a 400 ms-debounced full kit
    // re-emit (resample + write every WAV) and that was the dominant
    // source of UI lag while editing. The kit folder picks up these
    // changes on the next Deploy.
    void prevName
  },

  updateKit: async (id, updates) => {
    const { kits } = get()
    const kit = kits.find((k) => k.id === id)
    if (!kit) return

    // If the kit name changed, every event's eventId must be recomposed
    // because the category part is `<kitName>` by definition. Caller
    // need not pass `events` — the store handles it.
    const renamed = updates.name !== undefined && updates.name !== kit.name
    let updated = { ...kit, ...updates, updatedAt: new Date().toISOString() }
    if (renamed) {
      const newName = updates.name as string
      updated.events = updated.events.map((e) => {
        // Independence: each event owns its own clipName snapshot, so
        // the recomposed eventId comes straight off the event. No more
        // library lookup; kit rename never has to chase a now-missing
        // library entry.
        const newEventId = e.clipName
          ? composeKitEventId(newName, e.clipName)
          : e.eventId
        return { ...e, eventId: newEventId }
      })
    }
    // (Disk-as-truth) State + kits-meta.json. No IDB kit mirror.
    const newKits = kits.map((k) => (k.id === id ? updated : k))
    set({ kits: newKits })
    const { workDirHandle } = get()
    if (workDirHandle) await saveKitsMetaToDir(workDirHandle, newKits)
    // Kit-level rename / metadata change — no Pack rebuild. Deploy
    // is the explicit "publish kit to disk + device" action. The
    // previous folder (under the old kitId) is also left alone here;
    // it'll be archived on the next Deploy by the kitId-rename code
    // path in flushKitFolderNow.
  },

  // Tab / filter
  setActiveTab: (tab) => {
    set({ activeTab: tab })
    // Refresh from work directory when switching to user tab
    if (tab === 'user' && get().workDirHandle) {
      get().refreshClipsFromDir()
    }
  },

  setViewMode: (mode) => {
    set({ viewMode: mode })
  },

  setBuiltinCategoryFilter: (category) => {
    set({ builtinCategoryFilter: category })
  },

  setFilter: (partial) => {
    set((state) => {
      const next = { ...state.filter, ...partial }
      // Persist sort changes (and only sort) on every update.
      // Cheap to do unconditionally — savePersistedSort no-ops when
      // the fields didn't change at the JSON level since the string
      // matches whatever's already in localStorage.
      if (partial.sortBy !== undefined || partial.sortOrder !== undefined) {
        savePersistedSort(next)
      }
      return { filter: next }
    })
  },

  resetFilter: () => {
    // Keep the persisted sort even when the user clears filters —
    // "reset" is about wiping the search/tag selection, not undoing
    // their long-standing list ordering preference.
    const persisted = loadPersistedSort()
    set({ filter: { ...DEFAULT_FILTER, ...(persisted ?? {}) } })
  },

  // Computed
  filteredBuiltinClips: () => {
    const { builtinIndex, builtinCategoryFilter, filter } = get()
    if (!builtinIndex) return []
    let result = [...builtinIndex]

    // Category filter
    if (builtinCategoryFilter) {
      result = result.filter((c) => c.category === builtinCategoryFilter)
    }

    // Search
    if (filter.searchQuery) {
      const q = filter.searchQuery.toLowerCase()
      result = result.filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          c.event_id.toLowerCase().includes(q) ||
          c.description.toLowerCase().includes(q) ||
          c.tags.some((t) => t.toLowerCase().includes(q))
      )
    }

    return result
  },

  filteredClips: () => {
    const { clips, filter } = get()
    // Strip clips whose on-disk location is a Studio-managed folder
    // (`_archive/`, `_archive~/`, legacy `archive/`). These shouldn't
    // appear in the library tree even if they're still in IDB / the
    // saved `kits-meta.json` from earlier Studio versions — the
    // archive is invisible by convention.
    let result = clips.filter((c) => {
      const top = (c.sourceFilename || '').split('/').filter(Boolean)[0] ?? ''
      return !isHiddenStudioDir(top)
    })

    // Search
    if (filter.searchQuery) {
      const q = filter.searchQuery.toLowerCase()
      result = result.filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          (c.note ?? '').toLowerCase().includes(q) ||
          c.tags.some((t) => t.toLowerCase().includes(q))
      )
    }

    // Tags
    if (filter.selectedTags.length > 0) {
      result = result.filter((c) =>
        filter.selectedTags.every((t) => c.tags.includes(t))
      )
    }

    // Group
    if (filter.selectedGroup !== null) {
      result = result.filter((c) => c.group === filter.selectedGroup)
    }

    // Sort
    result.sort((a, b) => {
      let cmp = 0
      switch (filter.sortBy) {
        case 'name':
          cmp = a.name.localeCompare(b.name)
          break
        case 'date':
          cmp = a.updatedAt.localeCompare(b.updatedAt)
          break
        case 'duration':
          cmp = a.duration - b.duration
          break
      }
      return filter.sortOrder === 'asc' ? cmp : -cmp
    })

    return result
  },

  allTags: () => {
    const { clips } = get()
    const tagSet = new Set<string>()
    for (const clip of clips) {
      for (const tag of clip.tags) tagSet.add(tag)
    }
    return Array.from(tagSet).sort()
  },

  allGroups: () => {
    const { clips } = get()
    const groupSet = new Set<string>()
    for (const clip of clips) {
      if (clip.group) groupSet.add(clip.group)
    }
    return Array.from(groupSet).sort()
  },

  builtinCategories: () => {
    const { builtinIndex } = get()
    if (!builtinIndex) return []
    const catSet = new Set<string>()
    for (const clip of builtinIndex) catSet.add(clip.category)
    return Array.from(catSet).sort()
  },
}))

