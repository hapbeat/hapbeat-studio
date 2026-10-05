import { createContext, useContext } from 'react'
import type { EditorPlayback } from '@/utils/editorPlayback'
import type { EditorBufferPlayer } from '@/utils/editorBufferPlayer'
import type { Recipe } from '@/utils/recipe'
import type { DeviceInfo } from '@/types/manager'
import type { WaveformClip } from '@/types/waveform'
import type { SceneVideoTarget } from '@/utils/editorSceneSync'

/** State the editor owns and every dock panel reads (panels render in dockview portals / popout windows). */
export interface EditorShared {
  active: boolean
  original: boolean
  setOriginal: (value: boolean) => void
  /** The effect chain has changes not yet rendered into the clip; "Edited" then shows `preview`. */
  pendingChain: boolean
  preview: { status: 'idle' | 'rendering' | 'ready' | 'error'; error: string }
  /** `trialId/candidateId` of the AI candidate shown instead of the clip, if any. */
  auditionKey: string | null
  audioBuffer: AudioBuffer | undefined
  player: EditorBufferPlayer
  playback: EditorPlayback
  pending: boolean
  /** Play / stop; stopping rewinds. Shared by the transport button and Space. */
  togglePlay: () => void
  /** Plays from `time` (a plain click on the waveform): the start marker moves there, any range is cleared. */
  playAt: (time: number) => void
  /** Stops playback (back to the start marker / range start). */
  stopPlayback: () => void
  /** True while playing or starting to play. */
  isPlaybackActive: () => boolean
  /** ⏮ / double click: from the range start, else 0. `once`: the whole audio from 0, a single pass even with loop on (Scene video click). */
  playFromStart: (once?: boolean) => void
  /** Candidate card ▶ / Space on a card: auditions the candidate and plays it (normal path), or stops it when it is the one playing. */
  toggleCandidate: (trialId: string, candidateId: string) => void
  /** Opens the recipe dialog in `doc` (main page or a popped-out window). */
  openRecipe: (doc: Document, initial?: Recipe) => void
  provenanceText: (clip: WaveformClip) => string
  isConnected: boolean
  /** Connected playback devices (same rule as Kit deploy); used for rating device suggestions. */
  playbackDevices: DeviceInfo[]
  /** Resolved haptic target IPs for playback. */
  targets: string[]
  /** How they were chosen: the cue's positions (null = no cue: as selected), the devices, and those left out for having no position. */
  routing: { devices: DeviceInfo[]; unknown: DeviceInfo[]; positions: string[] | null }
  /** Clips in the order the clip list shows them (↑↓ navigation follows it). */
  setVisibleClipIds: (ids: string[]) => void
  /** "▶ Video": shows the Scene video panel for the target in its own window, linking the Scene project `project` first if needed. Call from a click. */
  openSceneVideo: (target: SceneVideoTarget, project: string | null) => void
  /** Links the Scene project `name` through the registry (permission / one-time folder pick). Call from a click or a select change. */
  linkSceneProject: (name: string | null, options?: { quietIfRefused?: boolean }) => Promise<boolean>
  /** Shows a dock panel (re-adding it if closed) and brings its tab to the front. */
  focusEditorPanel: (id: 'clips' | 'events' | 'waveform' | 'properties' | 'effects' | 'agent' | 'scene') => void
}

export const EditorContext = createContext<EditorShared | null>(null)
export function useEditor(): EditorShared {
  const value = useContext(EditorContext)
  if (!value) throw new Error('useEditor must be used inside WaveformEditor')
  return value
}
