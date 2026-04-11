import { create } from 'zustand'
import type { LibraryClip, KitDefinition, KitEvent, LibraryFilter, BuiltinClipMeta, BuiltinLibraryIndex, LibraryViewMode } from '@/types/library'
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
  writeMetadataJson,
  readMetadataJson,
} from '@/utils/localDirectory'

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

/** Derive display name from filename: "impact/gunshot_1.wav" → "Gunshot 1", "gunshot_1.wav" → "Gunshot 1" */
function filenameToDisplayName(filename: string): string {
  // Use just the file part (not directory) for display name
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

  // Kit management
  kits: KitDefinition[]
  activeKitId: string | null

  // Filter
  filter: LibraryFilter
  builtinCategoryFilter: string | null

  // Clip actions
  loadLibrary: () => Promise<void>
  loadBuiltinIndex: () => Promise<void>
  fetchBuiltinClipAudio: (builtinId: string) => Promise<Blob | undefined>
  importBuiltinToLocal: (builtinId: string) => Promise<string | undefined>
  addClipFromBuffer: (
    buffer: AudioBuffer,
    name: string,
    sampleRate: SampleRate,
    sourceFilename: string
  ) => Promise<string>
  addClipFromFile: (file: File) => Promise<string>
  removeClip: (id: string) => Promise<void>
  updateClip: (id: string, updates: Partial<LibraryClip>) => Promise<void>
  getClipAudio: (id: string) => Promise<Blob | undefined>

  // Work directory actions
  pickWorkDir: () => Promise<boolean>
  restoreWorkDir: () => Promise<boolean>
  disconnectWorkDir: () => Promise<void>
  syncClipsToDir: () => Promise<void>
  syncClipsFromDir: () => Promise<void>
  /** Re-scan work dir clips/ folder and update clips list (adds new, removes deleted) */
  refreshClipsFromDir: () => Promise<void>

  // Kit actions
  createKit: (name: string) => Promise<string>
  removeKit: (id: string) => Promise<void>
  setActiveKit: (id: string | null) => void
  addEventToKit: (kitId: string, event: KitEvent) => Promise<void>
  removeEventFromKit: (kitId: string, eventId: string) => Promise<void>
  updateKitEvent: (kitId: string, eventId: string, updates: Partial<KitEvent>) => Promise<void>
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

/** Save clips metadata to the local work directory */
async function saveClipsMetaToDir(handle: FileSystemDirectoryHandle, clips: LibraryClip[]) {
  await writeMetadataJson(handle, CLIPS_META_FILE, clips)
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
  viewMode: 'split-v' as LibraryViewMode,
  workDirHandle: null,
  workDirName: null,
  workDirSupported: isFileSystemAccessSupported(),
  kits: [],
  activeKitId: null,
  filter: { ...DEFAULT_FILTER },
  builtinCategoryFilter: null,

  loadLibrary: async () => {
    set({ isLoading: true })
    try {
      // Try to restore work directory first
      const restored = await get().restoreWorkDir()

      if (restored) {
        // Load from local directory
        await get().syncClipsFromDir()
      } else {
        // Fallback to IndexedDB
        const [clips, kits] = await Promise.all([listClips(), listKits()])
        set({ clips, kits })
      }
      set({ isLoading: false })
      // Also load built-in index
      get().loadBuiltinIndex()
    } catch (err) {
      console.error('ライブラリの読み込みに失敗:', err)
      set({ isLoading: false })
    }
  },

  loadBuiltinIndex: async () => {
    set({ builtinLoading: true })
    try {
      const res = await fetch('/library/index.json')
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
      const res = await fetch(`/library/clips/${meta.filename}`)
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

  // ---- Work directory actions ----

  pickWorkDir: async () => {
    if (!isFileSystemAccessSupported()) return false
    const handle = await pickWorkDirectory()
    if (!handle) return false
    set({ workDirHandle: handle, workDirName: handle.name })
    // Sync existing clips to the new directory
    await get().syncClipsToDir()
    return true
  },

  restoreWorkDir: async () => {
    if (!isFileSystemAccessSupported()) return false
    const handle = await loadDirectoryHandle()
    if (!handle) return false
    const granted = await verifyPermission(handle, true)
    if (!granted) return false
    set({ workDirHandle: handle, workDirName: handle.name })
    return true
  },

  disconnectWorkDir: async () => {
    await clearDirectoryHandle()
    set({ workDirHandle: null, workDirName: null })
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
      for (const kit of savedKits) await saveKit(kit)
      set({ kits: savedKits })
    } else {
      const kits = await listKits()
      set({ kits })
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

  updateClip: async (id, updates) => {
    await updateClipMeta(id, updates)
    const newClips = get().clips.map((c) =>
      c.id === id ? { ...c, ...updates, updatedAt: new Date().toISOString() } : c
    )
    set({ clips: newClips })
    // Update metadata in work directory
    const { workDirHandle } = get()
    if (workDirHandle) {
      await saveClipsMetaToDir(workDirHandle, newClips)
    }
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

  addEventToKit: async (kitId, event) => {
    const { kits } = get()
    const kit = kits.find((k) => k.id === kitId)
    if (!kit) return
    if (kit.events.some((e) => e.eventId === event.eventId)) return

    const updated = { ...kit, events: [...kit.events, event], updatedAt: new Date().toISOString() }
    await saveKit(updated)
    const newKits = kits.map((k) => (k.id === kitId ? updated : k))
    set({ kits: newKits })
    const { workDirHandle } = get()
    if (workDirHandle) await saveKitsMetaToDir(workDirHandle, newKits)
  },

  removeEventFromKit: async (kitId, eventId) => {
    const { kits } = get()
    const kit = kits.find((k) => k.id === kitId)
    if (!kit) return

    const updated = { ...kit, events: kit.events.filter((e) => e.eventId !== eventId), updatedAt: new Date().toISOString() }
    await saveKit(updated)
    const newKits = kits.map((k) => (k.id === kitId ? updated : k))
    set({ kits: newKits })
    const { workDirHandle } = get()
    if (workDirHandle) await saveKitsMetaToDir(workDirHandle, newKits)
  },

  updateKitEvent: async (kitId, eventId, updates) => {
    const { kits } = get()
    const kit = kits.find((k) => k.id === kitId)
    if (!kit) return

    const updated = {
      ...kit,
      events: kit.events.map((e) => e.eventId === eventId ? { ...e, ...updates } : e),
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
