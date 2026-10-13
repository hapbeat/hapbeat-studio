import { useLibraryStore } from '@/stores/libraryStore'

/**
 * Ratings saved with "Save and next" whose background work (rating.json, the knowledge files and the trial cache, the
 * audio tidy, event materials, reserves, log) has not finished. Shown in the log footer's save pill (LocalFsStatus,
 * which the Kit's saves drive too: whichever wrote last shows), and the editor asks before the page closes or reloads
 * while any is left.
 */
let inFlight = 0
/** The texts of the latest save started: the footer names the newest rating while others are still being written. */
let latest: RatingSaveTexts | null = null
export const ratingSavesInFlight = () => inFlight

/** Footer texts of one save: `progress(left)` while saves are left, `done` when the last one ends, `failed(message)`. */
export interface RatingSaveTexts { progress: (left: number) => string; done: string; failed: (message: string) => string }

/** Starts tracking one save; call the returned function once its work is over (ok, or the failure to show). */
export function trackRatingSave(texts: RatingSaveTexts): (failure?: string) => void {
  inFlight++
  latest = texts
  useLibraryStore.getState().setLocalFsStatus('saving', texts.progress(inFlight))
  let ended = false
  return failure => {
    if (ended) return
    ended = true
    inFlight = Math.max(0, inFlight - 1)
    const now = latest ?? texts
    if (failure !== undefined) useLibraryStore.getState().setLocalFsStatus('error', texts.failed(failure))
    else if (inFlight > 0) useLibraryStore.getState().setLocalFsStatus('saving', now.progress(inFlight))
    else useLibraryStore.getState().setLocalFsStatus('saved', now.done)
  }
}
