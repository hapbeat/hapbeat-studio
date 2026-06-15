import { useState, useEffect, useLayoutEffect, useCallback, createContext, useContext, useRef } from 'react'
import { createPortal } from 'react-dom'
import './Toast.css'

type ToastType = 'success' | 'error' | 'info' | 'warning'

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

/** 実測前の暫定幅（最初の paint 用フォールバック。幅は CSS の fit-content が
 *  内容から決めるので、ここは初回 1 フレームだけ使う概算）。 */
const TOAST_EST_W = 280

function ToastNotification({ item, onRemove }: { item: ToastItem; onRemove: (id: number) => void }) {
  const [exiting, setExiting] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  // 実測幅。CSS の fit-content + max-width で内容に応じて幅が決まるので、
  // クランプ（画面外に出さない位置補正）には固定の概算ではなく実測値を使う。
  const [measuredW, setMeasuredW] = useState<number | null>(null)

  useLayoutEffect(() => {
    if (ref.current) setMeasuredW(ref.current.offsetWidth)
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => setExiting(true), 2000)
    return () => clearTimeout(timer)
  }, [])

  useEffect(() => {
    if (!exiting) return
    const timer = setTimeout(() => onRemove(item.id), 300)
    return () => clearTimeout(timer)
  }, [exiting, item.id, onRemove])

  const margin = 8
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1024
  const vh = typeof window !== 'undefined' ? window.innerHeight : 768

  // クランプ: left を margin 〜 vw - margin - 実測幅 に収める
  const w = measuredW ?? TOAST_EST_W
  const clampLeft = (idealCenter: number) => {
    const left = idealCenter - w / 2
    return Math.max(margin, Math.min(left, vw - margin - w))
  }

  const style: React.CSSProperties = { position: 'fixed', zIndex: 9999 }
  if (item.anchorRect) {
    const r = item.anchorRect
    const idealTop = r.bottom + margin
    style.top = idealTop + 50 > vh ? Math.max(margin, r.top - margin - 50) : idealTop
    style.left = clampLeft(r.left + r.width / 2)
  } else {
    style.top = Math.min(60, vh - margin - 50)
    style.left = clampLeft(vw / 2)
  }

  return (
    <div
      ref={ref}
      className={`toast-item toast-${item.type} ${exiting ? 'toast-exit' : ''}`}
      style={style}
      onClick={() => setExiting(true)}
    >
      <span className="toast-icon">
        {item.type === 'success' ? '\u2713' : item.type === 'error' ? '!' : item.type === 'warning' ? '\u26A0' : 'i'}
      </span>
      <span className="toast-message">{item.message}</span>
    </div>
  )
}
