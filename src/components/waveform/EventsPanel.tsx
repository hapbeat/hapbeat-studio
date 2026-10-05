import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useI18n } from '@/i18n/I18nProvider'
import { useSceneStore } from '@/stores/sceneStore'
import { useEventStore, type DecideTarget } from '@/stores/eventStore'
import { useAgentTrialStore } from '@/stores/agentTrialStore'
import { useWaveformStore } from '@/stores/waveformStore'
import { useEditorSettings } from '@/stores/editorSettings'
import { sceneProjectNames } from '@/utils/sceneRegistry'
import { useSceneVideoTarget } from '@/utils/editorSceneSync'
import { clipsForCue, isLoopCue, soundAllowed, positionsForCue, routeClips, sfxSounds, type CueTable } from '@/utils/sceneCueTable'
import type { SceneLib } from '@/utils/sceneData'
import {
  addPositionRoute, assignEventsForTrial, effectiveEvent, eventKey, listEvents, parseEventKey, removeOwnRoute,
  setOwnSfxVolume, setRouteClips, setSfxSounds, simultaneousGroups, trialsForEvent, updateOwnRoute,
  resetAllReviews, setNone, setReview, setUndecided,
  type EffectiveEvent, type EventRow, type SoundStatus,
} from '@/utils/cueEvents'
import { useConfirm } from '@/components/common/useConfirm'
import { NumberField, useAtLabel } from '@/components/scene/SceneCuePanels'
import { useEditor } from './editorContext'
import { DecidedNotice } from './DecideDialog'
import { EditorMenu, EditorMenuItem } from './EditorMenu'
import { openEventDefault, openEventHaptic, openEventSound } from './eventAudio'
import { MaterialList } from './MaterialList'
import { runDecision } from './eventDecide'
import { removeReserve, requestAnswered, reviseAnswered } from '@/utils/agentTrialUi'
import { create } from 'zustand'
import { openEventMaterialForEditing } from './eventEditing'
import './EventsPanel.css'
import '@/components/scene/VideoOverlay.css'

const LAST_PROJECT_KEY = 'hapbeat-events-project'
const NEW_FOLDER = ' new'
const LIST_MIN = 80, LIST_MAX = 1200
const readLast = () => { try { return localStorage.getItem(LAST_PROJECT_KEY) } catch { return null } }
const writeLast = (name: string) => { try { localStorage.setItem(LAST_PROJECT_KEY, name) } catch { /* preference only */ } }

/**
 * "Events": the cues of the game project open in the Scene tab (same store, picked
 * through the project registry), whether each has its sound / haptic decided, and
 * per cue: its sound and haptic material candidates (▶ / ★ representative / ×5 /
 * remove), the AI trials made for it, and "add" of the selected editor clip.
 * Variants, variation and per-situation choices live in the Scene tab (DEC-085). Cues the recording plays at the same moment are grouped
 * (display only). Edits mark the table unsaved (Save / Revert at the top, same
 * as the Scene tab); "decide" writes at once.
 */
