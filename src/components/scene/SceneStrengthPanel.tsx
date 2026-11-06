import { useEffect, useMemo, useRef, useState } from 'react'
import { useI18n } from '@/i18n/I18nProvider'
import { useConfirm } from '@/components/common/useConfirm'
import { MenuPopup } from '@/components/waveform/EditorMenu'
import { useSceneStore } from '@/stores/sceneStore'
import { clampOverallGain, effectiveOutput, OVERALL_GAIN_MAX, useScenePlayback } from '@/stores/scenePlayback'
import { kitGainsFor } from '@/utils/sceneCueTable'
import { restoreVersion, routesOf, useSceneStrength } from '@/stores/sceneStrength'
import { occurrenceKeys, recordingFiringStrength } from '@/utils/sceneFiringGain'
import { faderValue, gainsAtFader, recordedIndexMap, recordedName, ROUTE_GAIN_MAX, setRouteGains } from '@/utils/sceneStrength'
import type { SceneVersion } from '@/utils/sceneVersions'
import { isAppProject } from '@/utils/appProject'
import { parseEventKey } from '@/utils/cueEvents'

/**
 * 「強さ」 panel = the master mixer (DEC-112): the overall fader (this PC's, scenePlayback, applied when sending, not in
 * the bars) and one vertical fader per haptic event with firings in the recording (or the chapter playing), editing its
 * route gain in the cue table (live, one undo step per drag), with M / S for this session. The faders wrap into rows so
 * all of them show at once. Single firings are edited on the timeline (SceneFiringCard). The header has the versions
 * menu (「版」) and the entries of viewer-edits.json that match no recorded firing.
 */
