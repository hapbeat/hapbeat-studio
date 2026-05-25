import { type DragEvent } from 'react'
import type { KitEvent, KitEventMode } from '@/types/library'
import { KIT_EVENT_MODE_SUFFIX } from '@/types/library'
import { ClipCard } from '../shared/ClipCard'
import './KitEventRow.css'

const DND_TYPE_KIT_EVENT = 'application/x-hapbeat-kit-event'

export interface KitEventRowProps {
  event: KitEvent
  playing: boolean
  showDetails: boolean
  selected: boolean
  onSelect: () => void
  onTogglePlay: () => void
  onIntensityChange: (v: number) => void
  /** Replace the event's selected modes. Caller is responsible for
   *  enforcing length ≥ 1 — the row UI also blocks the click that
   *  would zero out the set. */
  onModesChange: (modes: KitEventMode[]) => void
  onDelete: () => void
  onDragOverRow: (e: DragEvent) => void
  dragOverIndicator: boolean
  /**
   * Rename this kit event's clip (kit-side, owned by the event).
   * Updates `event.clipName` and recomposes `eventId`. Independent of
   * the source library clip — renaming here does NOT touch the
   * library entry the user originally dragged in.
   */
  onRenameCommit?: (next: string) => void | Promise<void>
  /**
   * Open the kit-event edit modal for this row. The parent owns the
   * modal so it can sit above the kit grid without nested rendering.
   */
  onStartEdit?: () => void
  /**
   * Swap `event.clipName` ↔ `event.note`. The card-level swap button
   * (right of the name) calls this. Caller is responsible for the
   * store mutation + any follow-up (eventId recompose, file rename).
   * Returns once everything has settled so the in-card lock in
   * `ClipCard` stays held for the whole sequence.
   */
  onSwap?: () => Promise<void>
}

/**
 * Side-rail mode selector model.
 *
 * UI is single-select radio over three choices — FIRE / CLIP / BOTH —
 * even though the underlying `KitEvent.modes` field is an array. Mapping
 * is straightforward:
 *
 *   UI "FIRE" → modes: ['command']
 *   UI "CLIP" → modes: ['stream_clip']
 *   UI "BOTH" → modes: ['command', 'stream_clip']   (suffix-emitted as .fire / .clip)
 *
 * BOTH is intentionally subordinate (smaller / dimmer): it produces two
 * manifest entries with `.fire` / `.clip` suffixes, which is mainly
 * useful while authoring/testing — once a kit ships, the author picks
 * one transport per event. The radio behaviour means a single click
 * swaps state in any direction, matching the toggle UX that radio
 * buttons enforce by convention.
 *
 * `stream_source` (LIVE) is retained in the type system + manifest
 * schema for future use, but the Unity SDK retired it on 2026-04-22.
 * Legacy `modes: ['stream_source']` kits still load — they just don't
 * map to any of the three pills, so all pills render inactive.
 */
type ModeChoice = 'fire' | 'clip' | 'both'

interface ModeOption {
  choice: ModeChoice
  symbol: string
  label: string
  title: string
}

const MODE_OPTIONS: ModeOption[] = [
  { choice: 'fire', symbol: '>', label: 'FIRE', title: 'Fire — デバイス内蔵 WAV を再生 (Event ID + 強度を UDP で送信)' },
  { choice: 'clip', symbol: '♪', label: 'CLIP', title: 'Stream Clip — SDK が Kit の WAV を UDP でストリーム' },
  { choice: 'both', symbol: '>♪', label: 'BOTH', title: 'BOTH — FIRE と CLIP の両 entry を manifest に出力 (eventId に .fire / .clip suffix が付く)。主に開発段階で両モードを試したいときに使用。' },
]

const CHOICE_TO_MODES: Record<ModeChoice, KitEventMode[]> = {
  fire: ['command'],
  clip: ['stream_clip'],
  both: ['command', 'stream_clip'],
}

/** Map the stored `modes` array to one of the three UI choices. Returns
 *  `null` for shapes that don't match any pill (e.g. legacy stream_source
 *  only), so the UI renders all pills inactive rather than picking a
 *  wrong default. */
function modesToChoice(modes: KitEventMode[]): ModeChoice | null {
  if (modes.length === 1) {
    if (modes[0] === 'command') return 'fire'
    if (modes[0] === 'stream_clip') return 'clip'
    return null  // stream_source only — no pill matches
  }
  if (modes.length === 2 && modes.includes('command') && modes.includes('stream_clip')) {
    return 'both'
  }
  return null
}

/**
 * Kit event = the same ClipCard used in the library, plus a kit-only
 * side panel on the right holding mode selector + help (?) + × (remove-from-kit).
 *
 * The card itself is visually identical to library rows. Anything that
 * only makes sense in a kit context lives in the side panel so the two
 * views never drift.
 */