export function EventsPanel() {
  const { t } = useI18n()
  const table = useSceneStore(s => s.table)
  const lib = useSceneStore(s => s.lib)
  const data = useSceneStore(s => s.data)
  const saveError = useSceneStore(s => s.saveError)
  const busy = useSceneStore(s => s.busy)
  const result = useEventStore(s => s.result)
  const selected = useEventStore(s => s.selected)
  const { ask, dialog } = useConfirm()
  const rows = useMemo(() => table && lib ? listEvents(table, lib) : [], [table, lib])
  const groups = useMemo(() => table && lib && data ? simultaneousGroups(table, data.clips, lib.ticks) : [], [table, lib, data])
  const select = (key: string) => {
    useEventStore.getState().select(key)
    // The Scene video panel (window or docked, never opened here) shows this event's moment.
    useSceneVideoTarget.getState().setTarget({ kind: 'event', key })
    // The waveform panel follows: the event's haptic, else its sound.
    openEventDefault(key)
  }
  // Cues only: a variant opened from elsewhere (Scene tab, an AI trial) shows its cue.
  const cue = selected ? parseEventKey(selected).cue : null
  const effective = table && cue ? effectiveEvent(table, { cue, variant: null }) : null
  const requested = useOpenRequests()
  const block = (r: EventRow) => <EventRowButton key={r.key} row={r} selected={cue === r.key} onSelect={select}
    requested={{ sound: requested.has(`${r.key}|sound`), haptic: requested.has(`${r.key}|haptic`) }} />
  const listItems: ReactNode[] = [], done = new Set<string>()
  for (const r of rows) {
    if (done.has(r.key)) continue
    const group = groups.find(g => g.includes(r.key))
    if (!group) { listItems.push(block(r)); continue }
    group.forEach(k => done.add(k))
    listItems.push(<div key={`group:${group.join('+')}`} className="events-group" title={t('events.simultaneousHint')}>
      <div className="events-group-head">{group.join(' ＋ ')}<span className="events-tag simultaneous">{t('events.simultaneous')}</span></div>
      {group.map(k => rows.find(x => x.key === k)).filter((x): x is EventRow => !!x).map(block)}
    </div>)
  }
  return <div className="editor-panel events-panel">
    <div className="events-top">
      <ProjectPicker />
      <EditorMenu label="⋯" title={t('events.menu')}>
        <EditorMenuItem disabled={!table} onSelect={() => void ask({ message: t('events.resetReviewsConfirm'), danger: true }).then(ok => { if (ok) useSceneStore.getState().edit(tb => resetAllReviews(tb)) })}>{t('events.resetReviews')}</EditorMenuItem>
      </EditorMenu>
    </div>
    {dialog}
    {saveError && <div className="events-dirty" role="status">{t(saveError.id, saveError.params)}
      <button type="button" className="toolbar-btn" disabled={busy} onClick={() => void useSceneStore.getState().revert()}>{t('events.revert')}</button></div>}
    {result && <DecidedNotice result={result} onClose={() => useEventStore.getState().setResult(null)} />}
    {!table || !lib ? <p className="agent-muted">{t('events.noProject')}</p> : <>
      <ResizableList label={t('editor.panel.events')}>{listItems}</ResizableList>
      <div className="events-detail-scroll">
        {effective ? <EventDetail key={cue!} table={table} lib={lib} e={effective} />
          : <p className="agent-muted">{t('events.selectHint')}</p>}
      </div>
    </>}
  </div>
}

/** The event list with a drag handle below it; the height is an editor UI setting (localStorage, folder copy, export). */
function ResizableList({ label, children }: { label: string; children: ReactNode }) {
  const { t } = useI18n()
  const saved = useEditorSettings(s => s.eventsListHeight)
  const [dragging, setDragging] = useState<number | null>(null)
  const start = useRef<{ y: number; h: number } | null>(null)
  const height = dragging ?? saved
  const clamp = (h: number) => Math.max(LIST_MIN, Math.min(LIST_MAX, Math.round(h)))
  const commit = (h: number) => { useEditorSettings.getState().update({ eventsListHeight: clamp(h) }); setDragging(null) }
  return <>
    <div className="events-list" role="listbox" aria-label={label} style={{ height }}>{children}</div>
    <div className="events-split" role="separator" aria-orientation="horizontal" aria-label={t('events.resize')} title={t('events.resize')} tabIndex={0}
      aria-valuemin={LIST_MIN} aria-valuemax={LIST_MAX} aria-valuenow={height}
      onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); start.current = { y: e.clientY, h: height } }}
      onPointerMove={e => { if (start.current) setDragging(clamp(start.current.h + e.clientY - start.current.y)) }}
      onPointerUp={e => { if (!start.current) return; const h = start.current.h + e.clientY - start.current.y; start.current = null; commit(h) }}
      onPointerCancel={() => { start.current = null; setDragging(null) }}
      onKeyDown={e => { if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); commit(height + (e.key === 'ArrowDown' ? 20 : -20)) } }} />
  </>
}

