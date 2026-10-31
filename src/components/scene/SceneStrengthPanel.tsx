import { useEffect, useMemo, useRef, useState } from 'react'
import { useI18n } from '@/i18n/I18nProvider'
import { useConfirm } from '@/components/common/useConfirm'
import { useSceneStore } from '@/stores/sceneStore'
import { useSceneSettings } from '@/stores/sceneSettings'
import { clampOverallGain, OVERALL_GAIN_MAX, useScenePlayback } from '@/stores/scenePlayback'
import { routesOf, useSceneStrength } from '@/stores/sceneStrength'
import { firingKey, recordingFiringStrength, type FiringStrength } from '@/utils/sceneFiringGain'
import { faderValue, gainsAtFader, median, ratioDb, recordedIndexMap, recordedName, RELATIVE_RANGE, ROUTE_GAIN_MAX, setRouteGains, strengthStep } from '@/utils/sceneStrength'
import { parseEventKey } from '@/utils/cueEvents'
import { isTypingTarget } from '@/utils/playbackShortcut'

/** One firing of the scope as the panel uses it: its name, own gain and strength. */
interface Firing { name: string; strength: FiringStrength }

/** `a〜b` (or one value when they agree) with `digits` decimals. */
function span(values: readonly number[], digits = 2): string {
  if (!values.length) return '—'
  const lo = Math.min(...values).toFixed(digits), hi = Math.max(...values).toFixed(digits)
  return lo === hi ? lo : `${lo}〜${hi}`
}
const signedDb = (ratio: number) => { const db = ratioDb(ratio); return `${db >= 0 ? '+' : '−'}${Math.abs(db).toFixed(1)}` }

/**
 * 「強さ」 panel (DEC-102 r3): a mixer of the software multipliers. The overall fader is this PC's (scenePlayback, applied
 * when sending, not in the bars); one vertical fader per haptic event with firings in the recording (or the chapter
 * playing) edits its route gain in the cue table (live, one undo step per drag), with M / S for this session; 「選んだ
 * 発生」 scales the selected firings' own gains (viewer-data, with per-firing editing on); 「内訳」 splits the selection's
 * (or the hovered firing's) strength into material / software / sent. The clip intensity (material) is never edited here.
 */
