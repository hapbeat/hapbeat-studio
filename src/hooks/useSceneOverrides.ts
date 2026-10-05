import { useEffect } from 'react'
import { useSceneStore } from '@/stores/sceneStore'
import { useWaveformStore } from '@/stores/waveformStore'
import { overridesFromMessages, readOutboxMessages, readOverrides, resolvedOverrides, writeOverrides, type SceneOverride } from '@/utils/sceneOverrides'

/**
 * Loads the open game project's firing overrides (scene-overrides/<project>.json in the editor folder) into the
 * Scene store once both are open. A project without the file starts from the requests already sent (outbox
 * `reassign`, read or not). Overrides the recording now plays as wished (re-recorded) are dropped and the file saved.
 */
export function useSceneOverrides() {
  const project = useSceneStore(s => s.lib?.project_name ?? null)
  const recorded = useSceneStore(s => s.recorded)
  const root = useWaveformStore(s => s.folder?.root ?? null)
  useEffect(() => {
    if (!project || !root || !recorded) return
    let cancelled = false
    void (async () => {
      let list = await readOverrides(root, project)
      const seeded = list === null
      if (list === null) list = overridesFromMessages(await readOutboxMessages(root), project)
      const done = resolvedOverrides(recorded, list)
      const kept = list.filter(o => !done.includes(o))
      if (cancelled) return
      useSceneStore.getState().setOverrides(kept)
      if (seeded ? kept.length > 0 : done.length > 0) await writeOverrides(root, project, kept)
    })().catch(error => console.warn('[scene] overrides not loaded', error))
    return () => { cancelled = true }
  }, [project, root, recorded])
}

/** Saves `next` for the open project (the editor folder must be open) and applies it. */
export async function saveSceneOverrides(next: SceneOverride[]): Promise<void> {
  const project = useSceneStore.getState().lib?.project_name, root = useWaveformStore.getState().folder?.root
  if (!project || !root) throw new Error('No editor folder is open')
  await writeOverrides(root, project, next)
  useSceneStore.getState().setOverrides(next)
}