/** Project picker over the registry (game projects linked once in the Scene tab / editor); remembers the last one. */
function ProjectPicker() {
  const { t } = useI18n()
  const { linkSceneProject } = useEditor()
  const lib = useSceneStore(s => s.lib)
  const [names, setNames] = useState<string[]>([])
  const [need, setNeed] = useState<'needsClick' | 'dirty' | null>(null)
  const current = lib?.project_name ?? ''
  useEffect(() => { void useSceneStore.getState().restore() }, [])
  useEffect(() => { void sceneProjectNames().then(setNames, () => setNames([])) }, [current])
  useEffect(() => {
    setNeed(null)
    if (current) { writeLast(current); return }
    const last = readLast()
    if (!last) return
    let cancelled = false
    void useSceneStore.getState().linkProject(last, false).then(r => { if (!cancelled && !r.ok && (r.reason === 'needsClick' || r.reason === 'dirty')) setNeed(r.reason) })
    return () => { cancelled = true }
  }, [current])
  const options = [...new Set([...names, ...(current ? [current] : [])])].sort()
  return <div className="events-project">
    <label>{t('events.project')}
      <select value={current} onChange={e => {
        const value = e.target.value
        e.target.blur()
        if (value === NEW_FOLDER) void linkSceneProject(null)
        else if (value) void linkSceneProject(value)
      }}>
        {!current && <option value="">{t('events.pickProject')}</option>}
        {options.map(n => <option key={n} value={n}>{n}</option>)}
        <option value={NEW_FOLDER}>{t('events.addProject')}</option>
      </select></label>
    {need === 'needsClick' && <button type="button" className="toolbar-btn" onClick={() => void linkSceneProject(readLast())}>{t('editor.scene.allowButton')}</button>}
    {need === 'dirty' && <span className="events-warn">{t('scene.link.dirty')}</span>}
  </div>
}

function EventRowButton({ row, selected, onSelect, requested }: { row: EventRow; selected: boolean; onSelect: (key: string) => void; requested: { sound: boolean; haptic: boolean } }) {
  const { t } = useI18n()
  // 音 未定 (yellow) / 音 なし 仮|OK (grey) / 音 仮|OK (blue | green); — for a loop cue's sound where the project has none;
  // 「依頼済み」 (purple) while a request to the agent for it is open. Fixed width.
  const badge = (label: string, status: SoundStatus, asked: boolean) => asked ? <span className="events-badge requested" title={t('events.requested.hint')}>{label} {t('events.requested')}</span>
    : status === 'na' ? <span className="events-badge na">{label} —</span>
    : <span className={`events-badge ${status.state} ${status.state === 'undecided' ? '' : status.review}`}>{label} {status.state === 'undecided' ? t('events.undecided')
      : `${status.state === 'none' ? `${t('events.noneShort')} ` : ''}${t(status.review === 'approved' ? 'events.reviewApproved' : 'events.reviewTentative')}`}</span>
  return <button type="button" role="option" aria-selected={selected} className={`events-row ${selected ? 'selected' : ''}`} onClick={() => onSelect(row.key)} title={row.description ?? ''}>
    <span className="events-row-name">{row.key}{row.loop && <small>{t('events.loop')}</small>}</span>
    <span className="events-row-badges">{badge(t('events.badge.sound'), row.sound, requested.sound)}{badge(t('events.badge.haptic'), row.haptic, requested.haptic)}</span>
    {row.description && <small className="events-row-desc">{row.description}</small>}
  </button>
}

type Edit = (change: (tb: CueTable) => CueTable | null) => boolean

/**
 * One cue (DEC-085 addendum: the editor only picks materials). Variants, the variation and the material order
 * by situation are edited in the Scene tab (its event details).
 */
function EventDetail({ table, lib, e }: { table: CueTable; lib: SceneLib; e: EffectiveEvent }) {
  const { t } = useI18n()
  const { openSceneVideo } = useEditor()
  const key = eventKey(e.ref), loop = isLoopCue(lib, e.ref.cue)
  const clip = useWaveformStore(s => s.clip)
  const assign = (target: DecideTarget) => { if (clip) useEventStore.getState().requestDecide({ target, source: { kind: 'clip', clipId: clip.id }, event: key }) }
  const edit: Edit = change => useSceneStore.getState().edit(change)
  const variants = Object.keys(table.cues[e.ref.cue]?.variants ?? {})
  return <div className="events-detail">
    <div className="events-detail-head">
      <strong className="target-cue-badge events-target" title={t('editor.scene.targetHint')}>{key}</strong>
      <button type="button" className="toolbar-btn" title={t('editor.scene.openHint')} onClick={() => openSceneVideo({ kind: 'event', key }, lib.project_name)}>▶ {t('editor.scene.open')}</button>
    </div>
    {e.description && <p className="agent-muted">{e.description}</p>}
    <div className="events-assign">
      <span className="events-assign-clip" title={clip?.name ?? ''}>{t('events.selectedClip', { name: clip?.name ?? '—' })}</span>
      <button type="button" className="toolbar-btn" disabled={!clip || loop} title={t('events.addHint')} onClick={() => assign('sound')}>{t('events.assignSound')}</button>
      <button type="button" className="toolbar-btn" disabled={!clip} title={t('events.addHint')} onClick={() => assign('haptic')}>{t('events.assignHaptic')}</button>
    </div>
    <SoundSection lib={lib} e={e} loop={loop} edit={edit} />
    <HapticSection table={table} lib={lib} e={e} loop={loop} edit={edit} />
    {variants.length > 0 && <p className="agent-muted" title={t('events.variantsInSceneHint')}>
      <button type="button" className="agent-link" onClick={() => useEventStore.getState().openInScene(key)}>{t('events.variantsInScene', { count: variants.length })}</button></p>}
    <TrialsSection project={lib.project_name} eventKey={key} />
  </div>
}

