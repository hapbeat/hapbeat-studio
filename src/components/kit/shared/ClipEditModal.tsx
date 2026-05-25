import { useCallback, useEffect, useRef, useState } from 'react'
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

  // Lock for the Name ↔ Note swap. The swap reads the current
  // `clip.name` / `clip.note` props, awaits a store mutation, then
  // awaits a possible on-disk file rename. Rapid clicking before the
  // second async step landed would re-read STALE props and apply a
  // second swap on top of the partial first one, ending up with
  // `name === note`. Gate every swap behind a ref-based lock that's
  // synchronous (instant to check, no React render needed) so the
  // disable flag doesn't race with the click.
  const swappingRef = useRef(false)
  const [swapping, setSwapping] = useState(false)

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
            <span>Name <span className="field-hint">英小文字 / 数字 / -, _ のみ</span></span>
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
            <span>
              Note <span className="field-hint">(optional — hover で表示。Import 時は原ファイル名が自動セット)</span>
              <button
                type="button"
                className="clip-edit-swap-btn"
                title="Name ↔ Note を入れ替え (Name 側は拡張子除去 + 英数字に sanitize)"
                disabled={swapping || !clip.note?.trim()}
                onClick={async () => {
                  // Swap the two strings. `name` side sanitises to the
                  // event-id charset and drops the extension since
                  // eventId / on-disk filename can't carry it; `note`
                  // side gets whatever was in `name` verbatim.
                  //
                  // The ref check is the *real* re-entry guard — the
                  // `swapping` state visual disable doesn't kick in
                  // until React re-renders, so a fast double-click
                  // would still slip a second swap through if we only
                  // gated on it. We snapshot the inputs synchronously
                  // here so subsequent reads of `clip.*` don't latch
                  // a half-updated value.
                  if (swappingRef.current) return
                  swappingRef.current = true
                  setSwapping(true)
                  try {
                    const prevName = clip.name
                    const prevNote = (clip.note ?? '').trim()
                    if (!prevNote) return
                    const stripped = prevNote.replace(/\.(wav|mp3|ogg|flac|aac|m4a)$/i, '')
                    const newName = stripped.toLowerCase().replace(/[^a-z0-9_-]/g, '_').replace(/^_+|_+$/g, '')
                    if (!newName) return
                    await onUpdate(clip.id, { name: newName, note: prevName })
                    // Wait for the on-disk WAV rename + the follow-up
                    // state patch (sourceFilename + re-derived name)
                    // BEFORE releasing the lock. Otherwise a quick
                    // second click would read pre-rename `clip.name`
                    // and undo our work.
                    if (onCommitRename) await onCommitRename(clip.id)
                  } finally {
                    swappingRef.current = false
                    setSwapping(false)
                  }
                }}
              >{swapping ? '⇅ …' : '⇅ Swap'}</button>
            </span>
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
            title="Hide this clip from Studio. The file is moved to a managed archive directory on disk so you can recover it later."
            onClick={async () => {
              if (!confirm(`Archive "${clip.name}"?\n\nStudio から非表示になります (元ファイルは管理ディレクトリに退避され、戻すことで復活できます)。`)) return
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
