import type { EventMark } from '@/utils/editorUiSettings'

/** Decisions made with this clip, or with the AI candidate it was adopted from (description `trial:<trialId>/<candidateId>`). */
export function clipEventMarks(clip: { id: string; description?: string }, marks: Record<string, EventMark[]>): EventMark[] {
  const fromTrial = clip.description?.startsWith('trial:') ? marks[clip.description.slice('trial:'.length)] ?? [] : []
  return [...(marks[clip.id] ?? []), ...fromTrial]
}

/** "♪ event" (sound) / "≋ event" (haptic) badges of the events a clip / candidate was decided for. */
export function EventMarkBadges({ marks }: { marks: EventMark[] }) {
  if (!marks.length) return null
  return <span className="editor-event-badges">{marks.map(m => <span key={`${m.project}:${m.event}:${m.target}`} className="editor-event-badge" title={m.project}>{m.target === 'sound' ? '♪' : '≋'} {m.event}</span>)}</span>
}
