import type { ReactNode } from 'react'
import { useI18n } from '@/i18n/I18nProvider'
import './EventsPanel.css'
import { KindIcon } from '@/components/common/KindIcon'
import { cardProps } from '@/utils/cardListKeys'

/**
 * An event's materials (DEC-089): the starred ones that play (`sfx.sounds` / a route's `clips`; the first is the
 * representative), then the unstarred alternates (muted, never played). One grid row each: ▶ (auditions it, starred
 * or not), the name, ★ (toggle: star / unstar; the last ★ comes off too, DEC-092), remove, plus `extra`.
 * With `onSelect`, a click anywhere on the row (not on its controls) selects the material; ▶ only plays; the rows are cards
 * of a list (cardListKeys: ↑/↓ in the editor's event details select the next one, Space plays it).
 * Used by the editor's Events panel and the Scene tab's event details.
 */
export function MaterialList({ kind, items, alternates = [], active, onPlay, onSelect, onStar, onRemove, minItems, extra, below, label, describe }: {
  /** Sound or haptic materials: each row starts with that icon. */
  kind: 'sound' | 'haptic'
  /** The starred materials (first = representative). */
  items: readonly string[]
  /** The unstarred materials (listed after the starred ones). */
  alternates?: readonly string[]
  /** The row shown in the waveform panel (highlighted). */
  active?: string | null
  onPlay: (name: string) => void
  /** Shows the material (waveform panel) without playing it. */
  onSelect?: (name: string) => void
  /** ★ on / off; null = read only. */
  onStar: ((name: string, on: boolean) => void) | null
  /** Removes one from the event; null = read only. */
  onRemove: ((name: string) => void) | null
  /** Materials (starred or not) that always stay: a route keeps one. */
  minItems?: number
  extra?: (name: string) => ReactNode
  /** A full-width line under the row (e.g. the remake comment field); null = none. */
  below?: (name: string) => ReactNode
  label: string
  /** Extra tooltip lines for a material's name (editor: what the AI said about it); null = none. */
  describe?: (name: string) => string | null
}) {
  const { t } = useI18n()
  const removable = items.length + alternates.length > (minItems ?? 0)
  const titled = (base: string, name: string) => [base, describe?.(name)].filter(Boolean).join('\n')
  const rows = [...items.map((name, i) => ({ name, starred: true, first: i === 0 })), ...alternates.map(name => ({ name, starred: false, first: false }))]
  const starTitle = (starred: boolean, first: boolean) => t(!starred ? 'events.mat.alternate' : first ? 'events.mat.representative' : 'events.mat.starred')
  return <ul className="events-materials" aria-label={label}>
    {rows.map(({ name, starred, first }) => <li key={name} className={`events-mat ${starred ? '' : 'alternate'} ${active === name ? 'active' : ''} ${onSelect ? 'selectable' : ''}`}
      {...(onSelect ? cardProps(() => onSelect(name)) : {})} onClick={onSelect ? e => { if (!(e.target as HTMLElement).closest('button, input, select, textarea, a')) onSelect(name) } : undefined}>
      <KindIcon kind={kind} />
      <button type="button" className="agent-icon-btn" aria-label={t('events.mat.play', { name })} title={t('events.mat.play', { name })} onClick={() => onPlay(name)}>▶</button>
      {onSelect ? <span className="events-mat-name" role="button" tabIndex={0} title={titled(t('events.mat.show', { name }), name)}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(name) } }}>{name}</span>
        : <span className="events-mat-name" title={titled(name, name)}>{name}</span>}
      {onStar ? <button type="button" className={`agent-icon-btn events-mat-star ${starred ? 'on' : ''}`} aria-pressed={starred}
        aria-label={starTitle(starred, first)} title={starTitle(starred, first)}
        onClick={() => onStar(name, !starred)}>{starred ? '★' : '☆'}</button>
        : <span className={`events-mat-star ${starred ? 'on' : ''}`} title={starTitle(starred, first)}>{starred ? '★' : '☆'}</span>}
      {onRemove && removable ? <button type="button" className="agent-icon-btn" title={t('events.mat.removeHint')} onClick={() => onRemove(name)}>{t('events.mat.remove')}</button> : <span />}
      {extra ? extra(name) : <span />}
      {below?.(name)}
    </li>)}
  </ul>
}
