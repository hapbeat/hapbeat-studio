import { create } from 'zustand'
import type { TrialSceneChoice } from '@/utils/editorUiSettings'
import { useAgentTrialStore } from '@/stores/agentTrialStore'
import type { PendingWavs } from '@/utils/sceneProject'

/**
 * Event-centred authoring (DEC-083) state shared by the editor's Events panel,
 * the AI trials / clip menus ("decide") and the Scene tab ("open in editor"):
 * the selected event (`cue` or `cue:variant` of the project open in sceneStore),
 * the pending "decide" request and the last decision's result.
 */
export type DecideTarget = 'sound' | 'haptic'
export type DecideSource = { kind: 'clip'; clipId: string } | { kind: 'candidate'; trialId: string; candidateId: string }
export interface DecideRequest { target: DecideTarget; source: DecideSource; /** Event key to preselect (null = the selected event / the trial's first cue). */ event: string | null }
/** What a decision replaced: the cue table text and the overwritten WAV bytes (new WAVs are left in place). */
export interface DecisionUndo { tableText: string; wavs: PendingWavs }
export interface DecideResult {
  id: number
  events: string[]
  target: DecideTarget
  name: string
  file: string
  importCommand: string
  /** The WAV already held these bytes (nothing written). */
  reused: boolean
  undo: DecisionUndo | null
  undone: boolean
}
/**
 * An event's sound / haptic clip shown in the waveform panel instead of the editor clip (read only,
 * like an AI audition) and played by the normal playback: haptics go to the devices per "send haptics",
 * a sound plays on the PC only. `buffer` already carries the volume / intensity × gain the game applies.
 */
export interface EventPreview { id: string; event: string; target: DecideTarget; label: string; buffer: AudioBuffer }

interface EventState {
  selected: string | null
  /** Bumped when the editor should bring the Events panel forward (Scene tab "open in editor"). */
  focusRequest: number
  decide: DecideRequest | null
  result: DecideResult | null
  /** Scene video moment picked per event key (this session). */
  scenePicks: Record<string, TrialSceneChoice>
  preview: EventPreview | null
  select: (key: string | null) => void
  /** Shows an event material in the waveform panel (ends an AI audition). */
  showPreview: (preview: EventPreview) => void
  clearPreview: () => void
  pickScene: (key: string, choice: TrialSceneChoice | null) => void
  /** Selects `key`, switches to the editor tab and focuses the Events panel. */
  openInEditor: (key: string) => void
  requestDecide: (request: DecideRequest) => void
  closeDecide: () => void
  setResult: (result: DecideResult | null) => void
}

/** App listens for this and switches tabs (detail = tab id). */
export const OPEN_TAB_EVENT = 'studio:open-tab'

export const useEventStore = create<EventState>((set, get) => ({
  selected: null, focusRequest: 0, decide: null, result: null, scenePicks: {}, preview: null,
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
  requestDecide: decide => set({ decide, result: null }),
  closeDecide: () => set({ decide: null }),
  setResult: result => set({ result }),
}))
