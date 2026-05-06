import { create } from 'zustand'
import type { LibraryClip, KitDefinition, KitEvent, KitEventMode, LibraryFilter, BuiltinClipMeta, BuiltinLibraryIndex, LibraryViewMode, ClipAmpPreset } from '@/types/library'
import {
  saveClip,
  listClips,
  deleteClip,
  updateClipMeta,
  loadClipAudio,
  saveKit,
  listKits,
  deleteKit,
} from '@/utils/libraryStorage'
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
  type DiscoveredKit,
} from '@/utils/localDirectory'
import { exportKitAsPack, toPackId } from '@/utils/kitExporter'

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
   * Build the kit ZIP and write `<outRoot>/<packId>/` to disk *now*.
   * Validates silently — invalid kits / missing outRoot return null.
   * Updates the per-kit ZIP cache used by Deploy.
   */
  flushKitFolderNow: (kitId: string) => Promise<{ blob: Blob; packId: string } | null>
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
  /** Latest ZIP build for a kit, populated by flushKitFolderNow. Deploy
   *  reads from here to avoid rebuilding on click. */
  getLastBuiltKit: (kitId: string) => { blob: Blob; packId: string } | undefined

  /** Clip id currently open in the inline editor (Clips panel). Set from
   *  either the Clips panel itself or from a Kit event row's Edit action so
   *  the user lands in the same editor regardless of entry point. */
  editingClipId: string | null

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
  setShowClipDetails: (show: boolean) => void
  /**
   * Adds an event to a kit. The caller passes an event *without* the stable
   * per-kit id; the store generates it. Returns the generated id on success
   * so the UI can scroll to / highlight the new row if desired.
   *
   * Duplicate eventIds are now allowed (e.g. the same clip added with two
   * different amps as two distinct events).
   */
  addEventToKit: (kitId: string, event: Omit<KitEvent, 'id'>) => Promise<string | null>
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
  sortBy: 'date',
  sortOrder: 'desc',
}

const CLIPS_META_FILE = 'clips-meta.json'
const KITS_META_FILE = 'kits-meta.json'
const AMP_PRESETS_FILE = 'amp-presets.json'

/** Save clips metadata to the local work directory */
async function saveClipsMetaToDir(handle: FileSystemDirectoryHandle, clips: LibraryClip[]) {
  await writeMetadataJson(handle, CLIPS_META_FILE, clips)
}

/** Upgrade legacy KitDefinitions whose events lack a stable `id` field. */
function migrateKit(kit: KitDefinition): KitDefinition {
  let changed = false
  const events = kit.events.map((e) => {
    if (e.id) return e
    changed = true
    return { ...e, id: generateId() }
  })
  return changed ? { ...kit, events } : kit
}

/** Save kits metadata to the local work directory */
async function saveKitsMetaToDir(handle: FileSystemDirectoryHandle, kits: KitDefinition[]) {
  await writeMetadataJson(handle, KITS_META_FILE, kits)
}

// ---- Kit folder persistence (module-level state) ------------------------
//
// Per-kit debounce timers, last-written packId (for rename → archive
// old folder) and last-built ZIP cache (for Deploy). These live outside
// zustand state because they're internal bookkeeping that should not
// trigger React re-renders.

