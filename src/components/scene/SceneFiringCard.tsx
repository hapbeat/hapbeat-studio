import { useMemo, useRef, useState } from 'react'
import { useI18n } from '@/i18n/I18nProvider'
import { useSceneStore } from '@/stores/sceneStore'
import { useSceneSettings } from '@/stores/sceneSettings'
import { useSceneStrength } from '@/stores/sceneStrength'
import { effectiveOutput, useScenePlayback } from '@/stores/scenePlayback'
import { kitGainsFor } from '@/utils/sceneCueTable'
import { firingStrength, type FiringStrength } from '@/utils/sceneFiringGain'
import { median, strengthStep } from '@/utils/sceneStrength'
import { firingMoments, momentNumber, momentRangeText, shownIndexOf } from '@/utils/sceneTimelineEdit'
import { NumberField } from './SceneCuePanels'

/** The card's place when none is kept (CSS px from the timeline panel's top-right corner: under its info row). */
const DEFAULT_POS = { right: 8, top: 40 }
/** The strength slider's top (a firing gain above it is still kept; the slider then sits at its end). */
const SLIDER_MAX = 2

/** 「時刻をロック」 / 「強さをロック」 (studio-scene-ui.json): a locked axis never moves on a bar drag. One look in the timeline header and the card. */
export function SceneLockToggles() {
  const { t } = useI18n()
  const lockTime = useSceneSettings(s => s.lockTime)
  const lockGain = useSceneSettings(s => s.lockGain)
  const lock = (on: boolean, label: string, title: string, flip: () => void) =>
    <button type="button" className={on ? 'on' : ''} aria-pressed={on} title={title} onClick={e => { e.currentTarget.blur(); flip() }}>{label}</button>
  return <span className="scene-seg scene-tl-seg" role="group">
    {lock(lockTime, t('scene.lock.time'), t('scene.lock.timeHint'), () => useSceneSettings.getState().update({ lockTime: !lockTime }))}
    {lock(lockGain, t('scene.lock.gain'), t('scene.lock.gainHint'), () => useSceneSettings.getState().update({ lockGain: !lockGain }))}
  </span>
}

/** One selected firing as the card shows it: the shown event (edited time / gain), its strength and recorded values. */
interface Picked { index: number; name: string; t: number; gain: number; moment: number | null; strength: FiringStrength | null; recorded: { gain: number; t: number }; edited: boolean }

/**
 * The selected firings' card (DEC-112), floating over the timeline panel's top-right while firings are selected
 * (non-modal; moved by its grip, the place kept in studio-scene-ui.json `cardPos`). One firing: its moment number,
 * name and time; several: their count and moment range. Strength: a number box (one: its gain; several: the median,
 * typing sets all), a 0–2 slider (live via dragRatio, one undo step on release) and ▼▲ (±1 dB, Shift ±3 dB). Time: one
 * firing's absolute time / several firings' shift (frame-snapped), off while 「時刻をロック」. The locks, 「記録の値に戻す」,
 * the breakdown (material × event × this firing → sent, red when clipped) and Undo / Redo.
 */
