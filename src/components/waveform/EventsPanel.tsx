import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { useI18n, type MessageId } from '@/i18n/I18nProvider'
import { useSceneStore } from '@/stores/sceneStore'
import { useEventStore, type DecideTarget } from '@/stores/eventStore'
import { useAgentTrialStore } from '@/stores/agentTrialStore'
import { useWaveformStore } from '@/stores/waveformStore'
import { useEditorSettings } from '@/stores/editorSettings'
import { sceneProjectNames } from '@/utils/sceneRegistry'
import { useSceneVideoTarget } from '@/utils/editorSceneSync'
import { clipsForCue, isLoopCue, PICK_MODES, positionsForCue, routeClips, sfxSounds, VARIANT_NAME, type CueTable, type CueVariation, type VariationNumberKey } from '@/utils/sceneCueTable'
import type { SceneLib } from '@/utils/sceneData'
import {
  addPositionRoute, addVariant, effectiveEvent, eventFireCounts, eventKey, hasRepeatSettings, listEvents, parseEventKey, removeOwnRoute, removeVariant,
  setOverride, setOwnSfxVolume, setRouteClips, setSfxSounds, setVariation, simultaneousGroups, trialsForEvent, updateOwnRoute,
  type EffectiveEvent, type EventRef, type EventRow,
} from '@/utils/cueEvents'
import { NumberField, formatGain, useAtLabel } from '@/components/scene/SceneCuePanels'
import { useEditor } from './editorContext'
import { DecidedNotice } from './DecideDialog'
import { EditorMenu, EditorMenuItem } from './EditorMenu'
import { openEventDefault, openEventHaptic, openEventSound } from './eventAudio'
import './EventsPanel.css'

const LAST_PROJECT_KEY = 'hapbeat-events-project'
const NEW_FOLDER = ' new'
/** Select value of a multi-material route / sound (not a valid name). */
const MULTI = ' multi'
const LIST_MIN = 80, LIST_MAX = 1200
const readLast = () => { try { return localStorage.getItem(LAST_PROJECT_KEY) } catch { return null } }
const writeLast = (name: string) => { try { localStorage.setItem(LAST_PROJECT_KEY, name) } catch { /* preference only */ } }
/** Row clicks open the material in the waveform panel; clicks on the row's own controls do not. */
const onRowClick = (open: () => void) => (e: MouseEvent) => { if (!(e.target as HTMLElement).closest('button, input, select, textarea, label')) open() }

/**
 * "Events": the events (cues and their variants) of the game project open in
 * the Scene tab (same store, picked through the project registry), whether each
 * has its sound / haptic decided, and per event: its sound and haptic routes
 * (a click opens the WAV in the waveform panel for the normal playback),
 * repetition settings, variants, the AI trials made for it, and "assign" of the
 * selected editor clip. Cues the recording plays at the same moment are grouped
 * (display only). Edits mark the table unsaved (Save / Revert at the top, same
 * as the Scene tab); "decide" writes at once.
 */
