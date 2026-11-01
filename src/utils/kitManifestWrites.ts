/**
 * "A Kit manifest was just written" (the editor's Save Folder / Deploy build, libraryStore.flushKitFolderNow), by Kit
 * id (its folder name). The Scene tab reads its project's Kit again on it, so a clip gain changed in the editor reaches
 * the Scene without touching the cue table (DEC-103, contracts cue-table §9.1). Kept apart from both stores so neither
 * imports the other.
 */
type Listener = (kitId: string) => void
const listeners = new Set<Listener>()

/** Calls `listener` after every Kit manifest write; returns the unsubscribe. */
export function onKitManifestWritten(listener: Listener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function notifyKitManifestWritten(kitId: string): void {
  for (const listener of [...listeners]) listener(kitId)
}
