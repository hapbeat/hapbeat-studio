import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

const CloseMenu = createContext<() => void>(() => {})

/**
 * Small dropdown used by the editor top bar, panel "…" menus and clip rows.
 * The list is `position: fixed` from the trigger's rect so dock panels with
 * `overflow: hidden` do not clip it; it works in popped-out windows too
 * because every listener is bound to the trigger's own document.
 */
export function EditorMenu({ label, title, children, className = '', disabled }: { label: ReactNode; title?: string; children: ReactNode; className?: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (!open || !root.current || !list.current) return
    const view = root.current.ownerDocument.defaultView
    const anchor = root.current.getBoundingClientRect(), menu = list.current.getBoundingClientRect()
    const width = view?.innerWidth ?? 0, height = view?.innerHeight ?? 0
    const left = Math.max(4, Math.min(anchor.left, width - menu.width - 4))
    const below = anchor.bottom + 2
    setPosition({ left, top: below + menu.height > height && anchor.top - menu.height - 2 > 0 ? anchor.top - menu.height - 2 : below })
  }, [open])
  useEffect(() => {
    if (!open || !root.current) return
    const doc = root.current.ownerDocument
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false) } }
    const close = () => setOpen(false)
    doc.addEventListener('pointerdown', outside, true)
    doc.addEventListener('keydown', key, true)
    doc.defaultView?.addEventListener('resize', close)
    return () => { doc.removeEventListener('pointerdown', outside, true); doc.removeEventListener('keydown', key, true); doc.defaultView?.removeEventListener('resize', close) }
  }, [open])
  useEffect(() => { if (!open) setPosition(null) }, [open])
  return <div className={`editor-menu ${className}`} ref={root}>
    <button type="button" className="toolbar-btn editor-menu-trigger" title={title} aria-label={title} aria-haspopup="menu" aria-expanded={open} disabled={disabled}
      onClick={() => setOpen(!open)}>{label}</button>
    {open && <div className="editor-menu-list" role="menu" ref={list} style={position ? { top: position.top, left: position.left } : { visibility: 'hidden' }}>
      <CloseMenu.Provider value={() => setOpen(false)}>{children}</CloseMenu.Provider>
    </div>}
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

export function EditorMenuSection({ label, children }: { label: ReactNode; children: ReactNode }) {
  return <div role="group" className="editor-menu-section"><div className="editor-menu-heading">{label}</div>{children}</div>
}
