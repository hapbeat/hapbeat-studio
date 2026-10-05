import { create } from 'zustand'
import type { TrialSceneChoice } from '@/utils/editorUiSettings'
import { useAgentTrialStore } from '@/stores/agentTrialStore'

/**
 * Event-centred authoring (DEC-083) state shared by the editor's Events panel,
 * the AI trials / clip menus ("decide") and the Scene tab ("open in editor"):
 * the selected event (`cue` or `cue:variant` of the project open in sceneStore),
 * the pending "decide" request and the last decision's result.
 */
export type DecideTarget = 'sound' | 'haptic'
export type DecideSource = { kind: 'clip'; clipId: string } | { kind: 'candidate'; trialId: string; candidateId: string }
export interface DecideRequest { target: DecideTarget; source: DecideSource; /** Event key to preselect (null = the selected event / the trial's first cue). */ event: string | null }
export interface DecideResult {
  id: number
  events: string[]
  target: DecideTarget
  name: string
  file: string
  importCommand: string
  /** The WAV already held these bytes (nothing written). */
  reused: boolean
}
/**
 * An event's sound / haptic clip shown in the waveform panel instead of the editor clip (read only,
 * like an AI audition) and played by the normal playback: haptics go to the devices per "send haptics",
 * a sound plays on the PC only.
 */
export interface EventPreview {
  id: string; event: string; target: DecideTarget; label: string
  /** The material (WAV name without .wav). */
  material: string
  /** The WAV as it is (a loop cue's repeated); its intensity is a playback gain and a drawing scale (DEC-086), never baked in. */
  buffer: AudioBuffer
  /** Play it from the start as soon as it is shown (▶ on a material). */
  autoplay?: boolean
  /** Bumped by ▶ on the material already shown: plays it again without reopening it. */
  playRequest?: number
}

/** A strength slider while it moves, before its value is saved (`key`: see `levelKey`). */
export interface LiveLevel { key: string; value: number }
/** Whose strength a slider sets: an event material (cue table intensity) or an AI candidate (its rating). */
export const levelKey = {
  material: (target: DecideTarget, wav: string) => `material:${target}:${wav}`,
  candidate: (trialId: string, candidateId: string) => `candidate:${trialId}/${candidateId}`,
}

interface EventState {
  selected: string | null
  /** Bumped when the editor should bring the Events panel forward (Scene tab "open in editor"). */
  focusRequest: number
  decide: DecideRequest | null
  /** Scene video moment picked per event key (this session). */
  scenePicks: Record<string, TrialSceneChoice>
  preview: EventPreview | null
  /** The strength slider being moved: applied to the playback gain and the drawing at once, saved debounced. */
  liveLevel: LiveLevel | null
  setLiveLevel: (level: LiveLevel | null) => void
  select: (key: string | null) => void
  /** Shows an event material in the waveform panel (ends an AI audition). */
  showPreview: (preview: EventPreview) => void
  clearPreview: () => void
  pickScene: (key: string, choice: TrialSceneChoice | null) => void
  /** Selects `key`, switches to the editor tab and focuses the Events panel. */
  openInEditor: (key: string) => void
  /** The event whose firings the Scene tab lists (DEC-085: every moment of an event is checked there). */
  sceneOccurrences: string | null
  /** Lists event `key`'s firings in the Scene tab and switches to it. */
  openInScene: (key: string | null) => void
  requestDecide: (request: DecideRequest) => void
  closeDecide: () => void
}

/** App listens for this and switches tabs (detail = tab id). */
export const OPEN_TAB_EVENT = 'studio:open-tab'

export const useEventStore = create<EventState>((set, get) => ({
  selected: null, focusRequest: 0, decide: null, scenePicks: {}, preview: null, liveLevel: null, sceneOccurrences: null,
  setLiveLevel: liveLevel => set({ liveLevel }),
  openInScene: key => {
    set({ sceneOccurrences: key })
    if (key) window.dispatchEvent(new CustomEvent(OPEN_TAB_EVENT, { detail: 'scene' }))
  },
  select: selected => set({ selected }),
  showPreview: preview => { useAgentTrialStore.getState().clearAudition(); set({ preview }) },
  clearPreview: () => { if (get().preview) set({ preview: null }) },
  pickScene: (key, choice) => set(s => {
    const scenePicks = { ...s.scenePicks }
    if (choice) scenePicks[key] = choice; else delete scenePicks[key]
    return { scenePicks }
  }),
  openInEditor: key => {
    set({ selected: key, focusRequest: get().focusRequest + 1 })
    window.dispatchEvent(new CustomEvent(OPEN_TAB_EVENT, { detail: 'editor' }))
  },
  requestDecide: decide => set({ decide }),
  closeDecide: () => set({ decide: null }),
}))