/** The event's sound candidates (`sfx.sounds`; ★ = representative): ▶ opens one in the waveform panel and plays it (PC only), ×5 plays it five times. */
function SoundSection({ lib, e, loop, edit }: { lib: SceneLib; e: EffectiveEvent; loop: boolean; edit: Edit }) {
  const { t } = useI18n()
  const allowed = soundAllowed(lib, e.ref.cue)
  const soundFiles = useSceneStore(s => s.soundFiles)
  const previewId = useEventStore(s => s.preview?.id)
  const key = eventKey(e.ref), sounds = sfxSounds(e.sfx)
  const missing = (name: string) => useWaveformStore.getState().setError(t('events.preview.missing', { name }))
  const play = (s: string) => { if (!e.sfx || !openEventSound(key, s, e.sfx.volume, true)) missing(s) }
  const set = (list: string[]) => edit(tb => setSfxSounds(tb, e.ref, list))
  return <section className="events-sec">
    <h4 className="events-sec-head">{t('events.sound')}{allowed && <><ReviewToggle e={e} field="sfx" edit={edit} /><DecisionBar e={e} field="sfx" edit={edit} /></>}
      {allowed && e.sfx && <span className="events-field events-head-field">{t('scene.sound.volume')}
        <NumberField value={e.sfx.volume} min={0} max={2} step={0.05} label={t('scene.sound.volume')} onCommit={x => edit(tb => setOwnSfxVolume(tb, e.ref, x))} /></span>}
      {/* Ask for (more) sound candidates; after checking the sound (OK): on to the haptic — also for a cue without a sound. */}
      <span className="events-haptic-request"><button type="button" className="agent-icon-btn" title={t('events.soundRequest.hint')}
        onClick={() => { const k = `sound|${key}`; useReviseOpen.getState().set(useReviseOpen.getState().open === k ? null : k) }}>{t('events.soundRequest.button')}</button>
      <HapticRequestButton e={e} /></span></h4>
    <SoundRequestField cue={key} />
    {!allowed ? <p className="agent-muted">{t('scene.sound.loopCue')}</p> : <>
      {loop && <p className="agent-muted">{t('events.loopSoundHint')}</p>}
      {!sounds.length && <p className="agent-muted">{t(e.decided.sfx ? 'events.soundNone' : 'events.undecidedSound')}</p>}
      <MaterialList items={sounds} label={t('events.sound')} active={sounds.find(s => previewId === `${key}|sound|${s}`) ?? null} onPlay={play}
        onReorder={set} onRemove={set}
        extra={s => <MaterialActions event={key} target="sound" wav={s} />}
        below={s => <ReviseField cue={key} target="sound" material={s} />} />
      <Reserves cue={e.ref.cue} target="sound" />
      <select className="events-add-material" value="" aria-label={t('events.addSoundMulti')} title={t('events.soundDir', { dir: lib.paths.sounds })}
        onChange={ev => { const x = ev.target.value; ev.target.blur(); if (x) set([...sounds, x]) }}>
        <option value="">{t('events.addSoundMulti')}</option>
        {soundFiles.filter(s => !sounds.includes(s)).map(s => <option key={s} value={s}>{s}</option>)}
      </select>
    </>}
  </section>
}

