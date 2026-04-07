import { create } from 'zustand'
import type { LibraryClip, KitDefinition, KitEvent, LibraryFilter } from '@/types/library'
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

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

interface LibraryState {
  // Clip library
  clips: LibraryClip[]
  isLoading: boolean

  // Kit management
  kits: KitDefinition[]
  activeKitId: string | null

  // Filter
  filter: LibraryFilter

  // Clip actions
  loadLibrary: () => Promise<void>
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

  // Kit actions
  createKit: (name: string) => Promise<string>
  removeKit: (id: string) => Promise<void>
  setActiveKit: (id: string | null) => void
  addEventToKit: (kitId: string, event: KitEvent) => Promise<void>
  removeEventFromKit: (kitId: string, eventId: string) => Promise<void>
  updateKitEvent: (kitId: string, eventId: string, updates: Partial<KitEvent>) => Promise<void>
  updateKit: (id: string, updates: Partial<KitDefinition>) => Promise<void>

  // Filter actions
  setFilter: (filter: Partial<LibraryFilter>) => void
  resetFilter: () => void

  // Computed
  filteredClips: () => LibraryClip[]
  allTags: () => string[]
  allGroups: () => string[]
}

const DEFAULT_FILTER: LibraryFilter = {
  searchQuery: '',
  selectedTags: [],
  selectedGroup: null,
  sortBy: 'date',
  sortOrder: 'desc',
}

export const useLibraryStore = create<LibraryState>((set, get) => ({
  clips: [],
  isLoading: false,
  kits: [],
  activeKitId: null,
  filter: { ...DEFAULT_FILTER },

  loadLibrary: async () => {
    set({ isLoading: true })
    try {
      const [clips, kits] = await Promise.all([listClips(), listKits()])
      set({ clips, kits, isLoading: false })
    } catch (err) {
      console.error('ライブラリの読み込みに失敗:', err)
      set({ isLoading: false })
    }
  },

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
    set((state) => ({ clips: [clip, ...state.clips] }))
    return clip.id
  },

  addClipFromFile: async (file) => {
    const arrayBuffer = await file.arrayBuffer()
    const ctx = new AudioContext()
    const buffer = await ctx.decodeAudioData(arrayBuffer)
    const blob = new Blob([arrayBuffer], { type: file.type || 'audio/wav' })
    const now = new Date().toISOString()
    const name = file.name.replace(/\.(wav|mp3|ogg|flac|aac|m4a)$/i, '')
    const clip: LibraryClip = {
      id: generateId(),
      name,
      tags: [],
      group: '',
      eventId: '',
      duration: buffer.duration,
      channels: buffer.numberOfChannels,
      sampleRate: buffer.sampleRate,
      fileSize: file.size,
      sourceFilename: file.name,
      createdAt: now,
      updatedAt: now,
    }
    await saveClip(clip, blob)
    set((state) => ({ clips: [clip, ...state.clips] }))
    return clip.id
  },

  removeClip: async (id) => {
    await deleteClip(id)
    set((state) => ({ clips: state.clips.filter((c) => c.id !== id) }))
  },

  updateClip: async (id, updates) => {
    await updateClipMeta(id, updates)
    set((state) => ({
      clips: state.clips.map((c) =>
        c.id === id ? { ...c, ...updates, updatedAt: new Date().toISOString() } : c
      ),
    }))
  },

  getClipAudio: async (id) => {
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
    set((state) => ({ kits: [...state.kits, kit], activeKitId: kit.id }))
    return kit.id
  },

  removeKit: async (id) => {
    await deleteKit(id)
    set((state) => ({
      kits: state.kits.filter((k) => k.id !== id),
      activeKitId: state.activeKitId === id ? null : state.activeKitId,
    }))
  },

  setActiveKit: (id) => {
    set({ activeKitId: id })
  },

  addEventToKit: async (kitId, event) => {
    const { kits } = get()
    const kit = kits.find((k) => k.id === kitId)
    if (!kit) return
    if (kit.events.some((e) => e.eventId === event.eventId)) return

    const updated = {
      ...kit,
      events: [...kit.events, event],
      updatedAt: new Date().toISOString(),
    }
    await saveKit(updated)
    set((state) => ({
      kits: state.kits.map((k) => (k.id === kitId ? updated : k)),
    }))
  },

  removeEventFromKit: async (kitId, eventId) => {
    const { kits } = get()
    const kit = kits.find((k) => k.id === kitId)
    if (!kit) return

    const updated = {
      ...kit,
      events: kit.events.filter((e) => e.eventId !== eventId),
      updatedAt: new Date().toISOString(),
    }
    await saveKit(updated)
    set((state) => ({
      kits: state.kits.map((k) => (k.id === kitId ? updated : k)),
    }))
  },

  updateKitEvent: async (kitId, eventId, updates) => {
    const { kits } = get()
    const kit = kits.find((k) => k.id === kitId)
    if (!kit) return

    const updated = {
      ...kit,
      events: kit.events.map((e) =>
        e.eventId === eventId ? { ...e, ...updates } : e
      ),
      updatedAt: new Date().toISOString(),
    }
    await saveKit(updated)
    set((state) => ({
      kits: state.kits.map((k) => (k.id === kitId ? updated : k)),
    }))
  },

  updateKit: async (id, updates) => {
    const { kits } = get()
    const kit = kits.find((k) => k.id === id)
    if (!kit) return

    const updated = { ...kit, ...updates, updatedAt: new Date().toISOString() }
    await saveKit(updated)
    set((state) => ({
      kits: state.kits.map((k) => (k.id === id ? updated : k)),
    }))
  },

  // Filter
  setFilter: (partial) => {
    set((state) => ({ filter: { ...state.filter, ...partial } }))
  },

  resetFilter: () => {
    set({ filter: { ...DEFAULT_FILTER } })
  },

  // Computed
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
}))
