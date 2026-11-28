import { useMemo, useRef, useState } from 'react'
import { useI18n } from '@/i18n/I18nProvider'
import { useSceneStore } from '@/stores/sceneStore'
import { isVideoProject } from '@/utils/sceneData'
import { useSceneSettings } from '@/stores/sceneSettings'
import { useSceneStrength } from '@/stores/sceneStrength'
import { effectiveOutput, useScenePlayback } from '@/stores/scenePlayback'
import { kitGainsFor } from '@/utils/sceneCueTable'
import { firingStrength, type FiringStrength } from '@/utils/sceneFiringGain'
import { median, strengthStep } from '@/utils/sceneStrength'
import { firingNumber, firingNumbers, numberRangeText, shownIndexOf } from '@/utils/sceneTimelineEdit'
import { NumberField } from './SceneCuePanels'
import { changedFiring, changeFailed, ChangeEventForm } from './SceneMomentsPanel'
import { targetKey, targetsOf, targetValue, targetValues, type GainTarget } from '@/utils/sceneGameEdits'
import { eventKey } from '@/utils/cueEvents'
import type { CueTable } from '@/utils/sceneCueTable'

/** The gain slider's top (a firing gain above it is still kept; the slider then sits at its end). */
const SLIDER_MAX = 2

/** 「時刻をロック」 / 「ゲインをロック」 (studio-scene-ui.json): a locked axis never moves (time: bar drag and the 「発生」 panel; gain: bar drag, Alt + wheel, ↑ ↓ and the panel). One look in the timeline header and the panel. */
export function SceneLockToggles() {
  const { t } = useI18n()
  const lockTime = useSceneSettings(s => s.lockTime)
  const lockGain = useSceneSettings(s => s.lockGain)
  // A game project: no firing moves in time (DEC-114), so there is no time lock to show.
  const video = useSceneStore(s => isVideoProject(s.lib))
  const lock = (on: boolean, label: string, title: string, flip: () => void) =>
    <button type="button" className={on ? 'on' : ''} aria-pressed={on} title={title} onClick={e => { e.currentTarget.blur(); flip() }}>{label}</button>
  return <span className="scene-seg scene-tl-seg" role="group">
    {video && lock(lockTime, t('scene.lock.time'), t('scene.lock.timeHint'), () => useSceneSettings.getState().update({ lockTime: !lockTime }))}
    {lock(lockGain, t('scene.lock.gain'), t('scene.lock.gainHint'), () => useSceneSettings.getState().update({ lockGain: !lockGain }))}
  </span>
}

/** One selected firing as the panel shows it: the shown event (edited time / gain), its strength and recorded values. */
interface Picked { index: number; name: string; t: number; gain: number; num: number | null; strength: FiringStrength | null; recorded: { gain: number; t: number }; edited: boolean }

/**
 * 「発生」 dock panel (DEC-112): the firings selected on the timeline (or from the moments list). One firing: its number
 * (the moments list's row), name and time; several: their count and number range. Compact (a two-column grid where it
 * fits). ゲイン: a number box (one: its gain; several: the median, typing sets all), a 0–2 slider (live via dragRatio,
 * one undo step on release) and ▼▲ (±1 dB, Shift ±3 dB), off while 「ゲインをロック」. 時刻: one firing's absolute time /
 * several firings' ± shift (frame-snapped), off while 「時刻をロック」. The locks, 「記録の値に戻す」, Undo / Redo and the
 * breakdown (material × event × this firing → sent, red when clipped). Nothing selected: one line saying how to select.
 * A game project (DEC-114, GameFiring): the gain edited is the event's (or situation's) multiplier in the cue table,
 * the time cannot change (one line says why), 「状況を分ける…」 makes one firing another situation, and a line counts the
 * entries of a viewer-edits.json it does not use.
 */
