import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { IntensityControl } from './IntensityControl'
import { WiperBadge } from './WiperBadge'
import { useToast } from '@/components/common/Toast'
import './ClipCard.css'

export interface ClipCardAction {
  /** Short button label ("+ Kit", "Edit", "×" …) */
  label: string
  onClick: () => void
  title?: string
  variant?: 'default' | 'primary' | 'danger'
  disabled?: boolean
}

export interface ClipCardProps {
  /** Primary: clip display name (clickable → onNameClick) */
  name: string
  /** Secondary: event ID badge.
   *  Pass null to omit the badge entirely (library context — clips no
   *  longer carry an eventId; kits compose it on add). */
  eventId: string | null
  /** "No event ID set" styling when eventId is empty (only meaningful when eventId is a string) */
  eventIdEmpty?: boolean

  /** Optional details row (duration · channels · kHz · file size) rendered
   *  at the bottom of the card when `showDetails` is true. Pure text. */
  details?: string
  /** Optional tag list for the details row */
  tags?: string[]
  /** Global toggle (see libraryStore.showClipDetails) */
  showDetails?: boolean

  /**
   * Optional clip/event note to surface on the details row. Rendered
   * right-aligned (between tags and the wiper badge) so the user can
   * see the original filename / author memo at a glance without
   * hovering. Truncates with ellipsis when long.
   */
  note?: string

  /** Amp (0–1). Pass null to hide the control. */
  intensity: number | null
  onIntensityChange?: (v: number) => void

  /** Play/stop toggle */
  playing: boolean
  onTogglePlay: () => void
  /** Disable the play button (e.g. when there's no decodable clip blob) */
  playDisabled?: boolean

  /** Optional: double-click card to trigger (edit/details) */
  onDoubleClick?: () => void

  /** 選択状態 — カード全体をハイライトする */
  selected?: boolean
  /** カードクリック時の選択ハンドラ（内部の input/button クリックでは発火しない） */
  onSelect?: () => void

  /** Device wiper badge in the top-right. null = hidden. */
  wiper: number | null
  wiperTitle?: string

  /** Drag source config: sets dataTransfer data on dragStart */
  drag?: {
    type: string
    payload: string
    effect?: DataTransfer['effectAllowed']
    dragTitle?: string
  }

  /** Legacy drop handler — accepted but no longer wired to the DOM.
   *  The card is a pure click-target now (drag was removed per user
   *  request). Kept on the props type for backwards compatibility. */
  onDragOver?: (e: import('react').DragEvent) => void
  /** Extra CSS className (e.g. drag-over-indicator, active state) */
  extraClass?: string

  /** data-card-id 属性 — 親から querySelector で参照するため */
  dataCardId?: string

  /** Action buttons shown next to the slider. Order is preserved. */
  actions?: ClipCardAction[]

  /** Tooltip to put on the root element — typically the collapsed meta info */
  title?: string

  /**
   * Optional rename handler. When set, clicking the name turns it into
   * a text input. Enter / blur commits, Escape reverts. Library cards
   * pass this; kit-side cards do not (kits should not mutate clips).
   */
  onRenameCommit?: (next: string) => void

  /**
   * Optional close (archive) handler. When set, renders a small "×"
   * button anchored to the card's top-right corner. Library cards use
   * this to move the underlying clip into clips/archive/ — same UX as
   * the Kit list's per-row close button. Kit-event rows do NOT pass
   * this prop because they own a wider wrap with their own delete
   * corner that lives outside the ClipCard (positioned past the side
   * rail). Click-through is stopped so the card's onSelect doesn't
   * fire when the user really meant to archive.
   */
  onClose?: () => void
  /** Tooltip for the close-corner button (defaults to "Archive"). */
  closeTitle?: string

  /**
   * Optional Name ↔ Note swap handler. Library rows wire this so the
   * user can flip the displayed name with a single in-card click (e.g.
   * `z1_pin_hit` ↔ `sin_100hz.wav`) without opening the edit modal.
   * The callback is responsible for the actual swap + any on-disk
   * follow-up (file rename, kit flush, etc).
   *
   * The card owns the re-entry lock — `swappingRef` guards against
   * rapid double-clicks beating the visual `disabled` flag, which
   * only takes effect after React re-renders.
   */
  onSwap?: () => Promise<void> | void
  /** Hover hint for the swap button. Defaults to a Japanese explainer. */
  swapTitle?: string
  /** Hide the swap button even if `onSwap` is provided (e.g. note empty). */
  swapDisabled?: boolean
}

/**
 * Unified card for every clip-like row (library clips, kit events).
 * Flex column layout so handle + play + name all share one row, then the
 * amp slider + action buttons, then optional details at the bottom.
 */
