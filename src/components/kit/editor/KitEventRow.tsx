import { type DragEvent } from 'react'
import type { KitEvent, LibraryClip } from '@/types/library'
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
  onLoopChange: (loop: boolean) => void
  onEditClip: () => void
  onDelete: () => void
  onDragOverRow: (e: DragEvent) => void
  dragOverIndicator: boolean
}

/**
 * Kit event = the same ClipCard used in the library, plus a kit-only
 * side panel on the right holding Loop + × (remove-from-kit).
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
  onLoopChange,
  onEditClip,
  onDelete,
  onDragOverRow,
  dragOverIndicator,
}: KitEventRowProps) {
  const name = clip?.name ?? '(missing clip)'
  const details = clip
    ? `${Math.round(clip.duration * 1000)}ms | ${clip.channels === 1 ? 'Mono' : 'Stereo'} | ${clip.sampleRate / 1000}kHz | ${formatBytes(clip.fileSize)}`
    : undefined
  const tags = clip?.tags

  return (
    <div
      className={`kit-event-wrap ${dragOverIndicator ? 'drag-over-indicator' : ''}`}
      onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); onDragOverRow(e) }}
    >
      <ClipCard
        name={name}
        eventId={event.eventId}
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
        actions={[
          { label: 'Edit', onClick: onEditClip, title: 'Edit the underlying clip' },
        ]}
      />
      <aside className="kit-event-side">
        <button
          className="kit-event-side-delete"
          onClick={onDelete}
          title="Remove from kit"
          aria-label="Remove from kit"
        >×</button>
        <div className="kit-event-side-loop-group">
          <span className="kit-event-side-loop-label">Loop</span>
          <button
            className={`kit-event-side-loop ${event.loop ? 'on' : ''}`}
            onClick={() => onLoopChange(!event.loop)}
            title={event.loop ? 'Looping — click to disable' : 'Not looping — click to enable'}
            aria-pressed={event.loop}
          >↻</button>
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