export function SceneStrengthPanel() {
  const { t } = useI18n()
  const table = useSceneStore(s => s.table)
  // The Kit's clip gains of the output playing now (FIRE: `events`, CLIP: `stream_events`; contracts cue-table §9.1).
  const output = useScenePlayback(s => effectiveOutput(s))
  const kitGains = useSceneStore(s => kitGainsFor(s.projectKit?.clipGains, output))
  const data = useSceneStore(s => s.data)
  const edited = useSceneStore(s => s.edited)
  const chapter = useSceneStore(s => s.chapter)
  const overall = useScenePlayback(s => s.overallGain)
  const canUndo = useSceneStrength(s => s.undo.length > 0)
  const canRedo = useSceneStrength(s => s.redo.length > 0)

  // The haptic firings the runtime plays, by recorded index (emitted firings have none): their event name and time.
  const byIndex = useMemo(() => {
    const out = new Map<number, { name: string; t: number }>()
    if (!table || !data || !edited) return out
    const strengths = recordingFiringStrength(table, data.full.events, kitGains)
    // The recorded firings at their edited times (the order of `recorded`): the shown firings' keys find their index.
    const indexOf = recordedIndexMap(edited.full.events), events = data.full.events
    const shownKeys = occurrenceKeys(events), recordedKeys = occurrenceKeys(events, recordedName)
    events.forEach((ev, k) => {
      const i = indexOf.get(recordedKeys[k])
      if (strengths.get(shownKeys[k]) && i !== undefined) out.set(i, { name: ev.name, t: ev.t })
    })
    return out
  }, [table, data, edited, kitGains])
  // The haptic events of the scope (the chapter playing, else the recording) with their firings' recorded indices.
  const range = chapter !== null ? data?.chapters[chapter] : undefined
  const events = useMemo(() => {
    const out = new Map<string, number[]>()
    for (const [i, f] of byIndex) {
      if (range && (f.t < range.start || f.t > range.end)) continue
      out.set(f.name, [...out.get(f.name) ?? [], i])
    }
    return [...out].sort(([a], [b]) => a.localeCompare(b))
  }, [byIndex, range])

  if (!table || !data) return <div className="scene-panel-empty">{t('scene.noProject')}</div>

  const st = () => useSceneStrength.getState()
  return <div className="scene-strength">
    <div className="scene-strength-head">
      <h3 title={t('scene.strength.mixerHint')}>{t('scene.strength.mixer')}</h3>
      <OrphanEdits />
      <span className="scene-strength-head-end">
        <button type="button" className="scene-icon-btn" disabled={!canUndo} title={t('scene.strength.undoHint')} onClick={() => st().undoLast()}>{t('scene.strength.undo')}</button>
        <button type="button" className="scene-icon-btn" disabled={!canRedo} title={t('scene.strength.redoHint')} onClick={() => st().redoLast()}>{t('scene.strength.redo')}</button>
        <VersionsMenu />
      </span>
    </div>
    <div className="scene-strength-mixer">
      <Fader className="scene-strength-overall" label={t('scene.strength.overall')} title={t('scene.strength.overallHint')} value={overall} max={OVERALL_GAIN_MAX}
        onInput={x => useScenePlayback.getState().update({ overallGain: clampOverallGain(x) })} />
      {events.length ? events.map(([name, indices]) => <EventFader key={name} name={name} indices={indices} chapter={!!range} />)
        : <div className="scene-panel-empty">{t('scene.strength.noEvents')}</div>}
    </div>
  </div>
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

/**
 * A vertical fader 0..`max` with a tick at ×1; under it its value (fixed width) with `extra` (M / S) on one line, then
 * the label. The track takes the height the mixer's row leaves. `onInput` while it moves, `onRelease` once let go.
 */
function Fader({ className, label, title, value, max, onInput, onRelease, extra }: {
  className?: string; label: React.ReactNode; title: string; value: number; max: number; onInput: (value: number) => void; onRelease?: () => void; extra?: React.ReactNode
}) {
  const input = useRelease(onRelease)
  return <div className={`scene-strength-strip ${className ?? ''}`} title={title}>
    <div className="scene-strength-track">
      <input ref={input} type="range" className="scene-strength-fader" min={0} max={max} step={0.01} value={value} aria-label={title}
        onChange={e => onInput(parseFloat(e.target.value))} />
      <span className="scene-strength-unity" style={{ bottom: `${(1 / max) * 100}%` }} aria-hidden="true" />
    </div>
    <span className="scene-strength-line"><span className="scene-strength-value">×{value.toFixed(2)}</span>{extra}</span>
    <span className="scene-strength-label">{label}</span>
  </div>
}

/**
 * One haptic event's route gain (its largest route; moving it scales all of them by one ratio). Live edits to the cue
 * table while it moves (the bars follow), one undo step when released. Under it: its multiplier, M / S (this session
 * only) and the name (selects its firings in the scope).
 */
function EventFader({ name, indices, chapter }: { name: string; indices: number[]; chapter: boolean }) {
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
    // The first strength edit of the project saves a before-edit version (sceneStore.versionBeforeEdit).
    if (!start.current) useSceneStore.getState().versionBeforeEdit()
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
    title={title} value={faderValue(routes.gains)} max={ROUTE_GAIN_MAX} onInput={onInput} onRelease={onRelease}
    extra={<span className="scene-strength-ms">
      <button type="button" className={`scene-strength-m ${muted ? 'on' : ''}`} aria-pressed={muted} title={t('scene.strength.muteHint')} onClick={() => useSceneStrength.getState().toggleMute(name)}>M</button>
      <button type="button" className={`scene-strength-s ${soloed ? 'on' : ''}`} aria-pressed={soloed} title={t('scene.strength.soloHint')} onClick={() => useSceneStrength.getState().toggleSolo(name)}>S</button>
    </span>} />
}

/** 「合わない上書き N 件」 with 「消す」 while viewer-edits.json has entries that match no recorded firing. */
function OrphanEdits() {
  const { t } = useI18n()
  const count = useSceneStore(s => s.editsOrphans)
  const { ask, dialog } = useConfirm()
  if (!count) return null
  const remove = async () => {
    if (!await ask({ message: t('scene.edits.orphansConfirm', { count }), danger: true, confirmLabel: t('scene.edits.orphansRemove') })) return
    useSceneStore.getState().removeOrphanEdits()
  }
  return <span className="scene-strength-orphans" title={t('scene.edits.orphansHint')}>
    {t('scene.edits.orphans', { count })}
    <button type="button" className="scene-icon-btn" onClick={() => void remove()}>{t('scene.edits.orphansRemove')}</button>
    {dialog}
  </span>
}

/** A version's time as `YYYY-MM-DD HH:MM` (savedAt is a local ISO time). */
const versionTime = (v: SceneVersion) => v.savedAt.slice(0, 16).replace('T', ' ')
const REASON_KEY = { 'before-edit': 'scene.versions.reason.beforeEdit', manual: 'scene.versions.reason.manual', 'before-restore': 'scene.versions.reason.beforeRestore' } as const

/**
 * 「版」: saves the current edits and cue table as a version (name, Enter), lists the versions (newest first) with
 * 「戻す」 (the current state is saved first; sceneStrength.restoreVersion, the strength values one undo step) and
 * 「消す」 (moved to `_archive/versions/`, never deleted). The menu closes before a confirm opens (its Escape would
 * otherwise be taken by the menu).
 */
function VersionsMenu() {
  const { t } = useI18n()
  const root = useSceneStore(s => s.root)
  const { ask, dialog } = useConfirm()
  const button = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [versions, setVersions] = useState<SceneVersion[] | null>(null)
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const store = () => useSceneStore.getState()
  const failed = (id: 'scene.versions.listFailed' | 'scene.versions.deleteFailed', error: unknown) =>
    store().note({ id, params: { error: error instanceof Error ? error.message : String(error) }, error: true })
  const refresh = () => store().listVersions().then(setVersions, error => { setVersions([]); failed('scene.versions.listFailed', error) })
  const toggle = () => {
    if (open) { setOpen(false); return }
    setVersions(null); setOpen(true); void refresh()
  }
  const save = async () => {
    if (busy) return
    setBusy(true)
    const id = await store().saveVersion(label.trim())
    setBusy(false)
    if (!id) return
    setLabel('')
    store().note({ id: 'scene.versions.saved', params: { id } })
    void refresh()
  }
  const restore = async (v: SceneVersion) => {
    setOpen(false)
    if (!await ask({ message: t('scene.versions.restoreConfirm', { time: versionTime(v), label: v.label || t(REASON_KEY[v.reason]) }), confirmLabel: t('scene.versions.restore') })) return
    const result = await restoreVersion(v.id)
    if (!result.ok) { store().note(result.notice); return }
    store().note(result.skipped.length
      ? { id: 'scene.versions.restoredSkipped', params: { time: versionTime(v), skipped: result.skipped.join(', ') }, error: true }
      : { id: 'scene.versions.restored', params: { time: versionTime(v) } })
  }
  const remove = async (v: SceneVersion) => {
    setOpen(false)
    if (!await ask({ message: t('scene.versions.deleteConfirm', { time: versionTime(v), label: v.label || t(REASON_KEY[v.reason]) }), danger: true, confirmLabel: t('scene.versions.delete') })) return
    try { await store().deleteVersion(v.id); store().note({ id: 'scene.versions.deleted', params: { time: versionTime(v) } }) }
    catch (error) { failed('scene.versions.deleteFailed', error) }
  }
  const readOnly = !root || isAppProject(root)
  return <>
    <button ref={button} type="button" className="scene-icon-btn" aria-haspopup="menu" aria-expanded={open} disabled={readOnly} title={t('scene.versions.buttonHint')} onClick={toggle}>{t('scene.versions.button')} ▾</button>
    {open && <MenuPopup anchor={button} returnFocus={button} onClose={() => setOpen(false)} className="scene-versions-menu">
      <div className="scene-versions-save">
        <input type="text" className="scene-versions-name" value={label} autoFocus placeholder={t('scene.versions.namePlaceholder')} aria-label={t('scene.versions.saveCurrent')}
          onChange={e => setLabel(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void save() }} />
        <button type="button" className="scene-icon-btn" disabled={busy} onClick={() => void save()}>{t('scene.versions.save')}</button>
      </div>
      <div className="scene-versions-list">
        {versions === null ? <span className="scene-dim">{t('scene.versions.loading')}</span>
          : !versions.length ? <span className="scene-dim">{t('scene.versions.empty')}</span>
          : versions.map(v => <div key={v.id} className="scene-versions-row" title={v.id}>
            <span className="scene-versions-time">{versionTime(v)}</span>
            <span className="scene-versions-label">{v.label || t(REASON_KEY[v.reason])}</span>
            <span className="scene-dim">{t('scene.versions.meta', { reason: t(REASON_KEY[v.reason]), count: v.firings })}</span>
            <button type="button" className="scene-icon-btn" onClick={() => void restore(v)}>{t('scene.versions.restore')}</button>
            <button type="button" className="scene-icon-btn" onClick={() => void remove(v)}>{t('scene.versions.delete')}</button>
          </div>)}
      </div>
    </MenuPopup>}
    {dialog}
  </>
}
