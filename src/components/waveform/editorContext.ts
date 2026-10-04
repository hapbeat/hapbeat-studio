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
  /** Opens the recipe dialog in `doc` (main page or a popped-out window). */
  openRecipe: (doc: Document, initial?: Recipe) => void
  provenanceText: (clip: WaveformClip) => string
  isConnected: boolean
  /** Connected playback devices (same rule as Kit deploy); used for rating device suggestions. */
  playbackDevices: DeviceInfo[]
  /** Resolved haptic target IPs for playback. */
  targets: string[]
  /** Clips in the order the clip list shows them (↑↓ navigation follows it). */
  setVisibleClipIds: (ids: string[]) => void
  /** "▶ Video": shows the Scene video panel for the target in its own window, linking the Scene project `project` first if needed. Call from a click. */
  openSceneVideo: (target: SceneVideoTarget, project: string | null) => void
  /** Links the Scene project `name` through the registry (permission / one-time folder pick). Call from a click or a select change. */
  linkSceneProject: (name: string | null, options?: { quietIfRefused?: boolean }) => Promise<boolean>
}

export const EditorContext = createContext<EditorShared | null>(null)
export function useEditor(): EditorShared {
  const value = useContext(EditorContext)
  if (!value) throw new Error('useEditor must be used inside WaveformEditor')
  return value
}
