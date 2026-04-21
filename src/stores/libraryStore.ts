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
  type DiscoveredKit,
} from '@/utils/localDirectory'

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
 * Derive event_id from filename with namespace support.
 * Contracts require at least category.name (one dot minimum).
 *
 *   "impact/gunshot_1.wav" → "impact.gunshot_1"
 *   "gunshot_1.wav"        → "clip.gunshot_1"  (default category)
 *   "a/b/c.wav"            → "a.b.c"
 */
function filenameToEventId(filename: string): string {
  const withoutExt = filename.replace(/\.(wav|mp3|ogg|flac|aac|m4a)$/i, '')
  const dotted = withoutExt.replace(/\\/g, '/').replace(/\//g, '.').toLowerCase()
  // Contracts require at least one dot (category.name)
  if (!dotted.includes('.')) return `clip.${dotted}`
  return dotted
}

/** Event ID の1パートとして安全な文字列に変換。
 *  contracts の正規表現: `^[a-z][a-z0-9_-]{0,63}$` */
function sanitizeEventIdPart(s: string): string {
  let out = s.toLowerCase().replace(/[^a-z0-9_-]/g, '_').replace(/_{2,}/g, '_')
  out = out.replace(/^[_-]+/, '').replace(/[_-]+$/, '')
  // 先頭は英小文字必須
  if (!/^[a-z]/.test(out)) out = `c${out ? '_' + out : ''}`
  return out.slice(0, 64)
}

/** clip.sourceFilename のフォルダ部分から category を導出。
 *  ルート直下 (folder なし) の場合はデフォルト "clip" を返す。 */
function deriveCategoryFromPath(sourceFilename: string): string {
  const parts = (sourceFilename || '').replace(/\\/g, '/').split('/').filter(Boolean)
  if (parts.length < 2) return 'clip'
  return sanitizeEventIdPart(parts[parts.length - 2])
}

/** clip.name からの event_id の name 部分。 */
function deriveNameFromClipName(name: string): string {
  return sanitizeEventIdPart(name || '')
}

/** eventIdAuto フラグに従って eventId を再計算する。
 *  auto が両方 false なら既存 eventId をそのまま返す。 */
export function recomputeEventId(clip: Pick<LibraryClip, 'eventId' | 'name' | 'sourceFilename' | 'eventIdAuto'>): string {
  const auto = clip.eventIdAuto ?? { category: true, name: true }
  const dotIdx = (clip.eventId || '').indexOf('.')
  const curCat = dotIdx > 0 ? clip.eventId.substring(0, dotIdx) : ''
  const curName = dotIdx > 0 ? clip.eventId.substring(dotIdx + 1) : (clip.eventId || '')
  const cat = auto.category ? deriveCategoryFromPath(clip.sourceFilename) : curCat
  const name = auto.name ? deriveNameFromClipName(clip.name) : curName
  return cat && name ? `${cat}.${name}` : ''
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
      eventId: meta.event_id,
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
        eventId: meta.event_id,
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
    set({ kitDirHandle: handle, kitDirName: handle.name })
    // ユーザーが選んだフォルダが既存の Hapbeat kit を含んでいれば自動取り込み
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
    set({ kitDirHandle: null, kitDirName: null })
  },

  importKitsFromOutputDir: async () => {
    const { kitDirHandle, workDirHandle } = get()
    if (!kitDirHandle) return 0

    const discovered = await scanKitOutputFolder(kitDirHandle)
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
          eventId: '',
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
    for (const { manifestJson, clipFiles } of discovered as DiscoveredKit[]) {
      if (!manifestJson || typeof manifestJson !== 'object') continue
      const m = manifestJson as {
        pack_id?: string; name?: string; version?: string; description?: string
        created_at?: string; events?: Record<string, unknown>
      }
      const packId = String(m.pack_id ?? m.name ?? '').trim()
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
          // clipPath は "stream-clips/foo.wav" または "foo.wav" (command の場合 clips/ 相対)
          const relKey = ev.clip.includes('/') ? ev.clip : `clips/${ev.clip}`
          const file = clipFiles.get(relKey) ?? clipFiles.get(ev.clip)
          if (file) {
            const id = await ensureClip(ev.clip, file)
            if (id) clipId = id
          }
        }
        const params = (ev.parameters ?? {}) as { intensity?: number; loop?: boolean; device_wiper?: number }
        events.push({
          id: generateId(),
          eventId,
          clipId,
          mode,
          loop: params.loop ?? false,
          intensity: typeof params.intensity === 'number' ? params.intensity : 0.5,
          deviceWiper: typeof params.device_wiper === 'number' ? params.device_wiper : null,
        })
      }

      const existingIdx = updatedKits.findIndex((k) => k.name === (m.name ?? packId) || k.name === packId)
      const kit: KitDefinition = {
        id: existingIdx >= 0 ? updatedKits[existingIdx].id : generateId(),
        name: String(m.name ?? packId),
        version: String(m.version ?? '1.0.0'),
        description: String(m.description ?? ''),
        events,
        createdAt: existingIdx >= 0 ? updatedKits[existingIdx].createdAt : (m.created_at ?? now),
        updatedAt: now,
      }
      if (existingIdx >= 0) updatedKits[existingIdx] = kit
      else updatedKits.push(kit)
      await saveKit(kit)
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
            eventId: filenameToEventId(filename),
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

    if (savedKits) {
      const migrated = savedKits.map(migrateKit)
      for (const kit of migrated) await saveKit(kit)
      set({ kits: migrated })
    } else {
      const kits = await listKits()
      set({ kits: kits.map(migrateKit) })
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
              eventId: filenameToEventId(filename),
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
      eventId: '',
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
      eventId: filenameToEventId(file.name),
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
    // eventIdAuto が有効なら eventId を再計算して上書きする
    const prev = get().clips.find((c) => c.id === id)
    let finalUpdates = updates
    if (prev) {
      const merged = { ...prev, ...updates }
      const auto = merged.eventIdAuto ?? { category: true, name: true }
      // ユーザが手動で eventId を直接編集している場合はそれを尊重（auto を off にすべき）
      const userEditedEventId = 'eventId' in updates
      if (!userEditedEventId && (auto.category || auto.name)) {
        const derived = recomputeEventId(merged)
        if (derived !== merged.eventId) finalUpdates = { ...updates, eventId: derived }
      }
    }
    await updateClipMeta(id, finalUpdates)
    const newClips = get().clips.map((c) =>
      c.id === id ? { ...c, ...finalUpdates, updatedAt: new Date().toISOString() } : c
    )
    set({ clips: newClips })
    // Update metadata in work directory
    const { workDirHandle } = get()
    if (workDirHandle) {
      await saveClipsMetaToDir(workDirHandle, newClips)
    }
  },

  commitClipRename: async (id) => {
    const { workDirHandle, clips } = get()
    if (!workDirHandle) return
    const clip = clips.find((c) => c.id === id)
    if (!clip || !clip.sourceFilename) return
    const ext = clip.sourceFilename.match(/\.(wav|mp3|ogg|flac|aac|m4a)$/i)?.[0] ?? ''
    const oldBase = clip.sourceFilename.split('/').pop()?.replace(/\.(wav|mp3|ogg|flac|aac|m4a)$/i, '') ?? ''
    const desired = clip.name.trim().replace(/[\\/:*?"<>|]/g, '_')
    if (!desired || desired === oldBase) return
    try {
      const newPath = await renameClipFile(workDirHandle, clip.sourceFilename, desired)
      if (!newPath) return
      // 新 filename を反映。name は拡張子を除いた実ベース名に再同期する。
      const newBase = newPath.split('/').pop()?.replace(/\.(wav|mp3|ogg|flac|aac|m4a)$/i, '') ?? clip.name
      const rebuiltBase = { sourceFilename: newPath, name: newBase }
      // eventIdAuto に応じて eventId も再計算
      const auto = clip.eventIdAuto ?? { category: true, name: true }
      const newEventId = auto.category || auto.name
        ? recomputeEventId({ ...clip, ...rebuiltBase })
        : clip.eventId
      const patch = { ...rebuiltBase, eventId: newEventId }
      await updateClipMeta(id, patch)
      const updated = get().clips.map((c) =>
        c.id === id ? { ...c, ...patch, updatedAt: new Date().toISOString() } : c
      )
      set({ clips: updated })
      await saveClipsMetaToDir(workDirHandle, updated)
      void ext // kept for readability — extension preserved by renameClipFile
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
    return kit.id
  },

  removeKit: async (id) => {
    await deleteKit(id)
    const newKits = get().kits.filter((k) => k.id !== id)
    set({
      kits: newKits,
      activeKitId: get().activeKitId === id ? null : get().activeKitId,
    })
    const { workDirHandle } = get()
    if (workDirHandle) await saveKitsMetaToDir(workDirHandle, newKits)
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
    const { kits } = get()
    const kit = kits.find((k) => k.id === kitId)
    if (!kit) return null

    const newEvent: KitEvent = { id: generateId(), ...event }
    const updated = { ...kit, events: [...kit.events, newEvent], updatedAt: new Date().toISOString() }
    await saveKit(updated)
    const newKits = kits.map((k) => (k.id === kitId ? updated : k))
    set({ kits: newKits })
    const { workDirHandle } = get()
    if (workDirHandle) await saveKitsMetaToDir(workDirHandle, newKits)
    return newEvent.id
  },

  removeEventFromKit: async (kitId, kitEventId) => {
    const { kits } = get()
    const kit = kits.find((k) => k.id === kitId)
    if (!kit) return

    const updated = { ...kit, events: kit.events.filter((e) => e.id !== kitEventId), updatedAt: new Date().toISOString() }
    await saveKit(updated)
    const newKits = kits.map((k) => (k.id === kitId ? updated : k))
    set({ kits: newKits })
    const { workDirHandle } = get()
    if (workDirHandle) await saveKitsMetaToDir(workDirHandle, newKits)
  },

  updateKitEvent: async (kitId, kitEventId, updates) => {
    const { kits } = get()
    const kit = kits.find((k) => k.id === kitId)
    if (!kit) return

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
  },

  updateKit: async (id, updates) => {
    const { kits } = get()
    const kit = kits.find((k) => k.id === id)
    if (!kit) return

    const updated = { ...kit, ...updates, updatedAt: new Date().toISOString() }
    await saveKit(updated)
    const newKits = kits.map((k) => (k.id === id ? updated : k))
    set({ kits: newKits })
    const { workDirHandle } = get()
    if (workDirHandle) await saveKitsMetaToDir(workDirHandle, newKits)
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
          c.eventId.toLowerCase().includes(q) ||
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
