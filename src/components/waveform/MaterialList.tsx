import type { ReactNode } from 'react'
import { useI18n } from '@/i18n/I18nProvider'
import './EventsPanel.css'

/**
 * An event's candidate materials (`sfx.sounds` / a route's `clips`; the first is the representative,
 * DEC-085). One grid row each: ▶, the name, ★ (make it the representative), remove, plus `extra`.
 * With `onSelect`, a click anywhere on the row (not on its controls) selects the material; ▶ only plays.
 * Used by the editor's Events panel and the Scene tab's event details.
 */
export function MaterialList({ items, active, onPlay, onSelect, onReorder, onRemove, minItems, extra, below, label }: {
  items: readonly string[]
  /** The row shown in the waveform panel (highlighted). */
  active?: string | null
  onPlay: (name: string) => void
  /** Shows the material (waveform panel) without playing it. */
  onSelect?: (name: string) => void
  /** New order (★ moves a material first); null = read only. */
  onReorder: ((items: string[]) => void) | null
  /** Removes one (offered only while more than `minItems` remain); null = read only. */
  onRemove: ((items: string[]) => void) | null
  minItems?: number
  extra?: (name: string) => ReactNode
  /** A full-width line under the row (e.g. the remake comment field); null = none. */
  below?: (name: string) => ReactNode
  label: string
}) {
  const { t } = useI18n()
  const removable = (minItems: number) => items.length > minItems
  return <ul className="events-materials" aria-label={label}>
    {items.map((name, i) => <li key={name} className={`events-mat ${active === name ? 'active' : ''} ${onSelect ? 'selectable' : ''}`}
      onClick={onSelect ? e => { if (!(e.target as HTMLElement).closest('button, input, select, textarea, a')) onSelect(name) } : undefined}>
      <button type="button" className="agent-icon-btn" aria-label={t('events.mat.play', { name })} title={t('events.mat.play', { name })} onClick={() => onPlay(name)}>▶</button>
      {onSelect ? <span className="events-mat-name" role="button" tabIndex={0} title={t('events.mat.show', { name })}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(name) } }}>{name}</span>
        : <span className="events-mat-name" title={name}>{name}</span>}
      {/* ★ only with two or more candidates (one is trivially the representative). */}
      {items.length < 2 ? <span /> : onReorder ? <button type="button" className={`agent-icon-btn events-mat-star ${i === 0 ? 'on' : ''}`} disabled={i === 0}
        aria-label={t(i === 0 ? 'events.mat.representative' : 'events.mat.makeRepresentative')} title={t(i === 0 ? 'events.mat.representative' : 'events.mat.makeRepresentative')}
        onClick={() => onReorder([name, ...items.filter(x => x !== name)])}>{i === 0 ? '★' : '☆'}</button>
        : <span className="events-mat-star on" title={i === 0 ? t('events.mat.representative') : ''}>{i === 0 ? '★' : ''}</span>}
      {onRemove && removable(minItems ?? 0) ? <button type="button" className="agent-icon-btn" title={t('events.mat.removeHint')} onClick={() => onRemove(items.filter(x => x !== name))}>{t('events.mat.remove')}</button> : <span />}
      {extra ? extra(name) : <span />}
      {below?.(name)}
    </li>)}
  </ul>
}
