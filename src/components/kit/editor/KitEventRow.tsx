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
  onLoopChange: (loop: boolean) => void
  onModeChange: (mode: KitEventMode) => void
  onEditClip: () => void
  onDelete: () => void
  onDragOverRow: (e: DragEvent) => void
  dragOverIndicator: boolean
}

const MODE_OPTIONS: { value: KitEventMode; label: string; title: string }[] = [
  { value: 'command', label: 'CMD', title: 'Command — device plays WAV from flash' },
  { value: 'stream_clip', label: 'STR', title: 'Stream Clip — SDK streams WAV over UDP' },
  { value: 'stream_source', label: 'SRC', title: 'Stream Source — SDK captures live audio and streams it' },
]

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
  onModeChange,
  onEditClip,
  onDelete,
  onDragOverRow,
  dragOverIndicator,
}: KitEventRowProps) {
  const mode = event.mode ?? 'command'
  const isSrc = mode === 'stream_source'

  // stream_source: no clip is needed — show a descriptive label instead of the clip name
  const name = isSrc
    ? '— live source —'
    : (clip?.name ?? '(missing clip)')

  const details = isSrc
    ? 'SDK captures AudioSource at runtime; no audio file needed'
    : clip
      ? `${Math.round(clip.duration * 1000)}ms | ${clip.channels === 1 ? 'Mono' : 'Stereo'} | ${clip.sampleRate / 1000}kHz | ${formatBytes(clip.fileSize)}`
      : undefined
  const tags = isSrc ? undefined : clip?.tags

  // stream_source: no clip to preview or edit; suppress those actions
  const cardActions = isSrc
    ? []
    : [{ label: 'Edit', onClick: onEditClip, title: 'Edit the underlying clip' }]

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
        playDisabled={isSrc}
        selected={selected}
        onSelect={onSelect}
        dataCardId={event.id}
        wiper={null}
        drag={{ type: DND_TYPE_KIT_EVENT, payload: JSON.stringify({ kitEventId: event.id }), effect: 'move', dragTitle: 'ドラッグして並び替え' }}
        actions={cardActions}
      />
      <aside className="kit-event-side">
        <button
          className="kit-event-side-delete"
          onClick={onDelete}
          title="Remove from kit"
          aria-label="Remove from kit"
        >×</button>
        <div className="kit-event-side-mode-group">
          {MODE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              className={`kit-event-side-mode ${mode === opt.value ? 'active' : ''}`}
              onClick={() => onModeChange(opt.value)}
              title={opt.title}
              aria-pressed={mode === opt.value}
            >{opt.label}</button>
          ))}
        </div>
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