export function SceneStrengthPanel() {
  const { t } = useI18n()
  const table = useSceneStore(s => s.table)
  const data = useSceneStore(s => s.data)
  const recorded = useSceneStore(s => s.recorded)
  const chapter = useSceneStore(s => s.chapter)
  const overall = useScenePlayback(s => s.overallGain)
  const editFirings = useSceneSettings(s => s.editFirings)
  const selected = useSceneStrength(s => s.selected)
  const hover = useSceneStrength(s => s.hover)
  const dragRatio = useSceneStrength(s => s.dragRatio)
  const canUndo = useSceneStrength(s => s.undo.length > 0)
  const canRedo = useSceneStrength(s => s.redo.length > 0)
  const { ask, dialog } = useConfirm()

  // Each firing the runtime plays, by its recorded index (emitted firings have none) — and the strength of every one.
  const strengths = useMemo(() => table && data ? recordingFiringStrength(table, data.full.events) : new Map<string, FiringStrength | null>(), [table, data])
  const byIndex = useMemo(() => {
    const out = new Map<number, Firing & { t: number }>()
    if (!data || !recorded) return out
    const indexOf = recordedIndexMap(recorded.full.events)
    for (const ev of data.full.events) {
      const strength = strengths.get(firingKey(ev.name, ev.t)), i = indexOf.get(firingKey(recordedName(ev), ev.t))
      if (strength && i !== undefined) out.set(i, { name: ev.name, strength, t: ev.t })
    }
    return out
  }, [data, recorded, strengths])
  // The haptic events of the scope (the chapter playing, else the recording) with their firings.
  const range = chapter !== null ? data?.chapters[chapter] : undefined
  const events = useMemo(() => {
    const out = new Map<string, { gains: number[]; indices: number[] }>()
    for (const [i, f] of byIndex) {
      if (range && (f.t < range.start || f.t > range.end)) continue
      const e = out.get(f.name) ?? { gains: [], indices: [] }
      e.gains.push(f.strength.firing); e.indices.push(i); out.set(f.name, e)
    }
    return [...out].sort(([a], [b]) => a.localeCompare(b))
  }, [byIndex, range])

  if (!table || !data) return <div className="scene-panel-empty">{t('scene.noProject')}</div>

  const picked = [...selected].flatMap(i => { const f = byIndex.get(i); return f ? [f] : [] })
  const shown = picked.length ? picked : hover !== null && byIndex.has(hover) ? [byIndex.get(hover)!] : []
  const st = () => useSceneStrength.getState()
  const scale = (ratio: number) => { if (editFirings && picked.length) st().scaleSelected(ratio) }
  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || isTypingTarget(e.target) || (e.target as HTMLElement).tagName === 'INPUT') return
    const step = strengthStep(e.shiftKey)
    scale(e.key === 'ArrowUp' ? step : 1 / step)
    // The moments list's ↑ / ↓ (SceneView) stay for the rest of the tab.
    e.preventDefault(); e.stopPropagation()
  }
  const toggleEditing = async (on: boolean) => {
    if (on && !await ask({ message: t('scene.strength.editFiringsConfirm'), danger: true })) return
    useSceneSettings.getState().update({ editFirings: on })
  }
  const disabledReason = !editFirings ? t('scene.strength.editOff') : !picked.length ? t('scene.strength.noneSelected') : ''

  return <div className="scene-strength" tabIndex={-1} onKeyDown={onKeyDown}>
    <div className="scene-strength-mixer">
      <Fader className="scene-strength-overall" label={t('scene.strength.overall')} title={t('scene.strength.overallHint')} value={overall} max={OVERALL_GAIN_MAX}
        onInput={x => useScenePlayback.getState().update({ overallGain: clampOverallGain(x) })}>
        <span className="scene-dim">{t('scene.strength.notInBars')}</span>
      </Fader>
      {events.length ? events.map(([name, e]) => <EventFader key={name} name={name} gains={e.gains} indices={e.indices} chapter={!!range} />)
        : <div className="scene-panel-empty">{t('scene.strength.noEvents')}</div>}
    </div>
    <div className="scene-strength-side">
      <div className="scene-sec">
        <h3>{t('scene.strength.selected')}</h3>
        <label className="scene-check" title={t('scene.strength.editFiringsHint')}>
          <input type="checkbox" checked={editFirings} onChange={ev => void toggleEditing(ev.target.checked)} />{t('scene.strength.editFirings')}</label>
        <div className="scene-strength-count">{picked.length
          ? t('scene.strength.selectedCount', { count: picked.length, names: names(picked), range: span(picked.map(f => f.strength.firing)) }) : ''}</div>
        <div className="scene-strength-sel">
          <RelativeFader disabled={!!disabledReason} />
          <div className="scene-strength-buttons">
            <button type="button" className="scene-icon-btn" disabled={!!disabledReason} title={t('scene.strength.upHint')} onClick={e => scale(strengthStep(e.shiftKey))}>▲</button>
            <button type="button" className="scene-icon-btn" disabled={!!disabledReason} title={t('scene.strength.downHint')} onClick={e => scale(1 / strengthStep(e.shiftKey))}>▼</button>
            <SetAll key={`${[...selected].join(',')}:${median(picked.map(f => f.strength.firing))}`} disabled={!!disabledReason} start={median(picked.map(f => f.strength.firing))} />
            <div className="scene-row">
              <button type="button" className="scene-icon-btn" disabled={!canUndo} title={t('scene.strength.undoHint')} onClick={() => st().undoLast()}>{t('scene.strength.undo')}</button>
              <button type="button" className="scene-icon-btn" disabled={!canRedo} title={t('scene.strength.redoHint')} onClick={() => st().redoLast()}>{t('scene.strength.redo')}</button>
            </div>
          </div>
        </div>
        <div className="scene-strength-reason scene-dim">{disabledReason}</div>
      </div>
      <Breakdown firings={shown} ratio={picked.length ? dragRatio : null} overall={overall} />
    </div>
    {dialog}
  </div>
}