export function SceneFiringPanel() {
  const { t } = useI18n()
  const selected = useSceneStrength(s => s.selected)
  const dragRatio = useSceneStrength(s => s.dragRatio)
  const canUndo = useSceneStrength(s => s.undo.length > 0)
  const canRedo = useSceneStrength(s => s.redo.length > 0)
  const table = useSceneStore(s => s.table)
  const data = useSceneStore(s => s.data)
  const edited = useSceneStore(s => s.edited)
  const recorded = useSceneStore(s => s.recorded)
  const editsMatch = useSceneStore(s => s.editsMatch)
  const output = useScenePlayback(s => effectiveOutput(s))
  const kitGains = useSceneStore(s => kitGainsFor(s.projectKit?.clipGains, output))
  const lockTime = useSceneSettings(s => s.lockTime)
  const lockGain = useSceneSettings(s => s.lockGain)
  const game = useSceneStore(s => !!s.lib && !isVideoProject(s.lib))
  const [slider, setSlider] = useState<number | null>(null)
  // The slider's value not applied yet: read and cleared at once, so its pointerup and the blur after it apply it once.
  const sliderValue = useRef<number | null>(null)
  const [shiftKey, setShiftKey] = useState(0)

  const shownIdx = useMemo(() => data && edited ? shownIndexOf(data.full.events, edited.full.events) : new Map<number, number>(), [data, edited])
  const numbers = useMemo(() => data ? firingNumbers(data.full.events) : [], [data])
  const picked = useMemo((): Picked[] => {
    if (!data || !recorded) return []
    const events = data.full.events
    return [...selected].flatMap(i => {
      const k = shownIdx.get(i), ev = k === undefined ? undefined : events[k], rec = recorded.full.events[i]
      if (k === undefined || !ev || !rec) return []
      const strength = table ? firingStrength(table, events, ev, kitGains) : null
      return [{ index: i, name: ev.name, t: ev.t, gain: ev.gain ?? 1, num: numbers[k], strength, recorded: { gain: rec.gain ?? 1, t: rec.t }, edited: editsMatch.has(i) }]
    }).sort((a, b) => a.t - b.t)
  }, [selected, data, recorded, shownIdx, numbers, table, kitGains, editsMatch])

  if (!data) return <div className="scene-panel-empty">{t('scene.noProject')}</div>
  const nums0 = picked.flatMap(p => p.num === null ? [] : [p.num]), range0 = numberRangeText(nums0.length ? [Math.min(...nums0), Math.max(...nums0)] : null)
  const title0 = picked.length === 1 ? t('scene.card.one', { num: picked[0].num === null ? '' : firingNumber(picked[0].num), name: picked[0].name, t: picked[0].t.toFixed(2) }).trim()
    : range0 ? t('scene.card.several', { count: picked.length, range: range0 }) : t('scene.card.severalNoRange', { count: picked.length })
  if (game) return <div className={`scene-firing-panel ${picked.length ? '' : 'scene-firing-empty'}`} role="group" aria-label={t('scene.strength.selected')}>
    <IgnoredEdits />
    {picked.length && table ? <GameFiring picked={picked} title={title0} table={table} /> : !picked.length && <div>{t('scene.card.noneGame')}</div>}
  </div>
  if (!picked.length) return <div className="scene-firing-panel scene-firing-empty">{t('scene.card.none')}</div>
  const st = () => useSceneStrength.getState()
  const one = picked.length === 1 ? picked[0] : null
  const base = one ? one.gain : median(picked.map(p => p.gain))
  const live = dragRatio !== null ? base * dragRatio : base
  const fps = data.fps, end = data.full.levels.length / fps
  const title = title0
  const clipped = picked.filter(p => p.strength && p.strength.sent > 1).length
  const red = one?.strength ? one.strength.sent * (dragRatio ?? 1) > 1 : clipped > 0
  const other = one?.strength && Math.abs(one.strength.scale - 1) > 1e-9 ? t('scene.strength.other', { value: one.strength.scale.toFixed(2) }) : ''

  /** The slider let go (or its key released, or it lost the focus): its value applied once, as one undo step (scaled from the shown value). */
  const commitSlider = () => {
    const v = sliderValue.current
    if (v === null) return
    sliderValue.current = null
    setSlider(null); st().setDragRatio(null)
    if (base > 0) st().scaleSelected(v / base); else st().setSelected(v)
  }

  return <div className="scene-firing-panel" role="group" aria-label={t('scene.strength.selected')}>
    <div className="scene-firing-title" title={title}>{title}</div>
    <div className="scene-firing-grid">
      <div className="scene-firing-row" title={lockGain ? t('scene.card.gainLocked') : undefined}>
        <span className="scene-firing-label" title={t(one ? 'scene.card.gainHint' : 'scene.card.gainHintMany')}>{t('scene.card.gain')}</span>
        <NumberField value={Number(live.toFixed(3))} min={0} max={10} step={0.01} disabled={lockGain} label={t('scene.card.gain')} onCommit={v => st().setSelected(Math.max(0, v))} />
        <input type="range" min={0} max={SLIDER_MAX} step={0.01} value={Math.min(SLIDER_MAX, slider ?? live)} disabled={lockGain} aria-label={t('scene.card.slider')} title={t(one ? 'scene.card.sliderHint' : 'scene.card.sliderHintMany')}
          onChange={e => { const v = Number(e.target.value); sliderValue.current = v; setSlider(v); if (base > 0) st().setDragRatio(v / base) }}
          onPointerUp={e => { commitSlider(); e.currentTarget.blur() }} onKeyUp={commitSlider} onBlur={commitSlider} />
        <button type="button" className="scene-icon-btn" disabled={lockGain} title={t('scene.strength.downHint')} onClick={e => { e.currentTarget.blur(); st().scaleSelected(1 / strengthStep(e.shiftKey)) }}>▼</button>
        <button type="button" className="scene-icon-btn" disabled={lockGain} title={t('scene.strength.upHint')} onClick={e => { e.currentTarget.blur(); st().scaleSelected(strengthStep(e.shiftKey)) }}>▲</button>
      </div>
      <div className="scene-firing-row" title={lockTime ? t('scene.card.timeLocked') : undefined}>
        {one ? <>
          <span className="scene-firing-label" title={t('scene.card.timeHint')}>{t('scene.card.time')}</span>
          <NumberField value={Number(one.t.toFixed(3))} min={0} max={end} step={1 / fps} disabled={lockTime} label={t('scene.card.time')} onCommit={v => st().moveSelected(v - one.t)} />
        </> : <>
          <span className="scene-firing-label" title={t('scene.card.shiftHint')}>{t('scene.card.shift')}</span>
          <NumberField key={shiftKey} value={0} min={-end} max={end} step={1 / fps} disabled={lockTime} label={t('scene.card.shift')} onCommit={v => { if (v) st().moveSelected(v); setShiftKey(k => k + 1) }} />
        </>}
      </div>
      <div className="scene-firing-row scene-firing-actions">
        <SceneLockToggles />
        <button type="button" className="scene-icon-btn" disabled={!picked.some(p => p.edited)}
          title={one ? t('scene.card.resetHint', { gain: one.recorded.gain.toFixed(3), t: one.recorded.t.toFixed(3) }) : t('scene.card.resetHintMany')}
          onClick={e => { e.currentTarget.blur(); st().resetSelected() }}>{t('scene.card.reset')}</button>
        <button type="button" className="scene-icon-btn" disabled={!canUndo} title={t('scene.strength.undoHint')} onClick={e => { e.currentTarget.blur(); st().undoLast() }}>{t('scene.strength.undo')}</button>
        <button type="button" className="scene-icon-btn" disabled={!canRedo} title={t('scene.strength.redoHint')} onClick={e => { e.currentTarget.blur(); st().redoLast() }}>{t('scene.strength.redo')}</button>
      </div>
      <div className={`scene-firing-line ${red ? 'clipped' : ''}`}>
        {one?.strength ? t('scene.card.breakdown', {
          material: one.strength.material.toFixed(2), route: one.strength.route.toFixed(2), other, firing: live.toFixed(2), sent: (one.strength.sent * (dragRatio ?? 1)).toFixed(2),
        }) : clipped ? t('scene.strength.clipped', { count: clipped }) : ''}
      </div>
    </div>
  </div>
}