export function SceneFiringCard() {
  const { t } = useI18n()
  const selected = useSceneStrength(s => s.selected)
  const dragRatio = useSceneStrength(s => s.dragRatio)
  const canUndo = useSceneStrength(s => s.undo.length > 0)
  const canRedo = useSceneStrength(s => s.redo.length > 0)
  const table = useSceneStore(s => s.table)
  const data = useSceneStore(s => s.data)
  const edited = useSceneStore(s => s.edited)
  const recorded = useSceneStore(s => s.recorded)
  const items = useSceneStore(s => s.items)
  const editsMatch = useSceneStore(s => s.editsMatch)
  const output = useScenePlayback(s => effectiveOutput(s))
  const kitGains = useSceneStore(s => kitGainsFor(s.projectKit?.clipGains, output))
  const lockTime = useSceneSettings(s => s.lockTime)
  const kept = useSceneSettings(s => s.cardPos)
  const [moving, setMoving] = useState<{ right: number; top: number } | null>(null)
  const [slider, setSlider] = useState<number | null>(null)
  const [shiftKey, setShiftKey] = useState(0)
  const card = useRef<HTMLDivElement>(null)

  const shownIdx = useMemo(() => data && edited ? shownIndexOf(data.full.events, edited.full.events) : new Map<number, number>(), [data, edited])
  const moments = useMemo(() => data ? firingMoments(items, data.full.events) : [], [items, data])
  const picked = useMemo((): Picked[] => {
    if (!data || !recorded) return []
    const events = data.full.events
    return [...selected].flatMap(i => {
      const k = shownIdx.get(i), ev = k === undefined ? undefined : events[k], rec = recorded.full.events[i]
      if (k === undefined || !ev || !rec) return []
      const strength = table ? firingStrength(table, events, ev, kitGains) : null
      return [{ index: i, name: ev.name, t: ev.t, gain: ev.gain ?? 1, moment: moments[k], strength, recorded: { gain: rec.gain ?? 1, t: rec.t }, edited: editsMatch.has(i) }]
    }).sort((a, b) => a.t - b.t)
  }, [selected, data, recorded, shownIdx, moments, table, kitGains, editsMatch])

  if (!picked.length || !data) return null
  const st = () => useSceneStrength.getState()
  const one = picked.length === 1 ? picked[0] : null
  const base = one ? one.gain : median(picked.map(p => p.gain))
  const live = dragRatio !== null ? base * dragRatio : base
  const fps = data.fps, end = data.full.levels.length / fps
  const pos = moving ?? kept ?? DEFAULT_POS
  const numbers = picked.flatMap(p => p.moment === null ? [] : [p.moment]), range = momentRangeText(numbers)
  const title = one ? t('scene.card.one', { num: one.moment === null ? '' : momentNumber(one.moment), name: one.name, t: one.t.toFixed(2) }).trim()
    : range ? t('scene.card.several', { count: picked.length, range }) : t('scene.card.severalNoRange', { count: picked.length })
  const clipped = picked.filter(p => p.strength && p.strength.sent > 1).length
  const red = one?.strength ? one.strength.sent * (dragRatio ?? 1) > 1 : clipped > 0
  const other = one?.strength && Math.abs(one.strength.scale - 1) > 1e-9 ? t('scene.strength.other', { value: one.strength.scale.toFixed(2) }) : ''

  /** The slider let go (or its key released): its value applied as one undo step (scaled from the shown value). */
  const commitSlider = () => {
    if (slider === null) return
    setSlider(null); st().setDragRatio(null)
    if (base > 0) st().scaleSelected(slider / base); else st().setSelected(slider)
  }
  /** The grip pressed: the card follows the pointer inside the panel; its place is kept on release. */
  const grip = (event: React.PointerEvent) => {
    const el = card.current, panel = el?.offsetParent as HTMLElement | null
    if (!el || !panel) return
    event.preventDefault()
    const x0 = event.clientX, y0 = event.clientY, from = pos
    const maxRight = Math.max(0, panel.clientWidth - el.offsetWidth), maxTop = Math.max(0, panel.clientHeight - el.offsetHeight)
    let next = from
    const move = (e: PointerEvent) => {
      next = { right: Math.round(Math.max(0, Math.min(maxRight, from.right - (e.clientX - x0)))), top: Math.round(Math.max(0, Math.min(maxTop, from.top + (e.clientY - y0)))) }
      setMoving(next)
    }
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); setMoving(null); useSceneSettings.getState().update({ cardPos: next }) }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  }

  return <div ref={card} className="scene-card" role="group" aria-label={t('scene.strength.selected')} style={{ right: pos.right, top: pos.top }}>
    <div className="scene-card-head">
      <span className="scene-card-grip" title={t('scene.card.move')} onPointerDown={grip} aria-hidden="true">⠿</span>
      <span className="scene-card-title" title={title}>{title}</span>
    </div>
    <div className="scene-card-row">
      <span className="scene-card-label" title={t(one ? 'scene.card.strengthHint' : 'scene.card.strengthHintMany')}>{t('scene.card.strength')}</span>
      <NumberField value={Number(live.toFixed(3))} min={0} max={10} step={0.01} label={t('scene.card.strength')} onCommit={v => st().setSelected(Math.max(0, v))} />
      <input type="range" min={0} max={SLIDER_MAX} step={0.01} value={Math.min(SLIDER_MAX, slider ?? live)} aria-label={t('scene.card.slider')} title={t(one ? 'scene.card.sliderHint' : 'scene.card.sliderHintMany')}
        onChange={e => { const v = Number(e.target.value); setSlider(v); if (base > 0) st().setDragRatio(v / base) }}
        onPointerUp={e => { commitSlider(); e.currentTarget.blur() }} onKeyUp={commitSlider} onBlur={commitSlider} />
      <button type="button" className="scene-icon-btn" title={t('scene.strength.downHint')} onClick={e => { e.currentTarget.blur(); st().scaleSelected(1 / strengthStep(e.shiftKey)) }}>▼</button>
      <button type="button" className="scene-icon-btn" title={t('scene.strength.upHint')} onClick={e => { e.currentTarget.blur(); st().scaleSelected(strengthStep(e.shiftKey)) }}>▲</button>
    </div>
    <div className="scene-card-row" title={lockTime ? t('scene.card.timeLocked') : undefined}>
      {one ? <>
        <span className="scene-card-label" title={t('scene.card.timeHint')}>{t('scene.card.time')}</span>
        <NumberField value={Number(one.t.toFixed(3))} min={0} max={end} step={1 / fps} disabled={lockTime} label={t('scene.card.time')} onCommit={v => st().moveSelected(v - one.t)} />
      </> : <>
        <span className="scene-card-label" title={t('scene.card.shiftHint')}>{t('scene.card.shift')}</span>
        <NumberField key={shiftKey} value={0} min={-end} max={end} step={1 / fps} disabled={lockTime} label={t('scene.card.shift')} onCommit={v => { if (v) st().moveSelected(v); setShiftKey(k => k + 1) }} />
      </>}
    </div>
    <div className="scene-card-row">
      <SceneLockToggles />
    </div>
    <div className="scene-card-row">
      <button type="button" className="scene-icon-btn" disabled={!picked.some(p => p.edited)}
        title={one ? t('scene.card.resetHint', { gain: one.recorded.gain.toFixed(3), t: one.recorded.t.toFixed(3) }) : t('scene.card.resetHintMany')}
        onClick={e => { e.currentTarget.blur(); st().resetSelected() }}>{t('scene.card.reset')}</button>
      <button type="button" className="scene-icon-btn" disabled={!canUndo} title={t('scene.strength.undoHint')} onClick={e => { e.currentTarget.blur(); st().undoLast() }}>{t('scene.strength.undo')}</button>
      <button type="button" className="scene-icon-btn" disabled={!canRedo} title={t('scene.strength.redoHint')} onClick={e => { e.currentTarget.blur(); st().redoLast() }}>{t('scene.strength.redo')}</button>
    </div>
    <div className={`scene-card-line ${red ? 'clipped' : ''}`}>
      {one?.strength ? t('scene.card.breakdown', {
        material: one.strength.material.toFixed(2), route: one.strength.route.toFixed(2), other, firing: live.toFixed(2), sent: (one.strength.sent * (dragRatio ?? 1)).toFixed(2),
      }) : clipped ? t('scene.strength.clipped', { count: clipped }) : ''}
    </div>
  </div>
}
