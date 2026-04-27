import { type DragEvent } from 'react'
import type { KitEvent, KitEventMode, LibraryClip } from '@/types/library'
import { ClipCard } from '../shared/ClipCard'
import './KitEventRow.css'

const DND_TYPE_KIT_EVENT = 'application/x-hapbeat-kit-event'

export interface KitEventRowProps {
  event: KitEvent
  clip: LibraryClip | null
  playing: boolean
  showDetails: boolean
  selected: boolean
  onSelect: () => void
  onTogglePlay: () => void
  onIntensityChange: (v: number) => void
  onModeChange: (mode: KitEventMode) => void
  onDelete: () => void
  onDragOverRow: (e: DragEvent) => void
  dragOverIndicator: boolean
}

interface ModeOption {
  value: KitEventMode
  symbol: string
  label: string
  title: string
}

// `stream_source` (LIVE) is retained in the type system + manifest schema
// for future use, but the Unity SDK retired it on 2026-04-22 in favour
// of StreamClip + ParameterBinding (commit 13663f0). The button is
// hidden from the UI; the value stays a valid `KitEventMode` so any
// older kits still load without errors.
const MODE_OPTIONS: ModeOption[] = [
  { value: 'command', symbol: '>', label: 'FIRE', title: 'Fire — デバイス内蔵 WAV を再生 (Event ID + 強度を UDP で送信)' },
  { value: 'stream_clip', symbol: '♪', label: 'CLIP', title: 'Stream Clip — SDK が Kit の WAV を UDP でストリーム' },
  // { value: 'stream_source', symbol: '~', label: 'LIVE', title: 'Stream Source — Unity SDK 廃止 (2026-04-22)' },
]

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
  clip,
  playing,
  showDetails,
  selected,
  onSelect,
  onTogglePlay,
  onIntensityChange,
  onModeChange,
  onDelete,
  onDragOverRow,
  dragOverIndicator,
}: KitEventRowProps) {
  const mode = event.mode ?? 'command'

  // clip name / details — same for all modes.
  // stream_source も stream-clips/ に WAV を持つ (Unity SDK が AudioSource の
  // デフォルトクリップとして参照する)。clip 未設定時のみフォールバック表示。
  const name = clip?.name ?? '(missing clip)'
  const details = clip
    ? `${Math.round(clip.duration * 1000)}ms | ${clip.channels === 1 ? 'Mono' : 'Stereo'} | ${clip.sampleRate / 1000}kHz | ${formatBytes(clip.fileSize)}`
    : undefined
  const tags = clip?.tags

  // Kit-side cards are intentionally non-editable: editing the clip
  // here would mutate the same LibraryClip in the library too, which
  // contradicts the new "kit references library, library is the
  // source of truth" model. Click the clip in the Library panel to
  // edit name / note / tags.
  const cardActions: { label: string; onClick: () => void; title: string }[] = []

  return (
    <div
      className={`kit-event-wrap ${dragOverIndicator ? 'drag-over-indicator' : ''} ${selected ? 'is-selected' : ''}`}
      onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); onDragOverRow(e) }}
    >
      <ClipCard
        name={name}
        eventId={event.eventId}
        eventIdEmpty={!event.eventId && mode !== 'stream_source'}
        details={details}
        tags={tags}
        showDetails={showDetails}
        intensity={event.intensity}
        onIntensityChange={onIntensityChange}
        playing={playing}
        onTogglePlay={onTogglePlay}
        selected={selected}
        onSelect={onSelect}
        dataCardId={event.id}
        wiper={null}
        drag={{ type: DND_TYPE_KIT_EVENT, payload: JSON.stringify({ kitEventId: event.id }), effect: 'move', dragTitle: 'ドラッグして並び替え' }}
        actions={cardActions}
      />
      <aside className="kit-event-side">
        <div className="kit-event-side-mode-group">
          {MODE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              className={`kit-event-side-mode ${mode === opt.value ? 'active' : ''}`}
              onClick={() => onModeChange(opt.value)}
              title={opt.title}
              aria-pressed={mode === opt.value}
            >
              <span className="kit-event-side-mode-sym">{opt.symbol}</span>
              <span className="kit-event-side-mode-label">{opt.label}</span>
            </button>
          ))}
        </div>
      </aside>
      <button
        className="kit-event-delete-corner"
        onClick={onDelete}
        title="Remove from kit"
        aria-label="Remove from kit"
      >×</button>
    </div>
  )
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}KB`
  return `${(n / 1024 / 1024).toFixed(1)}MB`
}
