import { useCallback, useEffect, useRef, useState } from 'react'
import type { KitEvent } from '@/types/library'
// Reuse the library clip editor's modal frame styles — same layout
// (header / fields / footer) so users get a consistent dialog look
// across the Clips and Kit panels.
import '../shared/ClipEditModal.css'

export interface KitEventEditModalProps {
  event: KitEvent
  onClose: () => void
  /**
   * Apply a metadata patch to this kit event. The store recomposes
   * `eventId` from kit name × clipName automatically when clipName
   * changes — callers don't have to pass eventId themselves.
   */
  onUpdate: (updates: Partial<KitEvent>) => Promise<void> | void
  /**
   * Remove this event from the kit. The dialog closes itself after
   * the caller resolves.
   */
  onRemove: () => Promise<void> | void
}

/**
 * Modal editor for a single kit event. Counterpart to `ClipEditModal`
 * — same shape (Name / Note / footer with destructive action) but
 * scoped to kit-event metadata. Tags / group / sourceFilename live on
 * the library clip and aren't editable here; mode / intensity / loop
 * are tuned inline on the kit row, not in this dialog.
 */
export function KitEventEditModal({ event, onClose, onUpdate, onRemove }: KitEventEditModalProps) {
  // Escape / click-outside dismiss — mirrors ClipEditModal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // Lock for Name ↔ Note swap. Same shape as `ClipEditModal` — see
  // comments there for why we use a ref-based guard instead of just
  // the React state.
  const swappingRef = useRef(false)
  const [swapping, setSwapping] = useState(false)

  const updateNote = useCallback((next: string) => {
    void onUpdate({ note: next })
  }, [onUpdate])

  const updateClipName = useCallback((next: string) => {
    // Sanitize identically to the library clip name input — kit
    // eventId composition (`<kit>.<clipName>`) needs the lower-case
    // / underscore-only character set.
    const cleaned = next.toLowerCase().replace(/[^a-z0-9_-]/g, '')
    if (cleaned !== event.clipName) void onUpdate({ clipName: cleaned })
  }, [event.clipName, onUpdate])

  return (
    <div className="clip-edit-modal-backdrop" onClick={onClose}>
      <div className="clip-edit-modal" onClick={(e) => e.stopPropagation()}>
        <div className="clip-edit-modal-header">
          <h3>Edit kit event</h3>
          <button className="clip-edit-modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="clip-edit-fields">
          <label className="clip-edit-field">
            <span>Name <span className="field-hint">英小文字 / 数字 / -, _ のみ — kit 内のクリップ表示名 + eventId に使用</span></span>
            <input
              type="text"
              value={event.clipName}
              autoFocus
              maxLength={64}
              pattern="[a-z0-9_-]+"
              title="英小文字 / 数字 / -, _ のみ"
              onChange={(e) => updateClipName(e.target.value)}
            />
          </label>

          <label className="clip-edit-field">
            <span>
              Note <span className="field-hint">(optional — カード hover で表示)</span>
              <button
                type="button"
                className="clip-edit-swap-btn"
                title="Name ↔ Note を入れ替え (Name 側は拡張子除去 + 英数字に sanitize)"
                disabled={swapping || !event.note?.trim()}
                onClick={async () => {
                  // Same shape as the library ClipEditModal swap:
                  // sanitize note → name, copy old name → note,
                  // recompose eventId, gate behind a ref lock to
                  // survive rapid clicks. Unlike the library version
                  // there's no on-disk file rename here — the kit
                  // flush re-emits install-clips/<name>.wav from the
                  // event's snapshot on the next scheduled write.
                  if (swappingRef.current) return
                  swappingRef.current = true
                  setSwapping(true)
                  try {
                    const prevName = event.clipName
                    const prevNote = (event.note ?? '').trim()
                    if (!prevNote) return
                    const stripped = prevNote.replace(/\.(wav|mp3|ogg|flac|aac|m4a)$/i, '')
                    const newName = stripped.toLowerCase().replace(/[^a-z0-9_-]/g, '_').replace(/^_+|_+$/g, '')
                    if (!newName) return
                    // Caller's `onUpdate` re-derives eventId from
                    // clipName, so passing both keys is enough.
                    await onUpdate({ clipName: newName, note: prevName })
                  } finally {
                    swappingRef.current = false
                    setSwapping(false)
                  }
                }}
              >{swapping ? '⇅ …' : '⇅ Swap'}</button>
            </span>
            <textarea
              rows={3}
              value={event.note ?? ''}
              placeholder="この event の用途・調整意図など、author 向けメモ"
              onChange={(e) => updateNote(e.target.value)}
            />
          </label>

          <div className="clip-edit-field">
            <span>Event ID <span className="field-hint">(自動: kit name × name)</span></span>
            <code className="kit-event-edit-eventid">{event.eventId || '(空 — Name を入力してください)'}</code>
          </div>
        </div>

        <div className="clip-edit-modal-footer">
          <button
            className="library-btn danger"
            title="Remove this event from the kit (元のライブラリ clip は影響なし)"
            onClick={async () => {
              if (!confirm(`"${event.clipName}" を kit から除外しますか？\n\nライブラリのオリジナルクリップは残ります。`)) return
              await onRemove()
              onClose()
            }}
          >Remove from kit</button>
          <div className="clip-edit-modal-footer-spacer" />
          <button className="library-btn primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  )
}
