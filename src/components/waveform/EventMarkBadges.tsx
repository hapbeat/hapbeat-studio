import type { EventMark } from '@/utils/editorUiSettings'
import { KindIcon } from '@/components/common/KindIcon'

/** Decisions made with this clip, or with the AI candidate it was adopted from (description `trial:<trialId>/<candidateId>`). */
export function clipEventMarks(clip: { id: string; description?: string }, marks: Record<string, EventMark[]>): EventMark[] {
  const fromTrial = clip.description?.startsWith('trial:') ? marks[clip.description.slice('trial:'.length)] ?? [] : []
  return [...(marks[clip.id] ?? []), ...fromTrial]
}

/** Badges of the events a clip / candidate was decided for: the sound / haptic icon and the event. */
export function EventMarkBadges({ marks }: { marks: EventMark[] }) {
  if (!marks.length) return null
  return <span className="editor-event-badges">{marks.map(m => <EventMarkBadge key={`${m.project}:${m.event}:${m.target}`} mark={m} />)}</span>
}

/** One decided-for badge (sound / haptic icon, event name; the project in its tooltip). */
export function EventMarkBadge({ mark }: { mark: EventMark }) {
  return <span className={`editor-event-badge ${mark.target}`} title={mark.project}><KindIcon kind={mark.target} size={14} />{mark.event}</span>
}
