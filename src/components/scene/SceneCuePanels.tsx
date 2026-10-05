import { useEffect, useRef } from 'react'
import { useI18n } from '@/i18n/I18nProvider'
import { useSceneStore } from '@/stores/sceneStore'
import { familyColor, momentCues } from '@/utils/sceneData'
import { resolveEventName } from '@/utils/cueEvents'
import { useScene } from './sceneContext'

/**
 * Body position labels from the device address (lib.at, contracts device-addressing):
 * `pos_neck` → neck, `pos_l_wrist` → l_wrist; `hand` = the acting hand's wrist, `both` = both wrists.
 */
export function useAtLabel() {
  const { t } = useI18n()
  return (at: string) => at === 'hand' ? t('scene.at.hand') : at === 'both' ? t('scene.at.both') : at.replace(/^pos_/, '')
}
/** The hand a recorded moment's haptics went to (viewer-data `hand`: both / right / left), in words. */
export function useHandLabel() {
  const { t } = useI18n()
  return (hand: string) => hand === 'both' ? t('scene.hand.both') : hand === 'right' ? t('scene.hand.right') : hand === 'left' ? t('scene.hand.left') : hand
}
/** Gain / volume as shown next to its name ("gain 1.0", "gain 0.35"). */
export const formatGain = (x: number) => Number.isInteger(x * 10) ? x.toFixed(1) : String(Math.round(x * 1000) / 1000)

/** Number input committed like the viewer's: on the native change event (spinner, Enter, blur), not on every keystroke. */
export function NumberField({ value, min, max, step, disabled, onCommit, label }: { value: number | ''; min: number; max: number; step: number; disabled?: boolean; onCommit: (value: number) => void; label: string }) {
  const input = useRef<HTMLInputElement>(null)
  const commit = useRef(onCommit); commit.current = onCommit
  useEffect(() => { if (input.current && document.activeElement !== input.current) input.current.value = String(value) }, [value])
  useEffect(() => {
    const el = input.current
    if (!el) return
    const change = () => { const x = parseFloat(el.value); commit.current(Number.isFinite(x) ? x : min) }
    el.addEventListener('change', change)
    return () => el.removeEventListener('change', change)
  }, [min])
  return <input ref={input} type="number" className="scene-number" aria-label={label} defaultValue={value} min={min} max={max} step={step} disabled={disabled} />
}

/** Which cue the Event panel shows: a list of every cue, plus one-click chips for the other cues of the same moment. */
export function CuePicker() {
  const { t } = useI18n()
  const { runtime } = useScene()
  const table = useSceneStore(s => s.table)
  const lib = useSceneStore(s => s.lib)
  const sel = useSceneStore(s => s.sel)
  useSceneStore(s => s.cur)
  if (!table || !lib) return null
  const name = (sel && resolveEventName(table, sel.name)?.ref.cue) ?? ''
  const others = name ? momentCues(runtime.events(), sel!.t, lib.ticks).filter(n => n !== name) : []
  return <div className="scene-pick">
    <span className="scene-dim">{t('scene.editing')}</span>
    <select className="scene-grow" value={name} aria-label={t('scene.editing')} onChange={e => {
      const n = e.target.value, time = runtime.video.currentTime
      e.target.blur()
      if (!n) return
      const near = runtime.events().filter(x => x.name === n).sort((a, b) => Math.abs(a.t - time) - Math.abs(b.t - time))[0]
      useSceneStore.getState().selectCue(n, near ? near.t : null)
    }}>
      <option value="">{t('scene.pickHint')}</option>
      {Object.keys(table.cues).map(n => <option key={n} value={n}>{n}</option>)}
    </select>
    <div className="scene-chips">
      {others.length > 0 && <>{t('scene.sameMoment')}{others.map(n => <button key={n} type="button" style={{ color: familyColor(lib, n) }}
        onClick={e => { e.currentTarget.blur(); useSceneStore.getState().selectCue(n, sel!.t) }}>{n}</button>)}</>}
    </div>
  </div>
}