/** Haptic output: one block per route (body position × gain) with its clip candidates (★ = representative); "＋ add position" plays the event on another position at the same time. */
function HapticSection({ table, lib, e, loop, edit }: { table: CueTable; lib: SceneLib; e: EffectiveEvent; loop: boolean; edit: Edit }) {
  const { t } = useI18n()
  const atLabel = useAtLabel()
  const previewId = useEventStore(s => s.preview?.id)
  const key = eventKey(e.ref)
  const fitting = clipsForCue(table, lib, e.ref.cue)
  const missing = (name: string) => useWaveformStore.getState().setError(t('events.preview.missing', { name }))
  const free = positionsForCue(lib, e.ref.cue).some(a => !e.haptics.some(r => r.at === a))
  return <section className="events-sec">
    <h4 className="events-sec-head">{t('events.haptic')}<ReviewToggle e={e} field="haptics" edit={edit} /><DecisionBar e={e} field="haptics" edit={edit} /></h4>
    {!loop && !e.decided.sfx && <p className="events-hint">{t('events.soundFirst')}</p>}
    {!e.haptics.length && <p className="agent-muted">{t(e.decided.haptics ? 'events.hapticNone' : 'events.undecidedHaptic')}</p>}
    {e.haptics.map((r, i) => {
      const clips = routeClips(r), set = (list: string[]) => edit(tb => setRouteClips(tb, e.ref, i, list))
      return <div key={i} className="events-route" title={t('events.hapticRowsHint')}>
        <div className="events-route-head">
          <select value={r.at} aria-label={t('scene.route.at')} onChange={ev => { const v = ev.target.value; ev.target.blur(); edit(tb => updateOwnRoute(tb, e.ref, i, { at: v })) }}>
            {[...new Set([...positionsForCue(lib, e.ref.cue), r.at])].map(a => <option key={a} value={a}>{atLabel(a)}</option>)}
          </select>
          <span className="events-field">gain <NumberField value={r.gain} min={0} max={2} step={0.05} label={t('scene.route.gain')} onCommit={x => edit(tb => updateOwnRoute(tb, e.ref, i, { gain: x }))} /></span>
          <select className="events-add-material" value="" aria-label={t('events.addClipMulti')} onChange={ev => { const x = ev.target.value; ev.target.blur(); if (x) set([...clips, x]) }}>
            <option value="">{t('events.addClipMulti')}</option>
            {fitting.filter(c => !clips.includes(c)).map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <button type="button" className="scene-icon-btn" aria-label={t('scene.route.remove')} title={t('scene.route.remove')} onClick={() => edit(tb => removeOwnRoute(tb, e.ref, i))}>✕</button>
        </div>
        <MaterialList items={clips} label={t('scene.route.clip')} active={clips.find(c => previewId === `${key}|haptic|${c}|${r.at}`) ?? null}
          onPlay={c => { if (!openEventHaptic(key, c, r.gain, r.at, true)) missing(c) }} onReorder={set} onRemove={set} minItems={1}
          extra={c => <MaterialActions event={key} target="haptic" wav={c} />}
          below={c => <ReviseField cue={key} target="haptic" material={c} />} />
      </div>
    })}
    <Reserves cue={e.ref.cue} target="haptic" />
    <button type="button" className="toolbar-btn events-add" disabled={!free} title={t('events.addPositionHint')}
      onClick={() => { if (!edit(tb => addPositionRoute(tb, lib, e.ref))) useWaveformStore.getState().setError(t(loop ? 'scene.route.noLoopClip' : 'scene.route.noClip')) }}>＋ {t('events.addPosition')}</button>
  </section>
}

/** AI trials made for this event (their `scene` names it), sound and haptic apart. */
function TrialsSection({ project, eventKey: key }: { project: string; eventKey: string }) {
  const { t } = useI18n()
  const { focusEditorPanel } = useEditor()
  const trials = useAgentTrialStore(s => s.trials)
  const linked = useMemo(() => trialsForEvent(trials, project, key), [trials, project, key])
  const open = (id: string) => { useAgentTrialStore.getState().selectTrial(id); useSceneVideoTarget.getState().setTarget({ kind: 'trial', trialId: id }); focusEditorPanel('agent') }
  const list = (items: typeof trials, empty: string) => items.length ? <ul className="events-trials">
    {items.map(r => <li key={r.trial.id}><button type="button" className="agent-link" onClick={() => open(r.trial.id)}>{r.trial.terms.join(' · ')}</button>
      <small> {r.trial.id}</small> <span className={`agent-badge ${r.rating ? 'rated' : 'unrated'}`}>{t(r.rating ? 'editor.agent.rated' : 'editor.agent.unrated')}</span></li>)}
  </ul> : <p className="agent-muted">{empty}</p>
  return <section className="events-sec">
    <h4>{t('events.trials')}</h4>
    <h5>{t('events.trials.sound')}</h5>{list(linked.sound, t('events.trials.none'))}
    <h5>{t('events.trials.haptic')}</h5>{list(linked.haptic, t('events.trials.none'))}
  </section>
}

/** Opens the material in the editor as a clip to process with effects (the clip it was decided from when known); "→ Event" on it assigns it back. */
function EditAsClipButton({ event, target, wav }: { event: string; target: DecideTarget; wav: string }) {
  const { t } = useI18n()
  const { focusEditorPanel } = useEditor()
  const [busy, setBusy] = useState(false)
  const open = async () => {
    setBusy(true)
    try { await openEventMaterialForEditing(event, target, wav); focusEditorPanel('waveform') }
    catch (error) { useWaveformStore.getState().setError(error) }
    finally { setBusy(false) }
  }
  return <button type="button" className="agent-icon-btn events-edit-clip" disabled={busy} title={t('events.editAsClipHint')} onClick={() => void open()}>{t('events.editAsClip')}</button>
}

/** "Tentative" ↔ "OK" of an assigned sound / haptic (decisions start tentative; saved with the table). Kept in place (hidden) while undecided. */
function ReviewToggle({ e, field, edit }: { e: EffectiveEvent; field: 'sfx' | 'haptics'; edit: Edit }) {
  const { t } = useI18n()
  const approved = e.review[field] === 'approved'
  return <span className="events-review" style={{ visibility: e.decided[field] ? 'visible' : 'hidden' }}>
    <span className={`events-badge ${e.review[field]}`}>{t(approved ? 'events.reviewApproved' : 'events.reviewTentative')}</span>
    <button type="button" className="agent-icon-btn" title={t(approved ? 'events.reviewBackHint' : 'events.reviewApproveHint')}
      onClick={() => edit(tb => setReview(tb, e.ref, field, approved ? 'tentative' : 'approved'))}>{t(approved ? 'events.reviewBack' : 'events.reviewApprove')}</button>
  </span>
}

/**
 * Decided vs undecided: "None" (sfx: null / haptics: []) and, on a cue, "Back to undecided" (the key removed).
 * A variant goes back to inheriting with the override bar instead.
 */
function DecisionBar({ e, field, edit }: { e: EffectiveEvent; field: 'sfx' | 'haptics'; edit: Edit }) {
  const { t } = useI18n()
  const isNone = e.decided[field] && (field === 'sfx' ? !e.sfx : e.haptics.length === 0)
  // Fixed slots on the section's head line: a button that does not apply is hidden, not removed (nothing moves).
  return <span className="events-decision">
    <button type="button" className="agent-icon-btn" style={{ visibility: isNone ? 'hidden' : 'visible' }} title={t(field === 'sfx' ? 'events.setNoneSoundHint' : 'events.setNoneHapticHint')} onClick={() => edit(tb => setNone(tb, e.ref, field))}>{t('events.setNone')}</button>
    <button type="button" className="agent-icon-btn" style={{ visibility: e.ref.variant === null && e.decided[field] ? 'visible' : 'hidden' }} title={t('events.setUndecidedHint')} onClick={() => edit(tb => setUndecided(tb, e.ref.cue, field))}>{t('events.setUndecided')}</button>
  </span>
}

/**
 * The event's reserves (★3 AI candidates kept aside, editor settings): faint rows under the materials.
 * ▶ auditions the candidate as rendered; "Adopt" does what "→ Event" does (writes the WAV, adds it to the
 * end of the pool, tentative) and drops it from the reserves; "Remove" only drops it.
 */
function Reserves({ cue, target }: { cue: string; target: 'sound' | 'haptic' }) {
  const { t } = useI18n()
  const all = useEditorSettings(s => s.eventReserves)
  const trials = useAgentTrialStore(s => s.trials)
  const [busy, setBusy] = useState(false)
  const rows = Object.entries(all).filter(([key]) => parseEventKey(key).cue === cue).flatMap(([key, refs]) => refs.filter(r => r.target === target).map(r => ({ key, ...r })))
  if (!rows.length) return null
  const drop = (key: string, r: { trialId: string; candidateId: string }) => useEditorSettings.getState().update({ eventReserves: removeReserve(useEditorSettings.getState().eventReserves, key, r) })
  const adopt = async (row: typeof rows[number]) => {
    const scene = useSceneStore.getState()
    if (!scene.table || !scene.lib) { useWaveformStore.getState().setError(t('scene.save.noProject')); return }
    const events = assignEventsForTrial(scene.table, scene.lib, [row.key], target)
    if (!events.length) { useWaveformStore.getState().setError(t('events.auto.noEvents', { cues: row.key })); return }
    setBusy(true)
    try {
      const r = await runDecision({ target, source: { kind: 'candidate', trialId: row.trialId, candidateId: row.candidateId }, events, name: null, at: null, gain: 1 })
      if (r.ok) drop(row.key, row); else useWaveformStore.getState().setError(t(r.notice.id, r.notice.params))
    } catch (error) { useWaveformStore.getState().setError(error) }
    finally { setBusy(false) }
  }
  return <ul className="events-reserves" aria-label={t('events.reserves')} title={t('events.reservesHint')}>
    {rows.map(row => {
      const record = trials.find(r => r.trial.id === row.trialId)
      const name = `${record?.shortId ? `${record.shortId}-` : ''}${row.candidateId} ${record?.trial.candidates.find(c => c.id === row.candidateId)?.label ?? row.trialId}`
      return <li key={`${row.key}/${row.trialId}/${row.candidateId}`} className="events-mat events-reserve">
        <button type="button" className="agent-icon-btn" disabled={!record} aria-label={t('events.mat.play', { name })} title={t('events.mat.play', { name })}
          onClick={() => void useAgentTrialStore.getState().requestAudition(row.trialId, row.candidateId, true, false).catch(error => useWaveformStore.getState().setError(error))}>▶</button>
        <span className="events-mat-name" title={`${name}${row.key !== cue ? ` (${row.key})` : ''}`}>{name}{row.key !== cue ? ` · ${row.key}` : ''}</span>
        <span />
        <button type="button" className="agent-icon-btn" disabled={busy || !record} title={t('events.reserveAdoptHint')} onClick={() => void adopt(row)}>{t('events.reserveAdopt')}</button>
        <button type="button" className="agent-icon-btn" title={t('events.reserveRemoveHint')} onClick={() => drop(row.key, row)}>{t('events.mat.remove')}</button>
      </li>
    })}
  </ul>
}

/** Which material's remake comment field is open (one at a time). */
const useReviseOpen = create<{ open: string | null; set: (open: string | null) => void }>(set => ({ open: null, set: open => set({ open }) }))
const reviseKey = (cue: string, target: string, material: string) => `${cue}|${target}|${material}`

/** "Edit as clip" and "Remake" (opens the one-line comment under the row) of one material row. */
function MaterialActions({ event, target, wav }: { event: string; target: DecideTarget; wav: string }) {
  const { t } = useI18n()
  return <span className="events-mat-actions">
    <EditAsClipButton event={event} target={target} wav={wav} />
    <button type="button" className="agent-icon-btn" title={t('events.revise.hint')} onClick={() => { const key = reviseKey(event, target, wav); useReviseOpen.getState().set(useReviseOpen.getState().open === key ? null : key) }}>{t('events.revise.open')}</button>
  </span>
}

/**
 * Open requests to the agent per cue (`<cue>|sound` / `<cue>|haptic`): remakes (by the material's target) and
 * "go to haptics"; answered ones (a trial for the cue arrived after them, a haptic one for haptics) are dropped.
 */
function useOpenRequests(): Set<string> {
  const revise = useEditorSettings(s => s.revisePending)
  const haptic = useEditorSettings(s => s.hapticPending)
  const sound = useEditorSettings(s => s.soundPending)
  const trials = useAgentTrialStore(s => s.trials)
  const openRevise = useMemo(() => revise.filter(r => !reviseAnswered(r, trials)), [revise, trials])
  const openHaptic = useMemo(() => haptic.filter(r => !requestAnswered(r, 'haptic', trials)), [haptic, trials])
  const openSound = useMemo(() => sound.filter(r => !requestAnswered(r, 'sound', trials)), [sound, trials])
  useEffect(() => {
    if (openRevise.length !== revise.length || openHaptic.length !== haptic.length || openSound.length !== sound.length)
      useEditorSettings.getState().update({ revisePending: openRevise, hapticPending: openHaptic, soundPending: openSound })
  }, [openRevise, openHaptic, openSound, revise.length, haptic.length, sound.length])
  return useMemo(() => new Set([...openRevise.map(r => `${parseEventKey(r.cue).cue}|${r.target}`), ...openHaptic.map(r => `${parseEventKey(r.cue).cue}|haptic`),
    ...openSound.map(r => `${parseEventKey(r.cue).cue}|sound`)]), [openRevise, openHaptic, openSound])
}

/** The one-line remake comment under a material row: Enter sends (hapbeat-agent-message@1 `revise`), Esc closes. */
function ReviseField({ cue, target, material }: { cue: string; target: 'sound' | 'haptic'; material: string }) {
  const { t } = useI18n()
  const open = useReviseOpen(s => s.open === reviseKey(cue, target, material))
  const [comment, setComment] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  if (!open) return null
  const close = () => { useReviseOpen.getState().set(null); setComment(''); setError(null) }
  const send = async () => {
    if (!comment.trim() || busy) return
    setBusy(true)
    try {
      const project = useSceneStore.getState().lib?.project_name
      await useAgentTrialStore.getState().sendAgentMessage({ text: t('events.revise.message', { cue, material, comment: comment.trim() }), project, revise: { cue, target, material, comment } })
      const settings = useEditorSettings.getState()
      settings.update({ revisePending: [...settings.revisePending, { cue, target, material, at: new Date().toISOString() }] })
      close()
    } catch (err) { setError(t('events.revise.failed', { error: err instanceof Error ? err.message : String(err) })) }
    finally { setBusy(false) }
  }
  return <div className="events-revise">
    <input autoFocus value={comment} disabled={busy} placeholder={t('events.revise.placeholder')} aria-label={t('events.revise.placeholder')} title={error ?? t('events.revise.hint')}
      onChange={e => { setComment(e.target.value); setError(null) }}
      onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); void send() } else if (e.key === 'Escape') { e.preventDefault(); close() } }} />
    {error && <small className="events-warn">{error}</small>}
  </div>
}

