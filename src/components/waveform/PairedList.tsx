import type { ReactNode } from 'react'
import { useI18n } from '@/i18n/I18nProvider'
import { useSceneStore } from '@/stores/sceneStore'
import { movePair, type EffectiveEvent } from '@/utils/cueEvents'
import { materialIntensity, routeClips, setClipIntensity, setSoundIntensity, sfxSounds, type CueTable } from '@/utils/sceneCueTable'
import './EventsPanel.css'

type Edit = (change: (tb: CueTable) => CueTable | null) => boolean

/**
 * A paired cue's materials as pairs (variation.paired: sound i plays with clip i of every route), one line each:
 * `1  ♪ sound  ↔  ≋ clip`, ▶ (both together), the strengths of both (intensity, DEC-086) and ↑ / ↓ (the pair moves as
 * one, on every route of the same length). A side without a partner is shown in red. Shown for the first route; the
 * other routes follow the same order. Used by the editor's Events panel and the Scene tab's Event panel.
 */
export function PairedList({ e, edit, onPlay, onShow, active, extra }: {
  e: EffectiveEvent; edit: Edit
  /** Plays pair `index` (its sound and clip together; either may be missing). */
  onPlay: (index: number, sound: string | undefined, clip: string | undefined, at: string | undefined) => void
  /** Shows one side (editor: the waveform panel); absent = names are plain text. */
  onShow?: (target: 'sound' | 'haptic', name: string, at: string | undefined) => void
  /** The material shown in the waveform panel (highlighted). */
  active?: string | null
  /** Extra controls after a material (editor: Adjust / Remake). */
  extra?: (target: 'sound' | 'haptic', name: string) => ReactNode
}) {
  const { t } = useI18n()
  const table = useSceneStore(s => s.table)
  const sounds = sfxSounds(e.sfx), route = e.haptics[0], clips = route ? routeClips(route) : []
  const count = Math.max(sounds.length, clips.length)
  if (!table || !count) return null
  const strength = (target: 'sound' | 'haptic', name: string) => <input type="number" className="events-pair-level" min={0} max={1} step={0.05}
    value={materialIntensity(table, target, name)} aria-label={t('events.pair.level', { name })} title={t('events.pair.levelHint', { name })}
    onChange={ev => { const v = parseFloat(ev.target.value); if (Number.isFinite(v)) edit(tb => target === 'sound' ? setSoundIntensity(tb, name, v) : tb.clips[name] ? setClipIntensity(tb, name, v) : null) }} />
  const side = (target: 'sound' | 'haptic', name: string | undefined) => !name
    ? <span className="events-pair-missing">{t('events.pair.noPartner')}</span>
    : <span className={`events-pair-side ${active === name ? 'active' : ''}`}>
      <span className="events-pair-kind" aria-hidden="true">{target === 'sound' ? '♪' : '≋'}</span>
      {onShow ? <button type="button" className="agent-link events-pair-name" title={t('events.mat.show', { name })} onClick={() => onShow(target, name, route?.at)}>{name}</button>
        : <span className="events-pair-name" title={name}>{name}</span>}
      {strength(target, name)}{extra?.(target, name)}
    </span>
  return <ol className="events-pairs" aria-label={t('events.pair.heading')} title={t('events.pair.hint')}>
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
  </ol>
}
