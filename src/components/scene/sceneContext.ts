import { createContext, useContext } from 'react'
import type { SceneRuntime } from './sceneRuntime'
import type { HapticDevice } from '@/utils/sceneHaptics'

/** What every Scene dock panel reads besides the stores (panels render in dockview portals). */
export interface SceneShared {
  runtime: SceneRuntime
  active: boolean
  helperConnected: boolean
  /** Selected (shared Kit selection), online playback devices with an address. */
  devices: HapticDevice[]
  /** Asks before unsaved cue-table edits are dropped; true = go ahead. */
  confirmDiscard: () => Promise<boolean>
  /** Opens a file picker for one WAV. */
}

export const SceneContext = createContext<SceneShared | null>(null)
export function useScene(): SceneShared {
  const value = useContext(SceneContext)
  if (!value) throw new Error('useScene must be used inside SceneView')
  return value
}