/** 「映像のプロジェクトの上書きが N 件あります」 while a game project has a viewer-edits.json with entries (DEC-114: not used, not removed). */
function IgnoredEdits() {
  const { t } = useI18n()
  const count = useSceneStore(s => s.ignoredEdits)
  return count ? <div className="scene-firing-note" title={t('scene.edits.ignoredHint')}>{t('scene.edits.ignored', { count })}</div> : null
}

/**
 * The 「発生」 panel of a game project (DEC-114): the selected firings' event / situation multipliers (sceneGameEdits;
 * one target: its value, several: their median — typing sets them all, each multiplier once), a 0–2 slider (live via
 * dragRatio / dragTargets, one undo step on release) and ▼▲, off while 「ゲインをロック」. The time row is one line (the
 * game decides it). 「状況を分ける…」 (one firing): the moments list's change request (a new `cue:variant` is made at
 * once with multipliers only, the agent gets a `reassign`, the firing shows as that situation until re-recorded). The
 * breakdown: material × event × the game's value (recorded, read only) → sent.
 */
function GameFiring({ picked, title, table }: { picked: { index: number; name: string; strength: FiringStrength | null }[]; title: string; table: CueTable }) {
  const { t } = useI18n()
  const dragRatio = useSceneStrength(s => s.dragRatio)
  const dragTargets = useSceneStrength(s => s.dragTargets)
  const canUndo = useSceneStrength(s => s.undo.length > 0)
  const canRedo = useSceneStrength(s => s.redo.length > 0)
  const recorded = useSceneStore(s => s.recorded)
  const lockGain = useSceneSettings(s => s.lockGain)
  const [slider, setSlider] = useState<number | null>(null)
  const sliderValue = useRef<number | null>(null)
  const [split, setSplit] = useState(false)
  const st = () => useSceneStrength.getState()
  const targets = targetsOf(table, picked.map(p => p.name), 'haptics')
  const values = targets.map(target => targetValue(targetValues(table, target) ?? []))
  const target: GainTarget | null = targets.length === 1 ? targets[0] : null
  const base = target ? values[0] : median(values)
  const ratio = target ? dragTargets?.get(targetKey(target)) ?? 1 : dragRatio ?? 1
  const live = base * ratio
  const one = picked.length === 1 ? picked[0] : null
  const rec = one && recorded?.full.events[one.index]
  const label = !target ? t('scene.card.eventGainMany') : target.kind === 'hapticsGain' ? t('scene.card.situationGain') : t('scene.card.eventGain')
  const hint = !target ? t('scene.card.eventGainHintMany')
    : target.kind === 'hapticsGain' ? t('scene.card.situationGainHint', { name: eventKey(target.ref), cue: target.ref.cue }) : t('scene.card.eventGainHint', { owner: eventKey(target.ref) })
  const strength = one?.strength ?? null
  const routeR = target?.kind === 'routes' ? ratio : 1, scaleR = target?.kind === 'hapticsGain' ? ratio : 1
  const other = strength && Math.abs(strength.scale * scaleR - 1) > 1e-9 ? t('scene.strength.other', { value: (strength.scale * scaleR).toFixed(2) }) : ''
  const clipped = picked.filter(p => p.strength && p.strength.sent > 1).length
  const red = strength ? strength.sent * ratio > 1 : clipped > 0
  const commitSlider = () => {
    const v = sliderValue.current
    if (v === null) return
    sliderValue.current = null
    setSlider(null); st().setDragRatio(null)
    if (base > 0) st().scaleSelected(v / base); else st().setSelected(v)
  }
  return <>
    <div className="scene-firing-title" title={title}>{title}</div>
    <div className="scene-firing-grid">
      <div className="scene-firing-row" title={lockGain ? t('scene.card.gainLocked') : undefined}>
        <span className="scene-firing-label" title={hint}>{label}</span>
        <NumberField value={Number(live.toFixed(3))} min={0} max={2} step={0.01} disabled={lockGain || !targets.length} label={label} onCommit={v => st().setSelected(Math.max(0, v))} />
        <input type="range" min={0} max={2} step={0.01} value={Math.min(2, slider ?? live)} disabled={lockGain || !targets.length} aria-label={t('scene.card.slider')} title={t('scene.card.sliderGameHint')}
          onChange={e => { const v = Number(e.target.value); sliderValue.current = v; setSlider(v); if (base > 0) st().setDragRatio(v / base) }}
          onPointerUp={e => { commitSlider(); e.currentTarget.blur() }} onKeyUp={commitSlider} onBlur={commitSlider} />
        <button type="button" className="scene-icon-btn" disabled={lockGain || !targets.length} title={t('scene.strength.downHint')} onClick={e => { e.currentTarget.blur(); st().scaleSelected(1 / strengthStep(e.shiftKey)) }}>▼</button>
        <button type="button" className="scene-icon-btn" disabled={lockGain || !targets.length} title={t('scene.strength.upHint')} onClick={e => { e.currentTarget.blur(); st().scaleSelected(strengthStep(e.shiftKey)) }}>▲</button>
      </div>
      <div className="scene-firing-row scene-firing-dim">{t('scene.card.timeGame')}</div>
      <div className="scene-firing-row scene-firing-actions scene-firing-split">
        <SceneLockToggles />
        <button type="button" className="scene-icon-btn" disabled={!rec} aria-expanded={split} title={t('scene.card.splitHint')}
          onClick={e => { e.currentTarget.blur(); setSplit(v => !v) }}>{t('scene.card.split')}</button>
        <button type="button" className="scene-icon-btn" disabled={!canUndo} title={t('scene.strength.undoHint')} onClick={e => { e.currentTarget.blur(); st().undoLast() }}>{t('scene.strength.undo')}</button>
        <button type="button" className="scene-icon-btn" disabled={!canRedo} title={t('scene.strength.redoHint')} onClick={e => { e.currentTarget.blur(); st().redoLast() }}>{t('scene.strength.redo')}</button>
        {split && rec && <ChangeEventForm from={rec.name} at={rec.t} table={table} onClose={() => setSplit(false)}
          onSent={to => { setSplit(false); changedFiring(rec.name, rec.t, to) }} onError={changeFailed} />}
      </div>
      <div className={`scene-firing-line ${red ? 'clipped' : ''}`}>
        {strength ? t('scene.card.breakdownGame', {
          material: strength.material.toFixed(2), route: (strength.route * routeR).toFixed(2), other, firing: strength.firing.toFixed(2), sent: (strength.sent * ratio).toFixed(2),
        }) : clipped ? t('scene.strength.clipped', { count: clipped }) : ''}
      </div>
    </div>
  </>
}