export function ClipCard({
  name,
  eventId,
  eventIdEmpty,
  details,
  tags,
  showDetails,
  note,
  intensity,
  onIntensityChange,
  playing,
  onTogglePlay,
  playDisabled,
  onDoubleClick,
  selected,
  onSelect,
  wiper,
  wiperTitle,
  drag,
  onDragOver,
  extraClass,
  dataCardId,
  actions,
  title,
  onRenameCommit,
  onClose,
  closeTitle,
  onSwap,
  swapTitle,
  swapDisabled,
}: ClipCardProps) {
  const [renaming, setRenaming] = useState(false)
  // Re-entry guard for the in-card Swap button — see prop docs.
  const swappingRef = useRef(false)
  const [swapping, setSwapping] = useState(false)
  const [draftName, setDraftName] = useState(name)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const { toast } = useToast()
  // Throttle the sanitize warning so a paste of "Hello World" doesn't
  // fire one toast per character. We re-arm 1.2s after the last invalid
  // input, which is long enough to feel like "one warning per attempt"
  // without being so long that a follow-up genuine mistake is silenced.
  const warnArmedRef = useRef(true)
  const warnRef = useRef<number | null>(null)
  const flagInvalid = () => {
    if (!warnArmedRef.current) return
    warnArmedRef.current = false
    toast('英小文字 / 数字 / -, _ のみ使用できます', 'warning')
    if (warnRef.current !== null) window.clearTimeout(warnRef.current)
    warnRef.current = window.setTimeout(() => { warnArmedRef.current = true }, 1200)
  }

  useEffect(() => {
    if (renaming) {
      setDraftName(name)
      // focus + select on next tick
      requestAnimationFrame(() => {
        const el = inputRef.current
        if (!el) return
        el.focus()
        el.select()
      })
    }
  }, [renaming, name])

  const commitRename = () => {
    setRenaming(false)
    const next = draftName.trim()
    if (next && next !== name && onRenameCommit) onRenameCommit(next)
  }

  const onRenameKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === 'Escape') {
      // Stop the document-level keydown listener (Library panel's
      // Enter = "+ Kit", or anything that might react). Without this,
      // pressing Enter to commit a rename also fires the global
      // shortcut and the clip is added with its PRE-rename name (the
      // commit's state update hasn't propagated yet at bubble time).
      // Synthetic event stopPropagation propagates to the native
      // event in React, so the document listener never sees it.
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Enter') commitRename()
      else { setRenaming(false); setDraftName(name) }
    }
  }
  // Drag is intentionally absent: per user request the card is a
  // pure click-target. "+ Kit" and the sort selector are the only
  // ways to add / reorder. The `drag` and `onDragOver` props are
  // accepted but ignored to avoid touching every call site.
  void drag; void onDragOver

  return (
    <div
      className={`clip-card ${extraClass ?? ''} ${selected ? 'is-selected' : ''}`}
      data-card-id={dataCardId}
      title={title}
      onClick={onSelect}
      onDoubleClick={onDoubleClick}
    >
      {/* The card is a 3-column grid: `1fr auto auto`.
          - col 1 holds the variable-width left content (play+name in
            row 1, intensity in row 2). The 1fr eats spare width.
          - col 2 = "primary action" track. Row 1 puts Swap here; row 2
            puts the first action button (+Kit on library, Edit on kit).
            Both items share the same `auto` track so the track width
            grows to the wider of them → Swap's left edge always
            aligns with the first action button's left edge, AND both
            stretch to a matching width (no narrower-than-+Kit Swap).
          - col 3 = "secondary action" track. Row 1 puts × here; row 2
            puts the second action button (Edit on library; empty on
            kit). Same alignment story for the right column.
          Items below use explicit `gridColumn` / `gridRow` so a
          missing Swap doesn't shove × into col 2 by mistake. */}
      <div className="clip-card-header-left">
        <button
          className={`clip-card-play ${playing ? 'playing' : ''} ${playDisabled ? 'disabled' : ''}`}
          onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); if (!playDisabled) onTogglePlay() }}
          title={playDisabled ? 'No audio to preview' : (playing ? 'Stop' : 'Play')}
          aria-disabled={playDisabled}
        >{playing ? '■' : '▶'}</button>
        {renaming && onRenameCommit ? (
          <input
            ref={inputRef}
            className="clip-card-name clip-card-name-input"
            value={draftName}
            onChange={(e) => {
              const raw = e.target.value
              const cleaned = raw.toLowerCase().replace(/[^a-z0-9_-]/g, '')
              if (cleaned !== raw) flagInvalid()
              setDraftName(cleaned)
            }}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onBlur={commitRename}
            onKeyDown={onRenameKey}
            title="英小文字 / 数字 / -, _ のみ"
          />
        ) : (
          <span
            className={`clip-card-name${onRenameCommit ? ' clip-card-name-editable' : ''}`}
            onClick={(e) => {
              if (!onRenameCommit) return
              e.stopPropagation()
              setRenaming(true)
            }}
            title={onRenameCommit ? 'クリックで名前を変更' : undefined}
          >
            {name}
          </span>
        )}
        {eventId !== null && (
          <span
            className={`clip-card-event-id ${eventIdEmpty ? 'empty' : ''}`}
            title={`Event ID: ${eventId || '(not set)'}`}
          >{eventId || '(no ID)'}</span>
        )}
      </div>

      {/* Row 1, col 2 — Swap. */}
      {onSwap && !renaming && (
        <button
          type="button"
          className="clip-card-swap-btn clip-card-col-primary"
          disabled={swapping || swapDisabled}
          title={swapTitle ?? 'Name ↔ Note を入れ替え (1-click でファイル名を切替)'}
          aria-label="Swap name and note"
          onMouseDown={(e) => { e.stopPropagation() }}
          onClick={async (e) => {
            e.stopPropagation()
            if (swappingRef.current) return
            swappingRef.current = true
            setSwapping(true)
            try {
              await onSwap()
            } finally {
              swappingRef.current = false
              setSwapping(false)
            }
          }}
        >{swapping ? '…' : '⇅ Swap'}</button>
      )}
      {/* Row 1, col 3 — Close. */}
      {onClose && (
        <button
          type="button"
          className="clip-card-close-inline clip-card-col-secondary"
          onMouseDown={(e) => { e.stopPropagation() }}
          onClick={(e) => { e.stopPropagation(); onClose() }}
          title={closeTitle ?? 'Archive (Studio から非表示)'}
          aria-label={closeTitle ?? 'Archive'}
        >×</button>
      )}

      {/* Row 2, col 1 — intensity slider. */}
      <div className="clip-card-controls-left">
        {intensity !== null && onIntensityChange && (
          <IntensityControl value={intensity} onChange={onIntensityChange} />
        )}
      </div>
      {/* Row 2 cols 2 + 3 — action buttons. The first action goes
          under Swap (primary track), the second under × (secondary).
          Cards with only one action (e.g. kit-event rows that show
          just `Edit`) leave the secondary cell empty — Edit ends
          up vertically aligned with Swap, which reads as "primary
          action under primary action" instead of being orphaned. */}
      {actions && actions[0] && (
        <button
          key="action-primary"
          className={`clip-card-action-btn clip-card-col-primary ${actions[0].variant ?? ''}`}
          onClick={(e) => { e.stopPropagation(); actions[0]!.onClick() }}
          title={actions[0].title}
          disabled={actions[0].disabled}
        >{actions[0].label}</button>
      )}
      {actions && actions[1] && (
        <button
          key="action-secondary"
          className={`clip-card-action-btn clip-card-col-secondary ${actions[1].variant ?? ''}`}
          onClick={(e) => { e.stopPropagation(); actions[1]!.onClick() }}
          title={actions[1].title}
          disabled={actions[1].disabled}
        >{actions[1].label}</button>
      )}

      {/* Row 3 (optional) — details + Note + Vol badge at the bottom.
          Note sits right-aligned (between tags and wiper) so users
          can see the original filename / memo without hovering — the
          earlier tooltip-only surfacing was too easy to miss. */}
      {showDetails && (details || (tags && tags.length > 0) || (note && note.trim()) || wiper !== null) && (
        <div className="clip-card-details">
          {details && <span className="clip-card-details-meta">{details}</span>}
          {tags && tags.length > 0 && (
            <span className="clip-card-details-tags" title={tags.join(', ')}>
              {tags.map((t) => <span key={t} className="clip-card-tag" title={t}>{t}</span>)}
            </span>
          )}
          {note && note.trim() && (
            // `margin-left: auto` (in CSS) pushes the note + wiper
            // cluster to the right edge of the row. Title attribute
            // shows the full text in case truncation cut it off.
            <span className="clip-card-details-note" title={note}>{note}</span>
          )}
          <WiperBadge value={wiper} title={wiperTitle} />
        </div>
      )}
      {/* Fallback: if details row is hidden but wiper exists, show inline */}
      {!showDetails && wiper !== null && (
        <div className="clip-card-details clip-card-details-vol-only">
          <WiperBadge value={wiper} title={wiperTitle} />
        </div>
      )}
    </div>
  )
}
