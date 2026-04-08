import { useState, useEffect, useCallback, createContext, useContext, useRef } from 'react'
import { createPortal } from 'react-dom'
import './Toast.css'

type ToastType = 'success' | 'error' | 'info'

interface ToastItem {
  id: number
  message: string
  type: ToastType
  anchorRect: DOMRect | null
}

interface ToastContextValue {
  toast: (message: string, type?: ToastType) => void
  /** Set an anchor element — toasts appear near it */
  setAnchor: (el: HTMLElement | null) => void
}

const ToastContext = createContext<ToastContextValue>({ toast: () => {}, setAnchor: () => {} })

export function useToast() {
  return useContext(ToastContext)
}

let nextId = 0

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const anchorRef = useRef<HTMLElement | null>(null)

  const setAnchor = useCallback((el: HTMLElement | null) => {
    anchorRef.current = el
  }, [])

  const toast = useCallback((message: string, type: ToastType = 'info') => {
    const id = nextId++
    const anchorRect = anchorRef.current?.getBoundingClientRect() ?? null
    setItems((prev) => [...prev, { id, message, type, anchorRect }])
  }, [])

  const remove = useCallback((id: number) => {
    setItems((prev) => prev.filter((t) => t.id !== id))
  }, [])

  return (
    <ToastContext.Provider value={{ toast, setAnchor }}>
      {children}
      {createPortal(
        <>
          {items.map((item) => (
            <ToastNotification key={item.id} item={item} onRemove={remove} />
          ))}
        </>,
        document.body
      )}
    </ToastContext.Provider>
  )
}

function ToastNotification({ item, onRemove }: { item: ToastItem; onRemove: (id: number) => void }) {
  const [exiting, setExiting] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const duration = item.type === 'error' ? 5000 : 3000
    const timer = setTimeout(() => setExiting(true), duration)
    return () => clearTimeout(timer)
  }, [item.type])

  useEffect(() => {
    if (!exiting) return
    const timer = setTimeout(() => onRemove(item.id), 300)
    return () => clearTimeout(timer)
  }, [exiting, item.id, onRemove])

  // Position near anchor or top-center
  const style: React.CSSProperties = {}
  if (item.anchorRect) {
    const r = item.anchorRect
    style.position = 'fixed'
    style.top = r.bottom + 8
    style.left = r.left + r.width / 2
    style.transform = 'translateX(-50%)'
  } else {
    style.position = 'fixed'
    style.top = 60
    style.left = '50%'
    style.transform = 'translateX(-50%)'
  }

  return (
    <div
      ref={ref}
      className={`toast-item toast-${item.type} ${exiting ? 'toast-exit' : ''}`}
      style={style}
      onClick={() => setExiting(true)}
    >
      <span className="toast-icon">
        {item.type === 'success' ? '\u2713' : item.type === 'error' ? '!' : 'i'}
      </span>
      <span className="toast-message">{item.message}</span>
    </div>
  )
}