/**
 * "Go to haptics" (right end of the haptic heading): asks the agent for this cue's haptic, matching its
 * representative sound (outbox `haptic`). "Haptic requested" shows until a haptic trial for the cue arrives.
 * Allowed without a sound ("none", e.g. grab); with the sound undecided the title warns.
 */
function HapticRequestButton({ e }: { e: EffectiveEvent }) {
  const { t } = useI18n()
  const cue = eventKey(e.ref)
  const [error, setError] = useState<string | null>(null)
  const sound = sfxSounds(e.sfx)[0] ?? null
  const send = async () => {
    setError(null)
    try {
      const project = useSceneStore.getState().lib?.project_name
      await useAgentTrialStore.getState().sendAgentMessage({ text: t('events.hapticRequest.message', { cue, sound: sound ?? t('events.hapticRequest.noSound') }), project, haptic: { cue, sound } })
      const settings = useEditorSettings.getState()
      settings.update({ hapticPending: [...settings.hapticPending, { cue, at: new Date().toISOString() }] })
    } catch (err) { setError(t('events.revise.failed', { error: err instanceof Error ? err.message : String(err) })) }
  }
  const title = [t('events.hapticRequest.hint'), ...(e.decided.sfx ? [] : [t('events.hapticRequest.soundUndecided')]), ...(error ? [error] : [])].join('\n')
  return <button type="button" className={`agent-icon-btn ${error ? 'error' : ''}`} title={title} onClick={() => void send()}>{t('events.hapticRequest.button')}</button>
}

