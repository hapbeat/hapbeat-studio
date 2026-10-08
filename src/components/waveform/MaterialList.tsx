import type { ReactNode } from 'react'
import { useI18n } from '@/i18n/I18nProvider'
import { useToast } from '@/components/common/Toast'
import './EventsPanel.css'

/**
 * An event's materials (DEC-089): the starred ones that play (`sfx.sounds` / a route's `clips`; the first is the
 * representative), then the unstarred alternates (muted, never played). One grid row each: ▶ (auditions it, starred
 * or not), the name, ★ (toggle: star / unstar), remove, plus `extra`. Taking off the last ★ is refused with a hint.
 * With `onSelect`, a click anywhere on the row (not on its controls) selects the material; ▶ only plays.
 * Used by the editor's Events panel and the Scene tab's event details.
 */
export function MaterialList({ items, alternates = [], active, onPlay, onSelect, onStar, onRemove, minItems, extra, below, label, describe }: {
  /** The starred materials (first = representative). */
  items: readonly string[]
  /** The unstarred materials (listed after the starred ones). */
  alternates?: readonly string[]
  /** The row shown in the waveform panel (highlighted). */
  active?: string | null
  onPlay: (name: string) => void
  /** Shows the material (waveform panel) without playing it. */
  onSelect?: (name: string) => void
  /** ★ on / off; returns false when refused (the last ★); null = read only. */
  onStar: ((name: string, on: boolean) => boolean) | null
  /** Removes one from the event; null = read only. */
  onRemove: ((name: string) => void) | null
  /** Starred materials that always stay (a route keeps one clip); with alternates the last starred one stays too. */
  minItems?: number
  extra?: (name: string) => ReactNode
  /** A full-width line under the row (e.g. the remake comment field); null = none. */
  below?: (name: string) => ReactNode
  label: string
  /** Extra tooltip lines for a material's name (editor: what the AI said about it); null = none. */
  describe?: (name: string) => string | null
}) {
  const { t } = useI18n()
  const { toast } = useToast()
  const keep = Math.max(minItems ?? 0, alternates.length ? 1 : 0)
  const removable = (starred: boolean) => !starred || items.length > keep
  const titled = (base: string, name: string) => [base, describe?.(name)].filter(Boolean).join('\n')
  const rows = [...items.map((name, i) => ({ name, starred: true, first: i === 0 })), ...alternates.map(name => ({ name, starred: false, first: false }))]
  const starTitle = (starred: boolean, first: boolean) => t(!starred ? 'events.mat.alternate' : first ? 'events.mat.representative' : 'events.mat.starred')
  return <ul className="events-materials" aria-label={label}>
    {rows.map(({ name, starred, first }) => <li key={name} className={`events-mat ${starred ? '' : 'alternate'} ${active === name ? 'active' : ''} ${onSelect ? 'selectable' : ''}`}
      onClick={onSelect ? e => { if (!(e.target as HTMLElement).closest('button, input, select, textarea, a')) onSelect(name) } : undefined}>
      <button type="button" className="agent-icon-btn" aria-label={t('events.mat.play', { name })} title={t('events.mat.play', { name })} onClick={() => onPlay(name)}>▶</button>
      {onSelect ? <span className="events-mat-name" role="button" tabIndex={0} title={titled(t('events.mat.show', { name }), name)}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(name) } }}>{name}</span>
        : <span className="events-mat-name" title={titled(name, name)}>{name}</span>}
      {onStar ? <button type="button" className={`agent-icon-btn events-mat-star ${starred ? 'on' : ''}`} aria-pressed={starred}
        aria-label={starTitle(starred, first)} title={starTitle(starred, first)}
        onClick={() => { if (!onStar(name, !starred)) toast(t('events.mat.lastStar'), 'warning') }}>{starred ? '★' : '☆'}</button>
        : <span className={`events-mat-star ${starred ? 'on' : ''}`} title={starTitle(starred, first)}>{starred ? '★' : '☆'}</span>}
      {onRemove && removable(starred) ? <button type="button" className="agent-icon-btn" title={t('events.mat.removeHint')} onClick={() => onRemove(name)}>{t('events.mat.remove')}</button> : <span />}
      {extra ? extra(name) : <span />}
      {below?.(name)}
    </li>)}
  </ul>
}