/** The selection's event names (up to three, then …). */
function names(firings: readonly Firing[]): string {
  const all = [...new Set(firings.map(f => f.name))]
  return all.length > 3 ? `${all.slice(0, 3).join(', ')}, …` : all.join(', ')
}

/** A range input's `change` (released, or one key step) — React's onChange is the native `input` (every move). */
function useRelease(onRelease: (() => void) | undefined) {
  const input = useRef<HTMLInputElement>(null)
  const release = useRef(onRelease); release.current = onRelease
  useEffect(() => {
    const el = input.current
    if (!el) return
    const change = () => release.current?.()
    el.addEventListener('change', change)
    return () => el.removeEventListener('change', change)
  }, [])
  return input
}

/** A vertical fader 0..`max` with a tick at ×1 and its value (fixed width) underneath; `onInput` while it moves, `onRelease` once let go. */
function Fader({ className, label, title, value, max, onInput, onRelease, children }: {
  className?: string; label: React.ReactNode; title: string; value: number; max: number; onInput: (value: number) => void; onRelease?: () => void; children?: React.ReactNode
}) {
  const input = useRelease(onRelease)
  return <div className={`scene-strength-strip ${className ?? ''}`} title={title}>
    <div className="scene-strength-track">
      <input ref={input} type="range" className="scene-strength-fader" min={0} max={max} step={0.01} value={value} aria-label={title}
        onChange={e => onInput(parseFloat(e.target.value))} />
      <span className="scene-strength-unity" style={{ bottom: `${(1 / max) * 100}%` }} aria-hidden="true" />
    </div>
    <span className="scene-strength-value">×{value.toFixed(2)}</span>
    <span className="scene-strength-label">{label}</span>
    {children}
  </div>
}

/**
 * One haptic event's route gain (its largest route; moving it scales all of them by one ratio). Live edits to the cue
 * table while it moves (the bars follow), one undo step when released. Under it: the name (selects its firings in the
 * scope), its firings' own gains and M / S (this session only).
 */
function EventFader({ name, gains, indices, chapter }: { name: string; gains: number[]; indices: number[]; chapter: boolean }) {
  const { t } = useI18n()
  useSceneStore(s => s.table)
  const muted = useSceneStrength(s => s.muted.has(name))
  const soloed = useSceneStrength(s => s.soloed.has(name))
  const routes = routesOf(name)
  /** The route gains when the drag started (every step scales those, so a drag does not drift). */
  const start = useRef<{ owner: string; gains: number[] } | null>(null)
  if (!routes) return null
  const shared = routes.owner !== name
  const onInput = (value: number) => {
    const now = routesOf(name)
    if (!now) return
    start.current ??= now
    const owner = parseEventKey(start.current.owner), next = gainsAtFader(start.current.gains, value)
    useSceneStore.getState().edit(tb => setRouteGains(tb, owner, next))
  }
  const onRelease = () => {
    const s = start.current, now = routesOf(name)
    start.current = null
    if (s && now && now.owner === s.owner) useSceneStrength.getState().pushRoutes(s.owner, s.gains, now.gains)
  }
  const title = `${t('scene.strength.eventHint', { name })}${shared ? `\n${t('scene.strength.eventShared', { owner: routes.owner })}` : ''}`
  return <Fader label={<button type="button" className="scene-strength-name" title={t('scene.strength.selectEvent', { name, scope: t(chapter ? 'scene.strength.scope.chapter' : 'scene.strength.scope.all') })}
    onClick={() => useSceneStrength.getState().select(indices, 'replace')}>{name}</button>}
    title={title} value={faderValue(routes.gains)} max={ROUTE_GAIN_MAX} onInput={onInput} onRelease={onRelease}>
    <span className="scene-strength-range scene-dim">{t('scene.strength.firingRange', { range: span(gains) })}</span>
    <span className="scene-strength-ms">
      <button type="button" className={`scene-strength-m ${muted ? 'on' : ''}`} aria-pressed={muted} title={t('scene.strength.muteHint')} onClick={() => useSceneStrength.getState().toggleMute(name)}>M</button>
      <button type="button" className={`scene-strength-s ${soloed ? 'on' : ''}`} aria-pressed={soloed} title={t('scene.strength.soloHint')} onClick={() => useSceneStrength.getState().toggleSolo(name)}>S</button>
    </span>
  </Fader>
}

