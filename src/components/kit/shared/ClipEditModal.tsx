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
 * - Rendered as a dialog overlay so the underlying card stays visible.
 * - There is intentionally no "Delete" button here. Deletion would lose
 *   the file; instead the user clicks "Archive" which moves the file to
 *   clips/archive/ where it can be recovered by dragging back later.
 */
export function ClipEditModal({ clip, onClose, onUpdate, onArchive, onCommitRename }: ClipEditModalProps) {
  const [tagInput, setTagInput] = useState('')

  // Name 入力終了時 (blur / 閉じる) にローカルファイル名を同期
  const commitRename = useCallback(() => {
    if (onCommitRename) void onCommitRename(clip.id)
  }, [clip.id, onCommitRename])

  const handleClose = useCallback(() => {
    commitRename()
    onClose()
  }, [commitRename, onClose])

  // Split eventId into category.name
  const dotIdx = clip.eventId.indexOf('.')
  const eidCategory = dotIdx > 0 ? clip.eventId.substring(0, dotIdx) : ''
  const eidName = dotIdx > 0 ? clip.eventId.substring(dotIdx + 1) : clip.eventId

  const autoCategory = clip.eventIdAuto?.category ?? true
  const autoName = clip.eventIdAuto?.name ?? true

  const setAutoFlag = useCallback((part: 'category' | 'name', next: boolean) => {
    const cur = clip.eventIdAuto ?? { category: true, name: true }
    onUpdate(clip.id, { eventIdAuto: { ...cur, [part]: next } })
  }, [clip.id, clip.eventIdAuto, onUpdate])

  const updateEventId = useCallback((cat: string, name: string) => {
    const c = cat.toLowerCase().replace(/[^a-z0-9_-]/g, '')
    const n = name.toLowerCase().replace(/[^a-z0-9_.-]/g, '')
    onUpdate(clip.id, { eventId: c && n ? `${c}.${n}` : '' })
  }, [clip.id, onUpdate])

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
            <span>Name</span>
            <input
              type="text"
              value={clip.name}
              autoFocus
              onChange={(e) => onUpdate(clip.id, { name: e.target.value })}
              onBlur={commitRename}
            />
          </label>

          <div className="clip-edit-field">
            <span>Event ID <span className="field-hint">(category.name — both required)</span></span>
            <div className="event-id-inputs">
              <input
                type="text"
                value={eidCategory}
                placeholder="category"
                className={`eid-category ${autoCategory ? 'auto-disabled' : ''}`}
                disabled={autoCategory}
                onChange={(e) => updateEventId(e.target.value, eidName)}
              />
              <span className="eid-dot">.</span>
              <input
                type="text"
                value={eidName}
                placeholder="name"
                className={`eid-name ${autoName ? 'auto-disabled' : ''}`}
                disabled={autoName}
                onChange={(e) => updateEventId(eidCategory, e.target.value)}
              />
            </div>
            <div className="event-id-auto-flags">
              <label className="auto-flag-label" title="チェック時、category をフォルダ名から自動生成（入力欄は編集不可）">
                <input type="checkbox" checked={autoCategory}
                  onChange={(e) => setAutoFlag('category', e.target.checked)} />
                フォルダ名 → category
              </label>
              <label className="auto-flag-label" title="チェック時、name をファイル名 (= clip.name) から自動生成（入力欄は編集不可）">
                <input type="checkbox" checked={autoName}
                  onChange={(e) => setAutoFlag('name', e.target.checked)} />
                ファイル名 → name
              </label>
            </div>
            {(!eidCategory || !eidName) && clip.eventId !== '' && (
              <span className="field-error">Both category and name are required</span>
            )}
          </div>

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
            title="Move this clip to clips/archive/. Your file stays on disk so you can recover it later by moving it back into clips/."
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
