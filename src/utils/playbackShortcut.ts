/** Input types that take no typed text: Space / shortcuts still work while they have focus. */
const NON_TEXT_INPUTS = new Set(['button', 'checkbox', 'radio', 'range', 'color', 'file', 'submit', 'reset', 'image'])

/**
 * Focus where the user types (text-like inputs, textareas, selects, contenteditable):
 * every Studio shortcut (Space playback in the editor / Scene video / Scene tab, the
 * editor's and Scene tab's keys) is off there, so typing a comment never plays audio.
 */
export function isTypingTarget(target: EventTarget | null | undefined): boolean {
  const el = target as (Partial<HTMLElement> & { type?: string }) | null | undefined
  if (!el || typeof el.tagName !== 'string') return false
  if (el.isContentEditable) return true
  const tag = el.tagName.toUpperCase()
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag === 'INPUT') return !NON_TEXT_INPUTS.has(String(el.type ?? 'text').toLowerCase())
  return typeof el.closest === 'function' && !!el.closest('textarea, select, [contenteditable]:not([contenteditable="false"])')
}

export function handlePlaybackShortcut(event: KeyboardEvent, tab: string, dispatch: (event: Event) => void) {
  if (event.code !== 'Space' || event.isComposing || isTypingTarget(event.target)) return
  const target = tab === 'editor' || tab === 'scene' ? tab : tab === 'kit' || tab === 'devices' ? 'kit' : null
  if (!target) return
  // Capture before focused buttons and hidden panels can consume Space.
  event.preventDefault(); event.stopImmediatePropagation()
  if (!event.repeat) dispatch(new Event(`studio:${target}-playback`))
}
