import { createContext, useContext } from 'react'
import type { EditorPlayback } from '@/utils/editorPlayback'
import type { EditorBufferPlayer } from '@/utils/editorBufferPlayer'
import type { Recipe } from '@/utils/recipe'
import type { DeviceInfo } from '@/types/manager'
import type { WaveformClip } from '@/types/waveform'

/** State the editor owns and every dock panel reads (panels render in dockview portals / popout windows). */
export interface EditorShared {
  active: boolean
  original: boolean
  setOriginal: (value: boolean) => void
  previewEnabled: boolean
  setPreviewEnabled: (value: boolean) => void
  preview: { status: 'idle' | 'rendering' | 'ready' | 'error'; error: string }
  /** `trialId/candidateId` of the AI candidate shown instead of the clip, if any. */
  auditionKey: string | null
  audioBuffer: AudioBuffer | undefined
  player: EditorBufferPlayer
  playback: EditorPlayback
  pending: boolean
  /** Opens the recipe dialog in `doc` (main page or a popped-out window). */
  openRecipe: (doc: Document, initial?: Recipe) => void
  provenanceText: (clip: WaveformClip) => string
  isConnected: boolean
  /** Connected playback devices (same rule as Kit deploy). */
  playbackDevices: DeviceInfo[]
  /** Resolved haptic target IPs for playback. */
  targets: string[]
  /** Clips in the order the clip list shows them (↑↓ navigation follows it). */
  setVisibleClipIds: (ids: string[]) => void
}

export const EditorContext = createContext<EditorShared | null>(null)
export function useEditor(): EditorShared {
  const value = useContext(EditorContext)
  if (!value) throw new Error('useEditor must be used inside WaveformEditor')
  return value
}
