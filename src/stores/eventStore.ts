import { create } from 'zustand'
import type { TrialSceneChoice } from '@/utils/editorUiSettings'
import { useAgentTrialStore } from '@/stores/agentTrialStore'
import { eventKey, resolveEventName } from '@/utils/cueEvents'
import type { CueTable } from '@/utils/sceneCueTable'

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
  /**
   * Opened from the Scene tab (「エディタで開く」 / O): shown and played as the plain file — its own length, no scene stretch,
   * no firings sequence, no scene sounds, no post-roll — until another material / event is shown, the same material is
   * picked again in the Events panel, or the Scene video is asked for (▶ Video).
   */
  plain?: boolean
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
  /** Bumped when the editor should bring the Events / Event detail panels forward (Scene tab "open in editor"); consumed once. */
  focusRequest: number
  decide: DecideRequest | null
  /** Scene video moment picked per event key (this session). */
  scenePicks: Record<string, TrialSceneChoice>
  preview: EventPreview | null
  /** The strength slider being moved: applied to the playback gain and the drawing at once, saved debounced. */
  liveLevel: LiveLevel | null
  setLiveLevel: (level: LiveLevel | null) => void
  /** Strengths kept outside the cue table by `levelKey`: the AI candidates' rating form values (unsaved ones too). */
  levels: Record<string, number>
  setLevels: (levels: Record<string, number>) => void
  select: (key: string | null) => void
  /** Shows an event material in the waveform panel (ends an AI audition). */
  showPreview: (preview: EventPreview) => void
  clearPreview: () => void
  pickScene: (key: string, choice: TrialSceneChoice | null) => void
  /** Selects `key`, switches to the editor tab and focuses the Events / Event detail panels. */
  openInEditor: (key: string) => void
  /** The event whose firings the Scene tab lists (DEC-085: every moment of an event is checked there). */
  sceneOccurrences: string | null
  /** Lists event `key`'s firings in the Scene tab and switches to it. */
  openInScene: (key: string | null) => void
  requestDecide: (request: DecideRequest) => void
  closeDecide: () => void
}

/**
 * Selects event `key` in the Events / Event detail panels and brings both forward (`focus` = the editor's
 * focusEditorPanel: re-adds a closed panel, fronts its tab). The list scrolls its row into view.
 */
export function revealEvent(key: string, focus: (id: 'events' | 'eventDetail') => void) {
  useEventStore.getState().select(key)
  focus('events')
  focus('eventDetail')
}

/**
 * Scene tab 「エディタで開く」 (button / O key): opens the event selected in the Scene event panel (a variant as
 * `cue:variant`; `table` / `sel` = sceneStore's) in the editor. Returns its key (null: no event selected).
 */
export function openSceneSelectionInEditor(table: CueTable | null, sel: { name: string } | null): string | null {
  const resolved = table && sel ? resolveEventName(table, sel.name) : null
  if (!resolved) return null
  const key = eventKey(resolved.ref)
  useEventStore.getState().openInEditor(key)
  return key
}

/** App listens for this and switches tabs (detail = tab id). */
export const OPEN_TAB_EVENT = 'studio:open-tab'

export const useEventStore = create<EventState>((set, get) => ({
  selected: null, focusRequest: 0, decide: null, scenePicks: {}, preview: null, liveLevel: null, sceneOccurrences: null,
  setLiveLevel: liveLevel => set({ liveLevel }),
  levels: {},
  setLevels: levels => { const s = get().levels; if (Object.entries(levels).some(([k, v]) => s[k] !== v)) set({ levels: { ...s, ...levels } }) },
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
