import { create } from 'zustand'
import type { HapbeatProject, EventDefinition } from '@/types/project'
import type { DisplayLayout } from '@/types/display'
import { saveProject, loadProject } from '@/utils/storage'
import { standardTemplate } from '@/utils/templates'

interface ProjectState {
  /** 現在のプロジェクト */
  project: HapbeatProject | null

  /** 未保存の変更があるか */
  isDirty: boolean

  /** 読み込み中 */
  isLoading: boolean

  // ---- アクション ----
  createProject: (name: string) => void
  loadProjectById: (id: string) => Promise<void>
  saveCurrentProject: () => Promise<void>
  updateDisplayLayout: (layout: DisplayLayout) => void
  addEvent: (event: EventDefinition) => void
  updateEvent: (eventId: string, updates: Partial<EventDefinition>) => void
  deleteEvent: (eventId: string) => void
  setProject: (project: HapbeatProject) => void
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

function createDefaultProject(name: string): HapbeatProject {
  const now = new Date().toISOString()
  return {
    id: generateId(),
    name,
    createdAt: now,
    updatedAt: now,
    displayLayout: structuredClone(standardTemplate.layout),
    events: [],
    ledConfig: {
      idleColor: '#333333',
      idlePattern: 'breathe',
      eventColors: {},
    },
  }
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  project: null,
  isDirty: false,
  isLoading: false,

  createProject: (name: string) => {
    const project = createDefaultProject(name)
    set({ project, isDirty: true, isLoading: false })
  },

  loadProjectById: async (id: string) => {
    set({ isLoading: true })
    try {
      const project = await loadProject(id)
      if (project) {
        set({ project, isDirty: false, isLoading: false })
      } else {
        console.error(`プロジェクト ${id} が見つかりません`)
        set({ isLoading: false })
      }
    } catch (err) {
      console.error('プロジェクトの読み込みに失敗:', err)
      set({ isLoading: false })
    }
  },

  saveCurrentProject: async () => {
    const { project } = get()
    if (!project) return

    const updated = {
      ...project,
      updatedAt: new Date().toISOString(),
    }

    try {
      await saveProject(updated)
      set({ project: updated, isDirty: false })
    } catch (err) {
      console.error('プロジェクトの保存に失敗:', err)
    }
  },

  updateDisplayLayout: (layout: DisplayLayout) => {
    const { project } = get()
    if (!project) return
    set({
      project: { ...project, displayLayout: layout, updatedAt: new Date().toISOString() },
      isDirty: true,
    })
  },

  addEvent: (event: EventDefinition) => {
    const { project } = get()
    if (!project) return
    set({
      project: {
        ...project,
        events: [...project.events, event],
        updatedAt: new Date().toISOString(),
      },
      isDirty: true,
    })
  },

  updateEvent: (eventId: string, updates: Partial<EventDefinition>) => {
    const { project } = get()
    if (!project) return
    set({
      project: {
        ...project,
        events: project.events.map((e) =>
          e.eventId === eventId ? { ...e, ...updates } : e
        ),
        updatedAt: new Date().toISOString(),
      },
      isDirty: true,
    })
  },

  deleteEvent: (eventId: string) => {
    const { project } = get()
    if (!project) return
    set({
      project: {
        ...project,
        events: project.events.filter((e) => e.eventId !== eventId),
        updatedAt: new Date().toISOString(),
      },
      isDirty: true,
    })
  },

  setProject: (project: HapbeatProject) => {
    set({ project, isDirty: false, isLoading: false })
  },
}))