export function EventsPanel() {
  const { t } = useI18n()
  const table = useSceneStore(s => s.table)
  const lib = useSceneStore(s => s.lib)
  const data = useSceneStore(s => s.data)
  const dirty = useSceneStore(s => s.dirty)
  const busy = useSceneStore(s => s.busy)
  const result = useEventStore(s => s.result)
  const selected = useEventStore(s => s.selected)
  const showAllRepeat = useEditorSettings(s => s.eventsShowAllRepeat)
  const rows = useMemo(() => table && lib ? listEvents(table, lib) : [], [table, lib])
  const groups = useMemo(() => table && lib && data ? simultaneousGroups(table, data.clips, lib.ticks) : [], [table, lib, data])
  const counts = useMemo(() => table && data ? eventFireCounts(table, data.full.events) : {}, [table, data])
  const select = (key: string) => {
    useEventStore.getState().select(key)
    // The Scene video panel (window or docked, never opened here) shows this event's moment.
    useSceneVideoTarget.getState().setTarget({ kind: 'event', key })
    // The waveform panel follows: the event's haptic, else its sound.
    openEventDefault(key)
  }
  const effective = table && selected ? effectiveEvent(table, parseEventKey(selected)) : null
  const block = (r: EventRow) => <div key={r.key}>
    <EventRowButton row={r} selected={selected === r.key} onSelect={select} />
    {r.variants.map(v => <EventRowButton key={v.key} row={v} selected={selected === v.key} onSelect={select} />)}
  </div>
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
        <EditorMenuItem checked={showAllRepeat} onSelect={() => useEditorSettings.getState().update({ eventsShowAllRepeat: !showAllRepeat })}>{t('events.showAllRepeat')}</EditorMenuItem>
      </EditorMenu>
    </div>
    {dirty && <div className="events-dirty" role="status">{t('events.unsaved')}
      <button type="button" className="toolbar-btn" disabled={busy} onClick={() => void useSceneStore.getState().save()}>{t('events.save')}</button>
      <button type="button" className="toolbar-btn" disabled={busy} onClick={() => void useSceneStore.getState().revert()}>{t('events.revert')}</button></div>}
    {result && <DecidedNotice result={result} onClose={() => useEventStore.getState().setResult(null)} />}
    {!table || !lib ? <p className="agent-muted">{t('events.noProject')}</p> : <>
      <ResizableList label={t('editor.panel.events')}>{listItems}</ResizableList>
      <div className="events-detail-scroll">
        {effective ? <EventDetail key={selected!} table={table} lib={lib} e={effective} onSelect={select} fireCount={counts[selected!] ?? 0} showAllRepeat={showAllRepeat} />
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

function EventRowButton({ row, selected, onSelect }: { row: EventRow; selected: boolean; onSelect: (key: string) => void }) {
  const { t } = useI18n()
  const variant = row.ref.variant !== null
  const badge = (label: string, state: 'set' | 'unset' | 'na') => <span className={`events-badge ${state}`}>{label} {state === 'set' ? '✓' : state === 'unset' ? t('events.notYet') : '—'}</span>
  return <button type="button" role="option" aria-selected={selected} className={`events-row ${selected ? 'selected' : ''} ${variant ? 'variant' : ''}`} onClick={() => onSelect(row.key)} title={row.description ?? ''}>
    <span className="events-row-name">{variant ? <>{`:${row.ref.variant}`}<span className="events-tag variant">{t('events.variantTag')}</span></> : row.key}{row.loop && <small>{t('events.loop')}</small>}</span>
    <span className="events-row-badges">{badge(t('events.badge.sound'), row.sound)}{badge(t('events.badge.haptic'), row.haptic)}</span>
    {row.description && <small className="events-row-desc">{row.description}</small>}
  </button>
}

type Edit = (change: (tb: CueTable) => CueTable | null) => boolean

function EventDetail({ table, lib, e, onSelect, fireCount, showAllRepeat }: { table: CueTable; lib: SceneLib; e: EffectiveEvent; onSelect: (key: string) => void; fireCount: number; showAllRepeat: boolean }) {
  const { t } = useI18n()
  const { openSceneVideo } = useEditor()
  const key = eventKey(e.ref), loop = isLoopCue(lib, e.ref.cue)
  const clip = useWaveformStore(s => s.clip)
  const assign = (target: DecideTarget) => { if (clip) useEventStore.getState().requestDecide({ target, source: { kind: 'clip', clipId: clip.id }, event: key }) }
  const edit: Edit = change => useSceneStore.getState().edit(change)
  const repeat = showAllRepeat || fireCount >= 2 || hasRepeatSettings(e)
  return <div className="events-detail">
    <div className="events-detail-head">
      <strong>{key}</strong>
      <button type="button" className="toolbar-btn" title={t('editor.scene.openHint')} onClick={() => openSceneVideo({ kind: 'event', key }, lib.project_name)}>▶ {t('editor.scene.open')}</button>
    </div>
    {e.description && <p className="agent-muted">{e.description}</p>}
    <div className="events-assign">
      <span className="events-assign-clip" title={clip?.name ?? ''}>{t('events.selectedClip', { name: clip?.name ?? '—' })}</span>
      <button type="button" className="toolbar-btn" disabled={!clip || loop} onClick={() => assign('sound')}>{t('events.assignSound')}</button>
      <button type="button" className="toolbar-btn" disabled={!clip} onClick={() => assign('haptic')}>{t('events.assignHaptic')}</button>
    </div>
    <SoundSection lib={lib} e={e} loop={loop} edit={edit} />
    <HapticSection table={table} lib={lib} e={e} loop={loop} edit={edit} />
    {repeat && <RepeatSection table={table} lib={lib} e={e} loop={loop} edit={edit} fireCount={fireCount} />}
    <VariantsSection table={table} e={e} onSelect={onSelect} edit={edit} />
    <TrialsSection project={lib.project_name} eventKey={key} />
  </div>
}

/** For a variant: "inherited from the cue" with an override button, or "own" with a button back to inheriting. */
function OverrideBar({ e, field, edit }: { e: EffectiveEvent; field: 'sfx' | 'haptics' | 'variation'; edit: Edit }) {
  const { t } = useI18n()
  if (e.ref.variant === null) return null
  const own = e.own[field]
  return <div className="events-override">
    <span className="agent-muted">{t(own ? 'events.variant.own' : 'events.variant.inherited', { cue: e.ref.cue })}</span>
    <button type="button" className="toolbar-btn" onClick={() => edit(tb => setOverride(tb, e.ref, field, !own))}>{t(own ? 'events.variant.inherit' : 'events.variant.override')}</button>
  </div>
}

/** The event's sound: one row (a click opens it in the waveform panel; PC playback only). Several sounds are edited under "Repetition". */
function SoundSection({ lib, e, loop, edit }: { lib: SceneLib; e: EffectiveEvent; loop: boolean; edit: Edit }) {
  const { t } = useI18n()
  const soundFiles = useSceneStore(s => s.soundFiles)
  const previewId = useEventStore(s => s.preview?.id)
  const key = eventKey(e.ref), sounds = sfxSounds(e.sfx), editable = e.own.sfx
  const open = () => { if (e.sfx && sounds[0] && !openEventSound(key, sounds[0], e.sfx.volume)) useWaveformStore.getState().setError(t('events.preview.missing', { name: sounds[0] })) }
  return <section className="events-sec">
    <h4>{t('events.sound')}</h4>
    {loop ? <p className="agent-muted">{t('scene.sound.loopCue')}</p> : <>
      <OverrideBar e={e} field="sfx" edit={edit} />
      {!sounds.length && !editable && <p className="agent-muted">{t('events.soundNone')}</p>}
      {(sounds.length > 0 || editable) && <div className={`events-material ${previewId === `${key}|sound|${sounds[0]}` ? 'active' : ''}`} onClick={onRowClick(open)} title={t('events.openHint')}>
        {editable ? <select value={sounds.length > 1 ? MULTI : sounds[0] ?? ''} aria-label={t('events.sound')} onChange={ev => { const v = ev.target.value; ev.target.blur(); edit(tb => setSfxSounds(tb, e.ref, v ? [v] : [])) }}>
          <option value="">{t('events.soundNone')}</option>
          {sounds.length > 1 && <option value={MULTI} disabled>{t('events.multiSounds', { count: sounds.length })}</option>}
          {soundFiles.map(s => <option key={s} value={s}>{s}</option>)}
        </select> : <span>{sounds.length > 1 ? t('events.multiSounds', { count: sounds.length }) : sounds[0]}</span>}
        {e.sfx && <span className="events-field">{t('scene.sound.volume')} {editable
          ? <NumberField value={e.sfx.volume} min={0} max={2} step={0.05} label={t('scene.sound.volume')} onCommit={x => edit(tb => setOwnSfxVolume(tb, e.ref, x))} />
          : formatGain(e.sfx.volume)}</span>}
      </div>}
      <p className="agent-muted">{t('events.soundDir', { dir: lib.paths.sounds })}</p>
    </>}
  </section>
}

/** Haptic output: one row = one clip × body position × gain; "＋ add position" plays the event on another position at the same time. */
function HapticSection({ table, lib, e, loop, edit }: { table: CueTable; lib: SceneLib; e: EffectiveEvent; loop: boolean; edit: Edit }) {
  const { t } = useI18n()
  const atLabel = useAtLabel()
  const previewId = useEventStore(s => s.preview?.id)
  const key = eventKey(e.ref), editable = e.own.haptics
  const fitting = clipsForCue(table, lib, e.ref.cue)
  const open = (clip: string | undefined, gain: number, at: string) => { if (clip && !openEventHaptic(key, clip, gain, at)) useWaveformStore.getState().setError(t('events.preview.missing', { name: clip })) }
  const free = positionsForCue(lib, e.ref.cue).some(a => !e.haptics.some(r => r.at === a))
  return <section className="events-sec">
    <h4>{t('events.haptic')}</h4>
    {!loop && !e.sfx && <p className="events-hint">{t('events.soundFirst')}</p>}
    <OverrideBar e={e} field="haptics" edit={edit} />
    <p className="agent-muted">{t('events.hapticRowsHint')}</p>
    {!e.haptics.length && <p className="agent-muted">{t('events.hapticNone')}</p>}
    {e.haptics.map((r, i) => {
      const clips = routeClips(r), first = clips[0]
      return <div key={i} className={`events-material ${previewId === `${key}|haptic|${first}|${r.at}` ? 'active' : ''}`} onClick={onRowClick(() => open(first, r.gain, r.at))} title={t('events.openHint')}>
        {editable ? <>
          <select value={clips.length > 1 ? MULTI : first} aria-label={t('scene.route.clip')} onChange={ev => { const v = ev.target.value; ev.target.blur(); edit(tb => setRouteClips(tb, e.ref, i, [v])) }}>
            {clips.length > 1 && <option value={MULTI} disabled>{t('events.multiClips', { count: clips.length })}</option>}
            {[...new Set([...fitting, ...(first ? [first] : [])])].map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <select value={r.at} aria-label={t('scene.route.at')} onChange={ev => { const v = ev.target.value; ev.target.blur(); edit(tb => updateOwnRoute(tb, e.ref, i, { at: v })) }}>
            {[...new Set([...positionsForCue(lib, e.ref.cue), r.at])].map(a => <option key={a} value={a}>{atLabel(a)}</option>)}
          </select>
          <span className="events-field">gain <NumberField value={r.gain} min={0} max={2} step={0.05} label={t('scene.route.gain')} onCommit={x => edit(tb => updateOwnRoute(tb, e.ref, i, { gain: x }))} /></span>
          <button type="button" className="scene-icon-btn" aria-label={t('scene.route.remove')} title={t('scene.route.remove')} onClick={() => edit(tb => removeOwnRoute(tb, e.ref, i))}>✕</button>
        </> : <span>{clips.length > 1 ? t('events.multiClips', { count: clips.length }) : first} × {atLabel(r.at)} × gain {formatGain(r.gain)}</span>}
      </div>
    })}
    {editable && <button type="button" className="toolbar-btn events-add" disabled={!free} title={t('events.addPositionHint')}
      onClick={() => { if (!edit(tb => addPositionRoute(tb, lib, e.ref))) useWaveformStore.getState().setError(t(loop ? 'scene.route.noLoopClip' : 'scene.route.noClip')) }}>＋ {t('events.addPosition')}</button>}
  </section>
}

const VARIATION_FIELDS: { key: VariationNumberKey; max: number; step: number; loopOk: boolean }[] = [
  { key: 'gainJitterDb', max: 12, step: 0.5, loopOk: true },
  { key: 'pitchJitterSt', max: 12, step: 0.5, loopOk: false },
  { key: 'rateJitterPct', max: 50, step: 1, loopOk: false },
]

/**
 * "Repetition" (collapsed): settings that change an event a little every time it
 * fires — several clips / sounds with how one is picked, and the jitter of
 * v2 `variation`. Shown for events the recording fires twice or more, or that
 * already have such settings (or all, from the panel's ⋯ menu). In a loop cue
 * only the gain jitter applies.
 */
function RepeatSection({ table, lib, e, loop, edit, fireCount }: { table: CueTable; lib: SceneLib; e: EffectiveEvent; loop: boolean; edit: Edit; fireCount: number }) {
  const { t } = useI18n()
  const atLabel = useAtLabel()
  const soundFiles = useSceneStore(s => s.soundFiles)
  const previewId = useEventStore(s => s.preview?.id)
  const [open, setOpen] = useState(false)
  const key = eventKey(e.ref), v: CueVariation = e.variation ?? {}
  const sounds = sfxSounds(e.sfx), set = (patch: Partial<CueVariation>) => edit(tb => setVariation(tb, e.ref, patch))
  const fitting = clipsForCue(table, lib, e.ref.cue)
  const chip = (name: string, active: boolean, onOpen: () => void, onRemove: (() => void) | null) => <span key={name} className={`events-chip ${active ? 'active' : ''}`} onClick={onRowClick(onOpen)} title={t('events.openHint')}>{name}
    {onRemove && <button type="button" className="scene-icon-btn" aria-label={t('events.remove')} title={t('events.remove')} onClick={onRemove}>✕</button>}</span>
  return <section className="events-sec">
    <button type="button" className="events-collapse" aria-expanded={open} onClick={() => setOpen(!open)}>
      <span aria-hidden="true">{open ? '▾' : '▸'}</span><strong>{t('events.repeat')}</strong>
      <span className="agent-muted">{t('events.repeatHint')}</span>
      <small className="events-repeat-meta">{t('events.firedTimes', { count: fireCount })}{hasRepeatSettings(e) ? ` · ${t('events.repeatSet')}` : ''}</small>
    </button>
    {open && <div className="events-repeat">
      {!loop && <>
        <h5>{t('events.repeat.sounds')}</h5>
        {e.sfx ? <div className="events-chips">
          {sounds.map(s => chip(s, previewId === `${key}|sound|${s}`, () => openEventSound(key, s, e.sfx!.volume), e.own.sfx && sounds.length > 1 ? () => edit(tb => setSfxSounds(tb, e.ref, sounds.filter(x => x !== s))) : null))}
          {e.own.sfx && <select value="" aria-label={t('events.addSoundMulti')} onChange={ev => { const x = ev.target.value; ev.target.blur(); if (x) edit(tb => setSfxSounds(tb, e.ref, [...sounds, x])) }}>
            <option value="">{t('events.addSoundMulti')}</option>
            {soundFiles.filter(s => !sounds.includes(s)).map(s => <option key={s} value={s}>{s}</option>)}
          </select>}
        </div> : <p className="agent-muted">{t('events.soundNone')}</p>}
        <h5>{t('events.repeat.clips')}</h5>
        {e.haptics.map((r, i) => {
          const clips = routeClips(r)
          return <div key={i} className="events-chips"><span className="agent-muted">{atLabel(r.at)}:</span>
            {clips.map(c => chip(c, previewId === `${key}|haptic|${c}|${r.at}`, () => openEventHaptic(key, c, r.gain, r.at), e.own.haptics && clips.length > 1 ? () => edit(tb => setRouteClips(tb, e.ref, i, clips.filter(x => x !== c))) : null))}
            {e.own.haptics && <select value="" aria-label={t('events.addClipMulti')} onChange={ev => { const x = ev.target.value; ev.target.blur(); if (x) edit(tb => setRouteClips(tb, e.ref, i, [...clips, x])) }}>
              <option value="">{t('events.addClipMulti')}</option>
              {fitting.filter(c => !clips.includes(c)).map(c => <option key={c} value={c}>{c}</option>)}
            </select>}
          </div>
        })}
        {!e.haptics.length && <p className="agent-muted">{t('events.hapticNone')}</p>}
      </>}
      <h5>{t('events.variation')}</h5>
      <OverrideBar e={e} field="variation" edit={edit} />
      <div className="events-variation">
        {!loop && <label title={t('events.variation.pick.hint')}>{t('events.variation.pick')}
          <select value={v.pick ?? ''} disabled={!e.own.variation} onChange={ev => { const p = ev.target.value; ev.target.blur(); set({ pick: p ? p as CueVariation['pick'] : undefined }) }}>
            <option value="">{t('events.variation.pick.default')}</option>
            {PICK_MODES.map(p => <option key={p} value={p}>{t(`events.variation.pick.${p}` as MessageId)}</option>)}
          </select></label>}
        {VARIATION_FIELDS.filter(f => !loop || f.loopOk).map(f => <label key={f.key} title={t(`events.variation.${f.key}.hint` as MessageId)}>{t(`events.variation.${f.key}` as MessageId)}
          <NumberField value={typeof v[f.key] === 'number' ? v[f.key] as number : 0} min={0} max={f.max} step={f.step} disabled={!e.own.variation} label={t(`events.variation.${f.key}` as MessageId)}
            onCommit={x => set({ [f.key]: x > 0 ? Math.min(f.max, x) : undefined })} /></label>)}
      </div>
    </div>}
  </section>
}

function VariantsSection({ table, e, onSelect, edit }: { table: CueTable; e: EffectiveEvent; onSelect: (key: string) => void; edit: Edit }) {
  const { t } = useI18n()
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const ref: EventRef = e.ref
  if (ref.variant !== null) return <section className="events-sec">
    <button type="button" className="toolbar-btn" onClick={() => { edit(tb => removeVariant(tb, ref.cue, ref.variant!)); onSelect(ref.cue) }}>{t('events.variant.remove', { name: eventKey(ref) })}</button>
  </section>
  const variants = Object.keys(table.cues[ref.cue]?.variants ?? {})
  const add = () => {
    const v = name.trim()
    if (!VARIANT_NAME.test(v)) { setError(t('events.variant.badName', { pattern: VARIANT_NAME.source })); return }
    try { edit(tb => addVariant(tb, ref.cue, v)); setName(''); setError(null); onSelect(`${ref.cue}:${v}`) }
    catch (err) { setError(err instanceof Error ? err.message : String(err)) }
  }
  return <section className="events-sec">
    <h4>{t('events.variants')}</h4>
    <p className="agent-muted">{t('events.variantsHint', { cue: ref.cue })}</p>
    <div className="events-chips">{variants.map(v => <button key={v} type="button" className="agent-chip-btn" onClick={() => onSelect(`${ref.cue}:${v}`)}>{ref.cue}:{v}</button>)}</div>
    <div className="events-row-edit">
      <input value={name} placeholder={t('events.variant.namePlaceholder')} aria-label={t('events.variant.namePlaceholder')} onChange={ev => { setName(ev.target.value); setError(null) }} onKeyDown={ev => { if (ev.key === 'Enter') add() }} />
      <button type="button" className="toolbar-btn" onClick={add}>＋ {t('events.variant.add')}</button>
    </div>
    {error && <p className="events-warn">{error}</p>}
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
