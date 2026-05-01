import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import './ConfirmDialog.css'

export interface ConfirmDialogProps {
  open: boolean
  title?: string
  /** Body text. Newlines render as paragraph breaks. */
  message: string
  confirmLabel?: string
  cancelLabel?: string
  /** Render the confirm button as a danger action (red). */
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}

/**
 * Lightweight confirm modal — replaces native `window.confirm` so the
 * UI stays inside the Studio chrome (themable, focus-trappable, no OS
 * popup blocker behavior). Mirrors the look of ClipEditModal so we keep
 * one visual language across modals.
 *
 * Mounted via portal on document.body so the backdrop covers the whole
 * viewport even when the caller lives in a scrolled / clipped subtree.
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'OK',
  cancelLabel = 'キャンセル',
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    confirmRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
      else if (e.key === 'Enter') onConfirm()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onConfirm, onCancel])

  if (!open) return null

  return createPortal(
    <div className="confirm-dialog-backdrop" onClick={onCancel}>
      <div
        className="confirm-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        {title && <div className="confirm-dialog-title">{title}</div>}
        <div className="confirm-dialog-body">
          {message.split('\n').map((line, i) => (
            <p key={i}>{line}</p>
          ))}
        </div>
        <div className="confirm-dialog-actions">
          <button
            type="button"
            className="form-button-secondary"
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            className={danger ? 'form-button-danger' : 'form-button'}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
