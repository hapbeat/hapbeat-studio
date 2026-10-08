import { useMemo } from 'react'
import { useEditorSettings } from '@/stores/editorSettings'
import { useSceneStore } from '@/stores/sceneStore'
import { simultaneousGroups } from '@/utils/cueEvents'
import { applyGroupEdits } from '@/utils/eventGroups'

/**
 * The open Scene project's 「同時」 groups: the cues the recording fires at the same moment (simultaneousGroups) with the
 * user's edits applied (editor setting per project). The Events panel shows them; an audition of one member plays the
 * others as its context.
 */
export function useEventGroups(): string[][] {
  const table = useSceneStore(s => s.table)
  const lib = useSceneStore(s => s.lib)
  const data = useSceneStore(s => s.data)
  const edits = useEditorSettings(s => lib ? s.eventGroupEdits[lib.project_name] : undefined)
  // The cue names only: a strength edit rewrites the table but not its cues' order.
  const order = useMemo(() => table ? Object.keys(table.cues) : [], [table?.cues])
  return useMemo(() => table && lib && data ? applyGroupEdits(simultaneousGroups(table, data.clips, lib.ticks), edits, order) : [], [order, lib, data, edits])
}