const kitFlushTimers = new Map<string, number>()
const lastWrittenPackId = new Map<string, string>()
const lastBuiltKit = new Map<string, { blob: Blob; packId: string }>()

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
  lastWrittenPackId.clear()
  lastBuiltKit.clear()
  lastOpMessage.clear()
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
  showClipDetails: true,
  filter: { ...DEFAULT_FILTER },
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
    const doFlush = async (): Promise<{ blob: Blob; packId: string } | null> => {
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
      const result = await exportKitAsPack(kit, state.clips)

      // Race-condition guard: kit may have been removed (× clicked)
      // while exportKitAsPack was running. Bail before any disk write.
      if (!useLibraryStore.getState().kits.some((k) => k.id === kit.id)) {
        return null
      }

      const zip = (await import('jszip')).default
      const zipData = await zip.loadAsync(result.blob)
      const files: { path: string; blob: Blob }[] = []
      for (const [path, entry] of Object.entries(zipData.files)) {
        if (!entry.dir) {
          const blob = await entry.async('blob')
          // exportKitAsPack puts everything under `<packId>/` — strip
          // that prefix so writeKitFolder rebuilds the same layout.
          const relPath = path.includes('/') ? path.substring(path.indexOf('/') + 1) : path
          if (relPath) files.push({ path: relPath, blob })
        }
      }
      const packId = toPackId(kit.name)

      // Rename: if this kit was previously written under a different
      // packId, archive the stale folder so it stops appearing in OS
      // Explorer. The new folder is written below.
      const prevPackId = lastWrittenPackId.get(kit.id)
      if (prevPackId && prevPackId !== packId) {
        try { await archiveKitFolder(outRoot, prevPackId) } catch { /* ignore */ }
      }

      // Version-bump history: snapshot the existing manifest under
      // history/manifest-<oldVersion>.json before overwriting. WAVs
      // aren't kept (size cost) — just the small manifest.
      try {
        const thisKitDir = await outRoot.getDirectoryHandle(packId, { create: false })
        const oldHandle = await thisKitDir.getFileHandle('manifest.json', { create: false })
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
      } catch { /* no existing manifest — first save */ }

      await writeKitFolder(outRoot, packId, files)

      // Prune stale WAVs in install-clips/ and stream-clips/. The
      // folder is the on-disk projection of the latest manifest, so
      // anything not in the freshly written `files` set is leftover
      // from a previous version (rename, removed event, mode swap).
      const keep = new Set(files.map((f) => f.path))
      try {
        const kitDir = await outRoot.getDirectoryHandle(packId)
        for (const subName of ['install-clips', 'stream-clips'] as const) {
          let sub: FileSystemDirectoryHandle
          try {
            sub = await kitDir.getDirectoryHandle(subName)
          } catch { continue /* sub-folder doesn't exist */ }
          const stale: string[] = []
          for await (const entry of sub.values()) {
            if (entry.kind !== 'file') continue
            if (!keep.has(`${subName}/${entry.name}`)) stale.push(entry.name)
          }
          for (const n of stale) {
            try { await sub.removeEntry(n) } catch { /* ignore */ }
          }
        }
      } catch { /* kit dir vanished — caller will see no folder */ }

      lastWrittenPackId.set(kit.id, packId)
      lastBuiltKit.set(kit.id, { blob: result.blob, packId })

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
      if (opMsg) state.setLocalFsStatus('saved', opMsg)
      return { blob: result.blob, packId }
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
        // Fallback to IndexedDB
        const [clips, kits] = await Promise.all([listClips(), listKits()])
        set({ clips, kits: kits.map(migrateKit) })
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

    const blob = await fetchBuiltinClipAudio(builtinId)
    if (!blob) return undefined

    const now = new Date().toISOString()
    const clip: LibraryClip = {
      id: generateId(),
      name: meta.name,
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
    return clip.id
  },

  importAllBuiltinClips: async () => {
    // Make sure we have the index (lazy-load if not yet fetched).
    if (get().builtinIndex === null) await get().loadBuiltinIndex()
    const { builtinIndex, fetchBuiltinClipAudio, workDirHandle } = get()
    if (!builtinIndex || builtinIndex.length === 0) return 0

    const now = new Date().toISOString()
    const toAdd: LibraryClip[] = []
    const existingBuiltinIds = new Set(
      get().clips.map((c) => c.builtinId).filter((x): x is string => !!x)
    )

    for (const meta of builtinIndex) {
      if (existingBuiltinIds.has(meta.id)) continue
      const blob = await fetchBuiltinClipAudio(meta.id)
      if (!blob) continue
      // Built-ins land in clips/template/<filename>. The user can freely
      // move them out, edit them or delete them — nothing else depends on
      // the subfolder location, it's purely for organisation.
      const relPath = `template/${meta.filename}`
      const clip: LibraryClip = {
        id: generateId(),
        name: meta.name,
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

    if (toAdd.length === 0) return 0
    const newClips = [...toAdd, ...get().clips]
    set({ clips: newClips })
    if (workDirHandle) await saveClipsMetaToDir(workDirHandle, newClips)
    return toAdd.length
  },

  // ---- Work directory actions ----

  pickWorkDir: async () => {
    if (!isFileSystemAccessSupported()) return false
    const handle = await pickWorkDirectory()
    if (!handle) return false
    set({ workDirHandle: handle, workDirName: handle.name })

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
    if (discovered.length === 0) return 0

    const ctx = new AudioContext()
    const now = new Date().toISOString()
    const updatedClips = [...get().clips]
    const updatedKits = [...get().kits]

    /** basename match (先頭のフォルダ部分を無視) でライブラリ clip を探す。
     *  無ければ file を decode してライブラリに登録する。 */
    const ensureClip = async (filename: string, file: File): Promise<string | null> => {
      const base = (filename.split('/').pop() || filename)
      const existing = updatedClips.find((c) => {
        const b = (c.sourceFilename || '').split('/').pop() || c.sourceFilename
        return b === base
      })
      if (existing) return existing.id
      try {
        const arrayBuffer = await file.arrayBuffer()
        const buffer = await ctx.decodeAudioData(arrayBuffer.slice(0))
        const id = generateId()
        const clip: LibraryClip = {
          id,
          name: filenameToDisplayName(base),
          tags: [],
          group: '',
          duration: buffer.duration,
          channels: buffer.numberOfChannels,
          sampleRate: buffer.sampleRate,
          fileSize: file.size,
          sourceFilename: base,
          createdAt: now,
          updatedAt: now,
        }
        updatedClips.push(clip)
        const blob = new Blob([arrayBuffer], { type: 'audio/wav' })
        await saveClip(clip, blob)
        if (workDirHandle) await writeClipFile(workDirHandle, base, blob)
        return id
      } catch (err) {
        console.error(`Failed to decode kit clip "${filename}":`, err)
        return null
      }
    }

    let importedCount = 0
    for (const { folderName, manifestJson, clipFiles } of discovered as DiscoveredKit[]) {
      if (!manifestJson || typeof manifestJson !== 'object') continue
      // `name` is the only kit identifier in modern manifests; older
      // exports also carried `kit_id` which we now ignore (it always
      // equalled `name` anyway).
      const m = manifestJson as {
        name?: string; version?: string; description?: string
        created_at?: string; events?: Record<string, unknown>
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
      const packId = folderName.trim()
      if (!packId) continue

      const events: KitEvent[] = []
      for (const [eventId, rawEv] of Object.entries(m.events ?? {})) {
        if (!rawEv || typeof rawEv !== 'object') continue
        const ev = rawEv as {
          mode?: string; clip?: string; parameters?: Record<string, unknown>
        }
        const mode = (ev.mode ?? 'command') as KitEventMode
        let clipId = ''
        if (ev.clip) {
          // clipPath は "stream-clips/foo.wav" または "foo.wav" (command の場合 install-clips/ 相対, DEC-027)
          const relKey = ev.clip.includes('/') ? ev.clip : `install-clips/${ev.clip}`
          const file = clipFiles.get(relKey) ?? clipFiles.get(ev.clip)
          if (file) {
            const id = await ensureClip(ev.clip, file)
            if (id) clipId = id
          }
        }
        const params = (ev.parameters ?? {}) as { intensity?: number; loop?: boolean; device_wiper?: number }
        // Recover the kit-local name from the on-disk filename. The
        // file under install-clips/ / stream-clips/ is the source of
        // truth — if its stem differs from the library clip's name,
        // a kit-side rename is implied and we restore localName so
        // the next flush keeps writing under the renamed filename.
        let localName: string | undefined = undefined
        if (clipId && ev.clip) {
          const stem = (ev.clip.split('/').pop() || ev.clip).replace(/\.wav$/i, '')
          const libClip = updatedClips.find((c) => c.id === clipId)
          if (libClip && stem && stem !== libClip.name) localName = stem
        }
        events.push({
          id: generateId(),
          eventId,
          clipId,
          mode,
          loop: params.loop ?? false,
          intensity: typeof params.intensity === 'number' ? params.intensity : 0.5,
          deviceWiper: typeof params.device_wiper === 'number' ? params.device_wiper : null,
          ...(localName !== undefined ? { localName } : {}),
        })
      }

      const existingIdx = updatedKits.findIndex((k) => k.name === packId)
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
        name: packId,
        version: String(m.version ?? '1.0.0'),
        description: String(m.description ?? ''),
        events,
        createdAt: existingIdx >= 0 ? updatedKits[existingIdx].createdAt : (m.created_at ?? now),
        updatedAt: now,
        targetDevice: Object.keys(targetDevice).length > 0 ? targetDevice : undefined,
      }
      if (existingIdx >= 0) updatedKits[existingIdx] = kit
      else updatedKits.push(kit)
      await saveKit(kit)
      // Track the packId we just imported so a subsequent kit rename
      // archives this folder rather than orphaning it on disk.
      lastWrittenPackId.set(kit.id, packId)
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

    // Kits: the real master is each `<packId>/manifest.json` file on
    // disk, NOT the cached kitsMeta.json. We do a live folder scan so
    // that kits added/edited/removed via OS Explorer (or by another
    // tool) are picked up on next load.
    //
    // `importKitsFromOutputDir` falls back to `workDirHandle` when no
    // dedicated `kitDirHandle` is set, so it covers both layouts:
    //   - workdir/<packId>/manifest.json   (default — kits inside library)
    //   - kitDir/<packId>/manifest.json    (dedicated kit-out folder)
    //
    // If the scan finds nothing (brand-new workdir, kits never deployed),
    // fall back to the kitsMeta.json snapshot or IDB cache so the user
    // still sees what they had before.
    const importedKitCount = await get().importKitsFromOutputDir().catch((err) => {
      console.warn('Kit folder scan failed, falling back to metadata:', err)
      return 0
    })
    if (importedKitCount === 0) {
      if (savedKits) {
        const migrated = savedKits.map(migrateKit)
        for (const kit of migrated) await saveKit(kit)
        set({ kits: migrated })
      } else {
        const kits = await listKits()
        set({ kits: kits.map(migrateKit) })
      }
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
    const arrayBuffer = await file.arrayBuffer()
    const ctx = new AudioContext()
    const buffer = await ctx.decodeAudioData(arrayBuffer)
    const blob = new Blob([arrayBuffer], { type: file.type || 'audio/wav' })
    const now = new Date().toISOString()
    const clip: LibraryClip = {
      id: generateId(),
      name: filenameToDisplayName(file.name),
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
    return clip.id
  },

  removeClip: async (id) => {
    const { clips, workDirHandle } = get()
    const clip = clips.find((c) => c.id === id)
    await deleteClip(id)
    const newClips = clips.filter((c) => c.id !== id)
    set({ clips: newClips })
    // Remove from work directory
    if (workDirHandle && clip?.sourceFilename) {
      try { await deleteClipFile(workDirHandle, clip.sourceFilename) } catch { /* ignore */ }
      await saveClipsMetaToDir(workDirHandle, newClips)
    }
  },

  archiveClip: async (id) => {
    const { clips, workDirHandle } = get()
    const clip = clips.find((c) => c.id === id)
    if (!clip) return false

    // Move the file into clips/archive/. If there's no work dir, just
    // drop the entry from the list (IndexedDB path) — there's no on-disk
    // file to move in that case.
    if (workDirHandle && clip.sourceFilename) {
      try {
        await archiveClipFile(workDirHandle, clip.sourceFilename)
      } catch (err) {
        console.error('Failed to archive clip file:', err)
      }
    }

    // Drop from the in-memory list and IndexedDB cache. The file lives on
    // in clips/archive/ — the user can move it back to recover it, which
    // our next dir refresh will pick up as a regular clip again.
    await deleteClip(id)
    const newClips = clips.filter((c) => c.id !== id)
    set({ clips: newClips })
    if (workDirHandle) await saveClipsMetaToDir(workDirHandle, newClips)
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

    // If the clip's display name changed, every kit-event referencing
    // this clip needs its eventId recomposed (`<kitName>.<clipName>`).
    const nameChanged =
      updates.name !== undefined && prev !== undefined && updates.name !== prev.name
    if (nameChanged) {
      const newName = updates.name as string
      const { kits } = get()
      // Kit-local renames (event.localName !== undefined) are
      // independent of the library — leave them alone. Only events
      // that still derive their name from the library clip get their
      // eventId recomposed.
      const refreshedKits = kits.map((k) => {
        const touched = k.events.some((e) => e.clipId === id && e.localName === undefined)
        if (!touched) return k
        return {
          ...k,
          events: k.events.map((e) =>
            e.clipId === id && e.localName === undefined
              ? { ...e, eventId: composeKitEventId(k.name, newName) }
              : e
          ),
          updatedAt: new Date().toISOString(),
        }
      })
      set({ kits: refreshedKits })
      // Persist every touched kit
      for (const k of refreshedKits) {
        if (k.events.some((e) => e.clipId === id && e.localName === undefined)) {
          await saveKit(k)
          // The clip rename changes the WAV filename inside install-clips/
          // and the eventId in manifest.json — re-flush every affected
          // kit so the on-disk folder stays consistent.
          get().scheduleKitFlush(k.id)
        }
      }
    }

    // Update metadata in work directory
    const { workDirHandle } = get()
    if (workDirHandle) {
      await saveClipsMetaToDir(workDirHandle, newClips)
      if (nameChanged) await saveKitsMetaToDir(workDirHandle, get().kits)
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
    try {
      const newPath = await renameClipFile(workDirHandle, clip.sourceFilename, desired)
      if (!newPath) return
      // 新 filename を反映。name は拡張子を除いた実ベース名に再同期する。
      const newBase = newPath.split('/').pop()?.replace(/\.(wav|mp3|ogg|flac|aac|m4a)$/i, '') ?? clip.name
      const patch = { sourceFilename: newPath, name: newBase }
      await updateClipMeta(id, patch)
      const updated = get().clips.map((c) =>
        c.id === id ? { ...c, ...patch, updatedAt: new Date().toISOString() } : c
      )
      set({ clips: updated })
      await saveClipsMetaToDir(workDirHandle, updated)
    } catch (err) {
      console.error('renameClipFile failed:', err)
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
    await saveKit(kit)
    const newKits = [...get().kits, kit]
    set({ kits: newKits, activeKitId: kit.id })
    const { workDirHandle } = get()
    if (workDirHandle) await saveKitsMetaToDir(workDirHandle, newKits)
    // Materialize the kit folder immediately so the user sees it pop
    // up in their OS file explorer right after "+ Kit". 0-delay path
    // skips the debounce and runs on the next microtask.
    setOp(kit.id, `kit "${kit.name}" を新規作成`)
    get().scheduleKitFlush(kit.id, 0)
    return kit.id
  },

  removeKit: async (id) => {
    const kit = get().kits.find((k) => k.id === id)
    get().setLocalFsStatus('saving', `kit "${kit?.name ?? id}" を archive 移動中…`)
    // Cancel any pending autosave so it doesn't recreate the folder
    // we're about to archive.
    get().cancelKitFlush(id)
    await deleteKit(id)
    const newKits = get().kits.filter((k) => k.id !== id)
    set({
      kits: newKits,
      activeKitId: get().activeKitId === id ? null : get().activeKitId,
    })
    const { workDirHandle, kitDirHandle } = get()
    if (workDirHandle) await saveKitsMetaToDir(workDirHandle, newKits)

    // Move the on-disk folder into `_archive/` instead of deleting it
    // outright — the user can recover by hand from their OS file
    // explorer. `scanKitOutputFolder` skips `_archive/`, so the kit
    // stops appearing in the UI on the next refresh.
    if (kit) {
      // Archive whatever packId we last wrote (covers the rename case
      // where in-memory kit.name no longer matches the folder on disk).
      const packId = lastWrittenPackId.get(kit.id) ?? toPackId(kit.name)
      const outRoot = kitDirHandle ?? workDirHandle
      if (outRoot) {
        await archiveKitFolder(outRoot, packId)
      }
      lastWrittenPackId.delete(kit.id)
      lastBuiltKit.delete(kit.id)
    }
    get().setLocalFsStatus('saved', `kit "${kit?.name ?? id}" を _archive/ に移動`)
  },

  setActiveKit: (id) => {
    set({ activeKitId: id })
  },

  setEditingClipId: (id) => {
    set({ editingClipId: id })
  },

  setShowClipDetails: (show) => {
    set({ showClipDetails: show })
  },

  addEventToKit: async (kitId, event) => {
    const { kits, clips } = get()
    const kit = kits.find((k) => k.id === kitId)
    if (!kit) return null

    // Always derive eventId from `<kitName>.<clipName>` — callers are
    // expected NOT to set event.eventId themselves anymore. Even if they
    // do, kit-name overrides so all events in a kit share the same
    // category and stay in sync.
    const clip = clips.find((c) => c.id === event.clipId)
    const composedId = clip
      ? composeKitEventId(kit.name, clip.name)
      : event.eventId  // last resort (no matching clip — keep what caller passed)

    const newEvent: KitEvent = { id: generateId(), ...event, eventId: composedId }
    const updated = { ...kit, events: [...kit.events, newEvent], updatedAt: new Date().toISOString() }
    await saveKit(updated)
    const newKits = kits.map((k) => (k.id === kitId ? updated : k))
    set({ kits: newKits })
    const { workDirHandle } = get()
    if (workDirHandle) await saveKitsMetaToDir(workDirHandle, newKits)
    const clipName = clip?.name ?? '?'
    setOp(kitId, `kit "${kit.name}" に "${clipName}" を追加`)
    get().scheduleKitFlush(kitId)
    return newEvent.id
  },

  removeEventFromKit: async (kitId, kitEventId) => {
    const { kits, clips } = get()
    const kit = kits.find((k) => k.id === kitId)
    if (!kit) return
    const ev = kit.events.find((e) => e.id === kitEventId)
    const clipName = ev?.localName ?? clips.find((c) => c.id === ev?.clipId)?.name ?? '?'

    const updated = { ...kit, events: kit.events.filter((e) => e.id !== kitEventId), updatedAt: new Date().toISOString() }
    await saveKit(updated)
    const newKits = kits.map((k) => (k.id === kitId ? updated : k))
    set({ kits: newKits })
    const { workDirHandle } = get()
    if (workDirHandle) await saveKitsMetaToDir(workDirHandle, newKits)
    setOp(kitId, `kit "${kit.name}" から "${clipName}" を削除`)
    get().scheduleKitFlush(kitId)
  },

  updateKitEvent: async (kitId, kitEventId, updates) => {
    const { kits, clips } = get()
    const kit = kits.find((k) => k.id === kitId)
    if (!kit) return
    const prev = kit.events.find((e) => e.id === kitEventId)
    const prevName = prev?.localName ?? clips.find((c) => c.id === prev?.clipId)?.name ?? '?'

    const updated = {
      ...kit,
      events: kit.events.map((e) => e.id === kitEventId ? { ...e, ...updates } : e),
      updatedAt: new Date().toISOString(),
    }
    await saveKit(updated)
    const newKits = kits.map((k) => (k.id === kitId ? updated : k))
    set({ kits: newKits })
    const { workDirHandle } = get()
    if (workDirHandle) await saveKitsMetaToDir(workDirHandle, newKits)

    // Build a context-specific op message based on what changed.
    let opMsg: string
    if (updates.localName !== undefined && updates.localName !== prev?.localName) {
      opMsg = `kit "${kit.name}" の "${prevName}" → "${updates.localName}" rename`
    } else if (updates.mode !== undefined && updates.mode !== prev?.mode) {
      opMsg = `kit "${kit.name}" の "${prevName}" mode → ${updates.mode}`
    } else if (updates.intensity !== undefined && updates.intensity !== prev?.intensity) {
      opMsg = `kit "${kit.name}" の "${prevName}" intensity → ${updates.intensity.toFixed(2)}`
    } else if (updates.deviceWiper !== undefined && updates.deviceWiper !== prev?.deviceWiper) {
      opMsg = `kit "${kit.name}" の "${prevName}" wiper → ${updates.deviceWiper}`
    } else if (updates.loop !== undefined && updates.loop !== prev?.loop) {
      opMsg = `kit "${kit.name}" の "${prevName}" loop ${updates.loop ? 'on' : 'off'}`
    } else {
      opMsg = `kit "${kit.name}" の "${prevName}" を更新`
    }
    setOp(kitId, opMsg)
    get().scheduleKitFlush(kitId)
  },

  updateKit: async (id, updates) => {
    const { kits, clips } = get()
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
        // localName overrides the library clip name for this event.
        const namePart = e.localName ?? clips.find((c) => c.id === e.clipId)?.name
        const newEventId = namePart
          ? composeKitEventId(newName, namePart)
          : e.eventId
        return { ...e, eventId: newEventId }
      })
    }
    await saveKit(updated)
    const newKits = kits.map((k) => (k.id === id ? updated : k))
    set({ kits: newKits })
    const { workDirHandle } = get()
    if (workDirHandle) await saveKitsMetaToDir(workDirHandle, newKits)
    const opMsg = renamed
      ? `kit "${kit.name}" → "${updates.name}" rename`
      : `kit "${kit.name}" を更新`
    setOp(id, opMsg)
    get().scheduleKitFlush(id)
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
    set((state) => ({ filter: { ...state.filter, ...partial } }))
  },

  resetFilter: () => {
    set({ filter: { ...DEFAULT_FILTER } })
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
    let result = [...clips]

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