export function KitEventRow({
  event,
  playing,
  showDetails,
  selected,
  onSelect,
  onTogglePlay,
  onIntensityChange,
  onModesChange,
  onDelete,
  onDragOverRow,
  dragOverIndicator,
  onRenameCommit,
  onStartEdit,
  onSwap,
}: KitEventRowProps) {
  // `modes` is normally a non-empty array post-migrateKit, but defend
  // against legacy/incomplete state so a stray empty array doesn't
  // render an all-off row that's silently un-toggleable.
  const modes: KitEventMode[] = event.modes?.length ? event.modes : ['command']
  const currentChoice = modesToChoice(modes)

  /**
   * Switch to a different mode choice. Pure radio behaviour — clicking
   * a non-active pill replaces the modes wholesale. Clicking the
   * already-active pill is a no-op (no "uncheck the last mode" worry
   * because radio always leaves exactly one selection).
   *
   * This intentionally collapses any legacy modes shape (e.g.
   * stream_source-only) into a canonical 1-or-2 entry array on first
   * pill click, which is the cheapest migration path — the next save
   * persists the cleaned-up modes.
   */
  const pickChoice = (target: ModeChoice) => {
    if (target === currentChoice) return
    onModesChange([...CHOICE_TO_MODES[target]])
  }

  // All clip data is owned by the event itself now (no library lookup) —
  // the kit is independent. Library archive / rename never affects what
  // shows here.
  const name = event.clipName || '(missing clip)'
  // EventId badge is hidden on kit cards — composed IDs like
  // `mykit.z1_pin_hit.fire` are long enough that they crowd the
  // header without telling the user anything they can't see in the
  // Edit modal's read-only Event ID field. Use the modal when you
  // need the literal string.
  // Detail line: clip metadata + a trailing suffix hint when both modes
  // are selected. The hint sits at the right end of the same row so it
  // doesn't take vertical space; the side rail stays clean. Single-mode
  // events get no extra text (eventId on the card is what lands on disk).
  const detailBase = event.clipDuration > 0
    ? `${Math.round(event.clipDuration * 1000)}ms | ${event.clipChannels === 1 ? 'Mono' : 'Stereo'} | ${event.clipSampleRate / 1000}kHz | ${formatBytes(event.clipFileSize)}`
    : undefined
  const suffixHint = modes.length > 1
    ? modes.map((m) => `.${KIT_EVENT_MODE_SUFFIX[m]}`).join(' / ')
    : null
  const details = detailBase && suffixHint
    ? `${detailBase}  ·  ${suffixHint}`
    : detailBase
  // Kit events don't carry tags (tags are a library-side concept tied
  // to clip search/filtering; kits are sealed bundles).
  const tags: string[] | undefined = undefined

  // Build the action button list shown next to the amp slider. We
  // only surface "Edit" when the caller wires an `onStartEdit` (the
  // KitEditor passes one; standalone usage can omit it). The button
  // mirrors the library Clip card's Edit pattern so users have one
  // mental model across panels.
  const cardActions: { label: string; onClick: () => void; title: string }[] = []
  if (onStartEdit) {
    cardActions.push({ label: 'Edit', onClick: onStartEdit, title: 'Edit name, note…' })
  }

  // Card hover tooltip: prepend the author note (if any), then the
  // detail string. Mirrors `ClipRow`'s title composition so hovering
  // a kit row reveals the note exactly like hovering a library clip.
  const cardTitle = event.note
    ? `${event.note}${detailBase ? `\n\n${detailBase}` : ''}`
    : detailBase

  return (
    <div
      className={`kit-event-wrap ${dragOverIndicator ? 'drag-over-indicator' : ''} ${selected ? 'is-selected' : ''}`}
      onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); onDragOverRow(e) }}
    >
      <ClipCard
        name={name}
        // Library convention: passing null hides the badge entirely.
        // The Event ID lives in the Edit modal as a read-only line.
        eventId={null}
        eventIdEmpty={false}
        details={details}
        tags={tags}
        showDetails={showDetails}
        note={event.note}
        intensity={event.intensity}
        onIntensityChange={onIntensityChange}
        playing={playing}
        onTogglePlay={onTogglePlay}
        selected={selected}
        onSelect={onSelect}
        dataCardId={event.id}
        wiper={null}
        title={cardTitle}
        drag={{ type: DND_TYPE_KIT_EVENT, payload: JSON.stringify({ kitEventId: event.id }), effect: 'move', dragTitle: 'ドラッグして並び替え' }}
        actions={cardActions}
        onRenameCommit={onRenameCommit ? (next) => { void onRenameCommit(next) } : undefined}
        onSwap={onSwap}
        swapDisabled={!(event.note ?? '').trim()}
        swapTitle={`Name ↔ Note を入れ替え (現在: "${event.clipName}" ↔ "${event.note ?? ''}")`}
        // Move "remove from kit" inside the card (top row's secondary
        // action slot) to match the library card's archive pattern.
        // The earlier `.kit-event-delete-corner` (absolute, past the
        // side rail) has been removed.
        onClose={onDelete}
        closeTitle="Remove from kit (library 元 clip は影響なし)"
      />
      <aside className="kit-event-side">
        <div
          className="kit-event-side-mode-group"
          role="radiogroup"
          aria-label="再生モード"
        >
          {MODE_OPTIONS.map((opt) => {
            const active = currentChoice === opt.choice
            const isBoth = opt.choice === 'both'
            return (
              <button
                key={opt.choice}
                type="button"
                role="radio"
                className={`kit-event-side-mode ${active ? 'active' : ''} ${isBoth ? 'kit-event-side-mode--both' : ''}`}
                onClick={() => pickChoice(opt.choice)}
                title={opt.title}
                aria-checked={active}
              >
                <span className="kit-event-side-mode-sym">{opt.symbol}</span>
                <span className="kit-event-side-mode-label">{opt.label}</span>
              </button>
            )
          })}
        </div>
      </aside>
    </div>
  )
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}KB`
  return `${(n / 1024 / 1024).toFixed(1)}MB`
}
