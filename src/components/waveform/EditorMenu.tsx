import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { placeMenu, type MenuPlacement } from '@/utils/menuPlacement'

const CloseMenu = createContext<() => void>(() => {})

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

/**
 * A menu's popup (editor menus, right-click menus), in a portal on the anchor's own document body with
 * `position: fixed`, so neither a dock panel's `overflow: hidden` nor a containing block made by a
 * transform / `contain` clips it (popped-out windows get it in their own body). It opens under the anchor
 * (or at the pointer `at`) and stays inside the window: flipped up / left, the height capped with internal
 * scroll when neither side has room (placeMenu). Pointer-down outside the popup and the anchor, Escape and a
 * window resize close it (at the pointer, a pointer-down on the anchor too); Escape and Tab past either end
 * hand the focus back to `returnFocus`.
 */
export function MenuPopup({ anchor, at, returnFocus, listRef, onClose, className, role = 'menu', children }: {
  anchor: RefObject<HTMLElement>; at?: { x: number; y: number }; returnFocus?: RefObject<HTMLElement>
  /** The popup element, for the owner (e.g. to move the focus into it). */
  listRef?: RefObject<HTMLDivElement>
  onClose: () => void; className: string; role?: string; children: ReactNode
}) {
  const ownList = useRef<HTMLDivElement>(null)
  const list = listRef ?? ownList
  const [placement, setPlacement] = useState<MenuPlacement | null>(null)
  const close = useRef(onClose); close.current = onClose
  const pointer = useRef(!!at); pointer.current = !!at
  useLayoutEffect(() => {
    const el = list.current, anchorEl = anchor.current
    if (!el || !anchorEl) return
    const view = anchorEl.ownerDocument.defaultView
    const rect = at ? { left: at.x, right: at.x, top: at.y, bottom: at.y } : anchorEl.getBoundingClientRect()
    // The natural height (the stylesheet's max-height may already cap the box).
    const box = el.getBoundingClientRect(), height = Math.max(box.height, el.scrollHeight + el.offsetHeight - el.clientHeight)
    setPlacement(placeMenu(rect, { width: box.width, height }, { width: view?.innerWidth ?? 0, height: view?.innerHeight ?? 0 }, at ? 0 : 2))
  }, [anchor, at?.x, at?.y])
  useEffect(() => {
    const anchorEl = anchor.current
    if (!anchorEl) return
    const doc = anchorEl.ownerDocument
    const outside = (event: PointerEvent) => {
      const target = event.target as Node
      // At the pointer (a right-click menu) any pointer-down outside the popup closes it, on the anchor too.
      if ((pointer.current || !anchor.current?.contains(target)) && !list.current?.contains(target)) close.current()
    }
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      if (list.current?.contains(doc.activeElement)) returnFocus?.current?.focus()
      close.current()
    }
    const resize = () => close.current()
    doc.addEventListener('pointerdown', outside, true)
    doc.addEventListener('keydown', key, true)
    doc.defaultView?.addEventListener('resize', resize)
    return () => { doc.removeEventListener('pointerdown', outside, true); doc.removeEventListener('keydown', key, true); doc.defaultView?.removeEventListener('resize', resize) }
  }, [anchor, returnFocus])
  // The popup is outside the trigger in the DOM: Tab past its last item (or Shift+Tab before its first) returns to the trigger.
  const tab = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab' || !returnFocus?.current || !list.current) return
    const items = [...list.current.querySelectorAll<HTMLElement>(FOCUSABLE)]
    const edge = event.shiftKey ? items[0] : items[items.length - 1]
    if (items.length && event.target !== edge) return
    event.preventDefault()
    returnFocus.current.focus()
    if (!event.shiftKey) close.current()
  }
  const body = anchor.current?.ownerDocument.body
  if (!body) return null
  const style = placement ? { top: placement.top, left: placement.left, maxHeight: placement.maxHeight } : { visibility: 'hidden' as const }
  return createPortal(<div className={className} role={role} ref={list} style={style} onKeyDown={tab}>{children}</div>, body)
}

/**
 * Small dropdown used by the editor top bar, panel "…" menus and clip rows. The list is a MenuPopup
 * (portal, `position: fixed`, kept in the window); it works in popped-out windows too because every
 * listener is bound to the trigger's own document.
 */
export function EditorMenu({ label, title, children, className = '', disabled }: { label: ReactNode; title?: string; children: ReactNode; className?: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  return <div className={`editor-menu ${className}`} ref={root}>
    <button type="button" className="toolbar-btn editor-menu-trigger" title={title} aria-label={title} aria-haspopup="menu" aria-expanded={open} disabled={disabled} ref={trigger}
      onClick={() => setOpen(!open)}
      onKeyDown={event => {
        // Tab from the open menu's trigger goes into the menu (it is at the end of the body in the DOM).
        if (!open || event.key !== 'Tab' || event.shiftKey) return
        const first = list.current?.querySelector<HTMLElement>(FOCUSABLE)
        if (first) { event.preventDefault(); first.focus() }
      }}>{label}</button>
    {open && <MenuPopup anchor={root} returnFocus={trigger} listRef={list} onClose={() => setOpen(false)} className="editor-menu-list">
      <CloseMenu.Provider value={() => setOpen(false)}>{children}</CloseMenu.Provider>
    </MenuPopup>}
  </div>
}

/** `onSelect` receives the document the item lives in (main page or a popped-out window). */
export function EditorMenuItem({ onSelect, disabled, checked, children, keepOpen }: { onSelect: (doc: Document) => void; disabled?: boolean; checked?: boolean; children: ReactNode; keepOpen?: boolean }) {
  const close = useContext(CloseMenu)
  return <button type="button" role={checked === undefined ? 'menuitem' : 'menuitemcheckbox'} aria-checked={checked} className="editor-menu-item" disabled={disabled}
    onClick={event => { const doc = event.currentTarget.ownerDocument; if (!keepOpen) close(); onSelect(doc) }}>
    <span className="editor-menu-check" aria-hidden="true">{checked ? '✓' : ''}</span>{children}
  </button>
}

/** Closes the enclosing menu (for custom content such as a text field committed with Enter). */
export const useCloseEditorMenu = () => useContext(CloseMenu)

export function EditorMenuSection({ label, children }: { label: ReactNode; children: ReactNode }) {
  return <div role="group" className="editor-menu-section"><div className="editor-menu-heading">{label}</div>{children}</div>
}
