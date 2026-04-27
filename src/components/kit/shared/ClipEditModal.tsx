import { useCallback, useEffect, useState } from 'react'
import type { LibraryClip } from '@/types/library'
import './ClipEditModal.css'

export interface ClipEditModalProps {
  clip: LibraryClip
  onClose: () => void
  onUpdate: (id: string, updates: Partial<LibraryClip>) => Promise<void>
  onArchive: (id: string) => Promise<void>
  /** name の確定時に呼ばれる。ローカルファイル名を clip.name に同期する */
  onCommitRename?: (id: string) => Promise<void>
}

/**
 * Modal editor for a single clip.
 *
 * Event ID is no longer edited here — it is derived from `<kitName>.<clipName>`
 * inside the kit at add-time, so the only kit-relevant field a clip exposes
 * is its display name (= the event-id name part). Group / tags / note are
 * library-side metadata for organisation and filtering.
 */
export function ClipEditModal({ clip, onClose, onUpdate, onArchive, onCommitRename }: ClipEditModalProps) {
  const [tagInput, setTagInput] = useState('')

  const commitRename = useCallback(() => {
    if (onCommitRename) void onCommitRename(clip.id)
  }, [clip.id, onCommitRename])

  const handleClose = useCallback(() => {
    commitRename()
    onClose()
  }, [commitRename, onClose])

  // Close on Escape, allow click-out to dismiss.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') handleClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [handleClose])

  return (
    <div className="clip-edit-modal-backdrop" onClick={handleClose}>
      <div className="clip-edit-modal" onClick={(e) => e.stopPropagation()}>
        <div className="clip-edit-modal-header">
          <h3>Edit clip</h3>
          <button className="clip-edit-modal-close" onClick={handleClose} aria-label="Close">×</button>
        </div>

        <div className="clip-edit-fields">
          <label className="clip-edit-field">
            <span>Name <span className="field-hint">(英小文字 / 数字 / -, _ のみ — kit 内の event-id の name 部に使う)</span></span>
            <input
              type="text"
              value={clip.name}
              autoFocus
              maxLength={64}
              pattern="[a-z0-9_-]+"
              title="英小文字 / 数字 / -, _ のみ"
              onChange={(e) => {
                const cleaned = e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '')
                if (cleaned !== clip.name) onUpdate(clip.id, { name: cleaned })
              }}
              onBlur={commitRename}
            />
          </label>

          <label className="clip-edit-field">
            <span>Note <span className="field-hint">(optional — shown on hover)</span></span>
            <textarea
              rows={3}
              value={clip.note ?? ''}
              placeholder="任意のメモ。例: 用途、サイドノート、注意事項…"
              onChange={(e) => onUpdate(clip.id, { note: e.target.value })}
            />
          </label>

          <label className="clip-edit-field">
            <span>Group</span>
            <input
              type="text"
              value={clip.group}
              placeholder="impacts"
              onChange={(e) => onUpdate(clip.id, { group: e.target.value })}
            />
          </label>

          <div className="clip-edit-field">
            <span>Tags</span>
            <div className="clip-edit-tags">
              {clip.tags.map((t) => (
                <span key={t} className="tag-chip removable">{t}
                  <button onClick={() => onUpdate(clip.id, { tags: clip.tags.filter((x) => x !== t) })}>x</button>
                </span>
              ))}
              <input
                type="text"
                value={tagInput}
                placeholder="+ tag"
                className="tag-input"
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    const t = tagInput.trim()
                    if (t && !clip.tags.includes(t)) {
                      onUpdate(clip.id, { tags: [...clip.tags, t] })
                      setTagInput('')
                    }
                  }
                }}
              />
            </div>
          </div>
        </div>

        <div className="clip-edit-modal-footer">
          <button
            className="library-btn danger"
            title="Move this clip to clips/archive/. Your file stays on disk so you can recover it later by moving it back."
            onClick={async () => {
              if (!confirm(`Archive "${clip.name}"?\n\nThe file will be moved to clips/archive/ and hidden from Studio.\nYou can recover it by moving the file back into clips/.`)) return
              await onArchive(clip.id)
              onClose()
            }}
          >Archive</button>
          <div className="clip-edit-modal-footer-spacer" />
          <button className="library-btn primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  )
}
