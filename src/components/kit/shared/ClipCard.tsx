import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from 'react'
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

  /** Amp (0–1). Pass null to hide the control. */
  intensity: number | null
  onIntensityChange?: (v: number) => void

  /** Play/stop toggle */
  playing: boolean
  onTogglePlay: () => void
  /** Disable the play button (e.g. stream_source events have no previewable clip) */
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

  /** Extra drop handler on the whole card (used by kit reorder). */
  onDragOver?: (e: DragEvent) => void
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
}: ClipCardProps) {
  const [renaming, setRenaming] = useState(false)
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
    if (e.key === 'Enter') { e.preventDefault(); commitRename() }
    else if (e.key === 'Escape') { e.preventDefault(); setRenaming(false); setDraftName(name) }
  }
  const handleDragStart = drag
    ? (e: DragEvent) => {
      e.dataTransfer.setData(drag.type, drag.payload)
      e.dataTransfer.effectAllowed = drag.effect ?? 'copy'
    }
    : undefined

  return (
    <div
      className={`clip-card ${extraClass ?? ''} ${selected ? 'is-selected' : ''}`}
      data-card-id={dataCardId}
      title={title}
      onClick={onSelect}
      onDoubleClick={onDoubleClick}
      onDragOver={onDragOver}
    >
      {/* Row 1 — header: handle / play / name / event-id */}
      <div className="clip-card-header">
        <div
          className="clip-card-handle"
          draggable={!!handleDragStart}
          onDragStart={handleDragStart}
          title={drag?.dragTitle ?? 'ドラッグで移動'}
        >☰</div>
        <button
          className={`clip-card-play ${playing ? 'playing' : ''} ${playDisabled ? 'disabled' : ''}`}
          onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); if (!playDisabled) onTogglePlay() }}
          title={playDisabled ? 'No audio to preview' : (playing ? 'Stop' : 'Play')}
          aria-disabled={playDisabled}
        >{playing ? '■' : '▶'}</button>
        {/* `title` already contains the note (caller injects it) so we let
            the parent tooltip win — the name span gets no title of its own
            and hovering the name reveals the note. */}
        {renaming && onRenameCommit ? (
          <input
            ref={inputRef}
            className="clip-card-name clip-card-name-input"
            value={draftName}
            // Same sanitize as Kit name: clip.name feeds the event-id
            // `name` part inside a kit, so the same character set
            // constraint must apply — silently lowercase + drop bad
            // chars rather than letting users type something that the
            // kit will reject at Save time. We surface a (throttled)
            // toast so the user understands why the character didn't
            // appear, instead of "なぜか入らない" head-scratching.
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

      {/* Row 2 — controls: amp slider + action buttons */}
      <div className="clip-card-controls">
        {intensity !== null && onIntensityChange && (
          <IntensityControl value={intensity} onChange={onIntensityChange} />
        )}
        {actions && actions.length > 0 && (
          <div className="clip-card-actions">
            {actions.map((a, i) => (
              <button
                key={i}
                className={`clip-card-action-btn ${a.variant ?? ''}`}
                onClick={(e) => { e.stopPropagation(); a.onClick() }}
                title={a.title}
                disabled={a.disabled}
              >{a.label}</button>
            ))}
          </div>
        )}
      </div>

      {/* Row 3 (optional) — details + Vol badge at the bottom */}
      {showDetails && (details || (tags && tags.length > 0) || wiper !== null) && (
        <div className="clip-card-details">
          {details && <span className="clip-card-details-meta">{details}</span>}
          {tags && tags.length > 0 && (
            <span className="clip-card-details-tags" title={tags.join(', ')}>
              {tags.map((t) => <span key={t} className="clip-card-tag" title={t}>{t}</span>)}
            </span>
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
