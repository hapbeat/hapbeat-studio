type Listening = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>

/**
 * Runs `save` whenever the page may go away without another chance to write: unload (reload, close,
 * navigation: `beforeunload` / `pagehide`) and the tab being hidden. React effect cleanups do not run on
 * unload, so pending input (debounced writes, a slider's delayed commit) is saved here. Returns the unsubscribe.
 */
export function onPageHide(save: () => void, win: Listening = window, doc: Listening & { visibilityState: DocumentVisibilityState } = document): () => void {
  const hidden = () => { if (doc.visibilityState === 'hidden') save() }
  win.addEventListener('beforeunload', save)
  win.addEventListener('pagehide', save)
  doc.addEventListener('visibilitychange', hidden)
  return () => {
    win.removeEventListener('beforeunload', save)
    win.removeEventListener('pagehide', save)
    doc.removeEventListener('visibilitychange', hidden)
  }
}
