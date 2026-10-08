import type { ReactNode } from 'react'
import { useI18n } from '@/i18n/I18nProvider'
import { useToast } from '@/components/common/Toast'
import { useSceneStore } from '@/stores/sceneStore'
import { movePair, removeMaterial, setStarred, type EffectiveEvent } from '@/utils/cueEvents'
import { materialIntensity, routeAlternates, routeClips, setClipIntensity, setSoundIntensity, sfxAlternates, sfxSounds, type CueTable } from '@/utils/sceneCueTable'
import { MaterialList } from './MaterialList'
import { KindIcon } from '@/components/common/KindIcon'
import './EventsPanel.css'

type Edit = (change: (tb: CueTable) => CueTable | null) => boolean

/**
 * A paired cue's materials as pairs (variation.paired: sound i plays with clip i of every route), one line each:
 * `1  [sound icon] sound  ↔  [haptic icon] clip`, ▶ (both together), the strengths of both (intensity, DEC-086) and ↑ / ↓ (the pair moves as
 * one, on every route of the same length). A side without a partner is shown in red. Shown for the first route; the
 * other routes follow the same order. Only starred materials pair (DEC-089): each side's ★ unstars it, and the
 * unstarred alternates (sounds, then the first route's clips) are listed under the pairs with ☆ to star them (appended).
 * Used by the editor's Events panel and the Scene tab's Event panel.
 */
export function PairedList({ e, edit, onPlay, onShow, active, extra, describe }: {
  e: EffectiveEvent; edit: Edit
  /** Plays pair `index` (its sound and clip together; either may be missing); an alternate alone with index −1. */
  onPlay: (index: number, sound: string | undefined, clip: string | undefined, at: string | undefined) => void
  /** Shows one side (editor: the waveform panel); absent = names are plain text. */
  onShow?: (target: 'sound' | 'haptic', name: string, at: string | undefined) => void
  /** The material shown in the waveform panel (highlighted). */
  active?: string | null
  /** Extra controls after a material (editor: Adjust / Remake). */
  extra?: (target: 'sound' | 'haptic', name: string) => ReactNode
  /** Extra tooltip lines for a material's name (editor: what the AI said about it); null = none. */
  describe?: (name: string) => string | null
}) {
  const { t } = useI18n()
  const { toast } = useToast()
  const table = useSceneStore(s => s.table)
  const titled = (base: string, name: string) => [base, describe?.(name)].filter(Boolean).join('\n')
  const sounds = sfxSounds(e.sfx), route = e.haptics[0], clips = route ? routeClips(route) : []
  const count = Math.max(sounds.length, clips.length)
  const soundAlts = sfxAlternates(e.sfx), clipAlts = route ? routeAlternates(route) : []
  if (!table || !(count + soundAlts.length + clipAlts.length)) return null
  const own = (target: 'sound' | 'haptic') => target === 'sound' ? e.own.sfx : e.own.haptics
  const star = (target: 'sound' | 'haptic', name: string, on: boolean) => edit(tb => setStarred(tb, e.ref, target, 0, name, on))
  const remove = (target: 'sound' | 'haptic', name: string) => edit(tb => removeMaterial(tb, e.ref, target, 0, name))
  const alternates = (target: 'sound' | 'haptic', names: string[]) => names.length > 0 && <MaterialList kind={target} items={[]} alternates={names} label={t(target === 'sound' ? 'events.sound' : 'events.haptic')}
    active={active} onPlay={name => target === 'sound' ? onPlay(-1, name, undefined, undefined) : onPlay(-1, undefined, name, route?.at)}
    onSelect={onShow ? name => onShow(target, name, route?.at) : undefined}
    onStar={own(target) ? (name, on) => star(target, name, on) : null} onRemove={own(target) ? name => remove(target, name) : null}
    extra={extra ? name => extra(target, name) : undefined} describe={describe} />
  const strength = (target: 'sound' | 'haptic', name: string) => <input type="number" className="events-pair-level" min={0} max={1} step={0.05}
    value={materialIntensity(table, target, name)} aria-label={t('events.pair.level', { name })} title={t('events.pair.levelHint', { name })}
    onChange={ev => { const v = parseFloat(ev.target.value); if (Number.isFinite(v)) edit(tb => target === 'sound' ? setSoundIntensity(tb, name, v) : tb.clips[name] ? setClipIntensity(tb, name, v) : null) }} />
  const side = (target: 'sound' | 'haptic', name: string | undefined) => !name
    ? <span className="events-pair-missing">{t('events.pair.noPartner')}</span>
    : <span className={`events-pair-side ${active === name ? 'active' : ''}`}>
      <KindIcon kind={target} />
      {own(target) ? <button type="button" className="agent-icon-btn events-mat-star on" aria-pressed title={t('events.mat.starred')}
        onClick={() => { if (!star(target, name, false)) toast(t('events.mat.lastStar'), 'warning') }}>★</button>
        : <span className="events-mat-star on" aria-hidden="true">★</span>}
      {onShow ? <button type="button" className="agent-link events-pair-name" title={titled(t('events.mat.show', { name }), name)} onClick={() => onShow(target, name, route?.at)}>{name}</button>
        : <span className="events-pair-name" title={titled(name, name)}>{name}</span>}
      {strength(target, name)}{extra?.(target, name)}
    </span>
  return <><ol className="events-pairs" aria-label={t('events.pair.heading')} title={t('events.pair.hint')}>
    {Array.from({ length: count }, (_, i) => <li key={i} className="events-pair">
      <span className="events-pair-num">{i + 1}</span>
      <button type="button" className="agent-icon-btn" aria-label={t('events.pair.play', { n: i + 1 })} title={t('events.pair.play', { n: i + 1 })} onClick={() => onPlay(i, sounds[i], clips[i], route?.at)}>▶</button>
      {side('sound', sounds[i])}
      <span className="events-pair-arrow" aria-hidden="true">↔</span>
      {side('haptic', clips[i])}
      <span className="events-pair-move">
        <button type="button" className="agent-icon-btn" disabled={i === 0 || i >= Math.min(sounds.length, clips.length)} aria-label={t('events.pair.up')} title={t('events.pair.up')} onClick={() => edit(tb => movePair(tb, e.ref, i, -1))}>↑</button>
        <button type="button" className="agent-icon-btn" disabled={i >= Math.min(sounds.length, clips.length) - 1} aria-label={t('events.pair.down')} title={t('events.pair.down')} onClick={() => edit(tb => movePair(tb, e.ref, i, 1))}>↓</button>
      </span>
    </li>)}
  </ol>{alternates('sound', soundAlts)}{alternates('haptic', clipAlts)}</>
}