/** The one-line sound request under the sound heading: Enter sends (outbox `sound`), Esc closes. */
function SoundRequestField({ cue }: { cue: string }) {
  const { t } = useI18n()
  const open = useReviseOpen(s => s.open === `sound|${cue}`)
  const [comment, setComment] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  if (!open) return null
  const close = () => { useReviseOpen.getState().set(null); setComment(''); setError(null) }
  const send = async () => {
    if (!comment.trim() || busy) return
    setBusy(true)
    try {
      const project = useSceneStore.getState().lib?.project_name
      await useAgentTrialStore.getState().sendAgentMessage({ text: t('events.soundRequest.message', { cue, comment: comment.trim() }), project, sound: { cue, comment } })
      const settings = useEditorSettings.getState()
      settings.update({ soundPending: [...settings.soundPending, { cue, at: new Date().toISOString() }] })
      close()
    } catch (err) { setError(t('events.revise.failed', { error: err instanceof Error ? err.message : String(err) })) }
    finally { setBusy(false) }
  }
  return <div className="events-revise">
    <input autoFocus value={comment} disabled={busy} placeholder={t('events.soundRequest.placeholder')} aria-label={t('events.soundRequest.placeholder')} title={error ?? t('events.soundRequest.hint')}
      onChange={e => { setComment(e.target.value); setError(null) }}
      onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); void send() } else if (e.key === 'Escape') { e.preventDefault(); close() } }} />
    {error && <small className="events-warn">{error}</small>}
  </div>
}