/** The selection's relative fader: centred at ×1 (×0.25..×4); the bars follow while it moves, released = applied, back to ×1. */
function RelativeFader({ disabled }: { disabled: boolean }) {
  const { t } = useI18n()
  const [rel, setRel] = useState(0)
  const ratio = 2 ** rel
  const commit = () => {
    const st = useSceneStrength.getState(), r = st.dragRatio
    st.setDragRatio(null)
    if (r !== null && r !== 1) st.scaleSelected(r)
    setRel(0)
  }
  const input = useRelease(commit)
  return <div className="scene-strength-strip scene-strength-relative" title={t('scene.strength.relativeHint')}>
    <div className="scene-strength-track">
      <input ref={input} type="range" className="scene-strength-fader" min={-RELATIVE_RANGE} max={RELATIVE_RANGE} step={0.01} value={rel} disabled={disabled} aria-label={t('scene.strength.relativeHint')}
        onChange={e => { const x = parseFloat(e.target.value); setRel(x); useSceneStrength.getState().setDragRatio(2 ** x) }} />
      <span className="scene-strength-unity" style={{ bottom: '50%' }} aria-hidden="true" />
    </div>
    <span className="scene-strength-value scene-strength-ratio">{t('scene.strength.ratio', { ratio: ratio.toFixed(2), db: signedDb(ratio) })}</span>
    <span className="scene-strength-label">{t('scene.strength.relative')}</span>
  </div>
}

/** A number and 「同じ値に」: every selected firing set to it (starts at the selection's median). */
function SetAll({ disabled, start }: { disabled: boolean; start: number }) {
  const { t } = useI18n()
  const [text, setText] = useState(start.toFixed(3))
  const apply = () => { const x = parseFloat(text); if (Number.isFinite(x) && x >= 0) useSceneStrength.getState().setSelected(x) }
  return <div className="scene-row">
    <input type="number" className="scene-number" min={0} step={0.01} value={text} disabled={disabled} aria-label={t('scene.strength.value')}
      onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') apply() }} />
    <button type="button" className="scene-icon-btn" disabled={disabled} title={t('scene.strength.setAllHint')} onClick={apply}>{t('scene.strength.setAll')}</button>
  </div>
}

/**
 * 「内訳」: material (editor / Kit) | software (event route gain × the firing's own gain, × variant / distance when they
 * are not 1) | sent, for the selection (ranges) or the hovered firing; how many would be clipped; this PC's overall
 * shown apart (not included). `ratio`: a drag on the selection, shown live.
 */
function Breakdown({ firings, ratio, overall }: { firings: readonly Firing[]; ratio: number | null; overall: number }) {
  const { t } = useI18n()
  const r = ratio ?? 1
  const s = firings.map(f => ({ ...f.strength, firing: f.strength.firing * r, software: f.strength.software * r, sent: f.strength.sent * r }))
  const others = s.map(x => x.scale), clipped = s.filter(x => x.sent > 1).length
  return <div className="scene-sec scene-strength-detail">
    <h3>{t('scene.strength.breakdown')}</h3>
    <div className="scene-strength-detail-line">{s.length ? <>
      {t('scene.strength.detail', {
        material: span(s.map(x => x.material)), software: span(s.map(x => x.software)), route: span(s.map(x => x.route)), firing: span(s.map(x => x.firing)),
        other: others.some(x => Math.abs(x - 1) > 1e-6) ? t('scene.strength.other', { value: span(others) }) : '', sent: span(s.map(x => x.sent)),
      })}
      {clipped > 0 && <span className="scene-strength-clipped">{t('scene.strength.clipped', { count: clipped })}</span>}
    </> : <span className="scene-dim">{t('scene.strength.noDetail')}</span>}</div>
    <div className="scene-dim">{t('scene.strength.overallNote', { value: overall.toFixed(2) })}</div>
  </div>
}
