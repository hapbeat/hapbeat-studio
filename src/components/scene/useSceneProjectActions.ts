import { useSceneStore } from '@/stores/sceneStore'
import { useScene } from './sceneContext'

/** Open / reopen the project, asking first when unsaved cue-table edits would be dropped. */
export function useSceneProjectActions() {
  const { confirmDiscard } = useScene()
  const dirty = useSceneStore(s => s.dirty)
  const busy = useSceneStore(s => s.busy)
  const root = useSceneStore(s => s.root)
  const remembered = useSceneStore(s => s.remembered)
  const open = async () => { if (dirty && !await confirmDiscard()) return; await useSceneStore.getState().pick() }
  const reopen = async () => { if (dirty && !await confirmDiscard()) return; await useSceneStore.getState().reconnect() }
  /** The remembered folder's name while it is not the open one (the "reopen last" entry). */
  const rememberedName = remembered && remembered !== root ? remembered.name : null
  return { open, reopen, rememberedName, busy }
}
