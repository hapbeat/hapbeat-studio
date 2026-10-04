import { useEffect, useMemo, useState } from 'react'
import { useI18n, type MessageId } from '@/i18n/I18nProvider'
import { useSceneStore } from '@/stores/sceneStore'
import { useEventStore, type DecideTarget } from '@/stores/eventStore'
import { useAgentTrialStore } from '@/stores/agentTrialStore'
import { useWaveformStore } from '@/stores/waveformStore'
import { sceneProjectNames } from '@/utils/sceneRegistry'
import { useSceneVideoTarget } from '@/utils/editorSceneSync'
import { RATE } from '@/utils/sceneHaptics'
import { clipsForCue, isLoopCue, PICK_MODES, positionsForCue, routeClips, sfxSounds, VARIANT_NAME, type CueTable, type CueVariation, type VariationNumberKey } from '@/utils/sceneCueTable'
import type { SceneLib } from '@/utils/sceneData'
import {
  addOwnRoute, addVariant, effectiveEvent, eventKey, listEvents, parseEventKey, removeOwnRoute, removeVariant, setOverride, setOwnSfxVolume,
  setRouteClips, setSfxSounds, setVariation, trialsForEvent, updateOwnRoute, type EffectiveEvent, type EventRef, type EventRow,
} from '@/utils/cueEvents'
import { NumberField, useAtLabel } from '@/components/scene/SceneCuePanels'
import { useEditor } from './editorContext'
import { DecidedNotice } from './DecideDialog'
import { playPreview, playSamples } from './eventAudio'
import './EventsPanel.css'

const LAST_PROJECT_KEY = 'hapbeat-events-project'
const NEW_FOLDER = ' new'
const readLast = () => { try { return localStorage.getItem(LAST_PROJECT_KEY) } catch { return null } }
const writeLast = (name: string) => { try { localStorage.setItem(LAST_PROJECT_KEY, name) } catch { /* preference only */ } }

/**
 * "Events": the events (cues and their variants) of the game project open in
 * the Scene tab (same store, picked through the project registry), whether each
 * has its sound / haptic decided, and per event: its sound and haptic routes
 * (PC preview), variants and variation, the AI trials made for it, and
 * "decide" with the editor's clip. Edits here mark the table unsaved (Save /
 * Revert at the top, same as the Scene tab); "decide" writes at once.
 */
export function EventsPanel() {
  const { t } = useI18n()
  const table = useSceneStore(s => s.table)
  const lib = useSceneStore(s => s.lib)
  const dirty = useSceneStore(s => s.dirty)
  const busy = useSceneStore(s => s.busy)
  const result = useEventStore(s => s.result)
  const selected = useEventStore(s => s.selected)
  const rows = useMemo(() => table && lib ? listEvents(table, lib) : [], [table, lib])
  const select = (key: string) => {
    useEventStore.getState().select(key)
    // The Scene video panel (window or docked, never opened here) shows this event's moment.
    useSceneVideoTarget.getState().setTarget({ kind: 'event', key })
  }
  const effective = table && selected ? effectiveEvent(table, parseEventKey(selected)) : null
  return <div className="editor-panel events-panel">
    <ProjectPicker />
    {dirty && <div className="events-dirty" role="status">{t('events.unsaved')}
      <button type="button" className="toolbar-btn" disabled={busy} onClick={() => void useSceneStore.getState().save()}>{t('events.save')}</button>
      <button type="button" className="toolbar-btn" disabled={busy} onClick={() => void useSceneStore.getState().revert()}>{t('events.revert')}</button></div>}
    {result && <DecidedNotice result={result} onClose={() => useEventStore.getState().setResult(null)} />}
    {!table || !lib ? <p className="agent-muted">{t('events.noProject')}</p> : <>
      <div className="events-list" role="listbox" aria-label={t('editor.panel.events')}>
        {rows.map(r => <div key={r.key}>
          <EventRowButton row={r} selected={selected === r.key} onSelect={select} />
          {r.variants.map(v => <EventRowButton key={v.key} row={v} selected={selected === v.key} onSelect={select} nested />)}
        </div>)}
      </div>
      {effective ? <EventDetail key={selected!} table={table} lib={lib} e={effective} onSelect={select} /> : <p className="agent-muted">{t('events.selectHint')}</p>}
    </>}
  </div>
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

function EventRowButton({ row, selected, nested, onSelect }: { row: EventRow; selected: boolean; nested?: boolean; onSelect: (key: string) => void }) {
  const { t } = useI18n()
  const badge = (label: string, state: 'set' | 'unset' | 'na') => <span className={`events-badge ${state}`}>{label} {state === 'set' ? '✓' : state === 'unset' ? t('events.notYet') : '—'}</span>
  return <button type="button" role="option" aria-selected={selected} className={`events-row ${selected ? 'selected' : ''} ${nested ? 'nested' : ''}`} onClick={() => onSelect(row.key)} title={row.description ?? ''}>
    <span className="events-row-name">{nested ? `:${row.ref.variant}` : row.key}{row.loop && <small>{t('events.loop')}</small>}</span>
    <span className="events-row-badges">{badge(t('events.badge.sound'), row.sound)}{badge(t('events.badge.haptic'), row.haptic)}</span>
    {row.description && <small className="events-row-desc">{row.description}</small>}
  </button>
}

function EventDetail({ table, lib, e, onSelect }: { table: CueTable; lib: SceneLib; e: EffectiveEvent; onSelect: (key: string) => void }) {
  const { t } = useI18n()
  const { openSceneVideo } = useEditor()
  const key = eventKey(e.ref), loop = isLoopCue(lib, e.ref.cue)
  const clip = useWaveformStore(s => s.clip)
  const decide = (target: DecideTarget) => { if (clip) useEventStore.getState().requestDecide({ target, source: { kind: 'clip', clipId: clip.id }, event: key }) }
  const edit = (change: (tb: CueTable) => CueTable | null) => useSceneStore.getState().edit(change)
  return <div className="events-detail">
    <div className="events-detail-head">
      <strong>{key}</strong>
      <button type="button" className="toolbar-btn" title={t('editor.scene.openHint')} onClick={() => openSceneVideo({ kind: 'event', key }, lib.project_name)}>▶ {t('editor.scene.open')}</button>
    </div>
    {e.description && <p className="agent-muted">{e.description}</p>}
    <div className="events-assign">
      <span>{t('events.assignClip', { name: clip?.name ?? '—' })}</span>
      <button type="button" className="toolbar-btn" disabled={!clip || loop} onClick={() => decide('sound')}>{t('events.decideSound')}</button>
      <button type="button" className="toolbar-btn" disabled={!clip} onClick={() => decide('haptic')}>{t('events.decideHaptic')}</button>
    </div>
    <SoundSection lib={lib} e={e} loop={loop} edit={edit} />
    <HapticSection table={table} lib={lib} e={e} loop={loop} edit={edit} />
    <VariationSection e={e} loop={loop} edit={edit} />
    <VariantsSection table={table} e={e} onSelect={onSelect} edit={edit} />
    <TrialsSection project={lib.project_name} eventKey={key} />
  </div>
}

type Edit = (change: (tb: CueTable) => CueTable | null) => boolean

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

function SoundSection({ lib, e, loop, edit }: { lib: SceneLib; e: EffectiveEvent; loop: boolean; edit: Edit }) {
  const { t } = useI18n()
  const soundFiles = useSceneStore(s => s.soundFiles)
  const buffers = useSceneStore(s => s.sfx)
  const sounds = sfxSounds(e.sfx), editable = e.own.sfx
  return <section className="events-sec">
    <h4>{t('events.sound')}</h4>
    {loop ? <p className="agent-muted">{t('scene.sound.loopCue')}</p> : <>
      <OverrideBar e={e} field="sfx" edit={edit} />
      {!sounds.length && <p className="agent-muted">{t('events.soundNone')}</p>}
      <div className="events-chips">
        {sounds.map(s => <span key={s} className="events-chip">
          <button type="button" className="scene-icon-btn" title={t('events.playPc')} aria-label={t('events.playPc')} disabled={!buffers[s]} onClick={() => buffers[s] && playPreview(buffers[s], e.sfx?.volume ?? 1)}>▶</button>{s}
          {editable && <button type="button" className="scene-icon-btn" aria-label={t('events.remove')} title={t('events.remove')} onClick={() => edit(tb => setSfxSounds(tb, e.ref, sounds.filter(x => x !== s)))}>✕</button>}
        </span>)}
      </div>
      {editable && <div className="events-row-edit">
        <select value="" aria-label={t('events.addSound')} onChange={ev => { const v = ev.target.value; ev.target.blur(); if (v) edit(tb => setSfxSounds(tb, e.ref, [...sounds, v])) }}>
          <option value="">{t(sounds.length ? 'events.addSoundMulti' : 'events.addSound')}</option>
          {soundFiles.filter(s => !sounds.includes(s)).map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        {e.sfx && <label>{t('scene.sound.volume')} <NumberField value={e.sfx.volume} min={0} max={2} step={0.05} label={t('scene.sound.volume')} onCommit={x => edit(tb => setOwnSfxVolume(tb, e.ref, x))} /></label>}
      </div>}
      <p className="agent-muted">{t('events.soundDir', { dir: lib.paths.sounds })}</p>
    </>}
  </section>
}

function HapticSection({ table, lib, e, loop, edit }: { table: CueTable; lib: SceneLib; e: EffectiveEvent; loop: boolean; edit: Edit }) {
  const { t } = useI18n()
  const atLabel = useAtLabel()
  const pcm = useSceneStore(s => s.pcm)
  const editable = e.own.haptics
  const fitting = clipsForCue(table, lib, e.ref.cue)
  const play = (clip: string, gain: number) => { const p = pcm[clip]; if (p) playSamples(p, RATE, Math.min(1, (table.clips[clip]?.intensity ?? 1) * gain)) }
  return <section className="events-sec">
    <h4>{t('events.haptic')}</h4>
    {!loop && !e.sfx && <p className="events-hint">{t('events.soundFirst')}</p>}
    <OverrideBar e={e} field="haptics" edit={edit} />
    {!e.haptics.length && <p className="agent-muted">{t('events.hapticNone')}</p>}
    {e.haptics.map((r, i) => {
      const clips = routeClips(r)
      return <div key={i} className="events-route">
        <div className="events-chips">
          {clips.map(c => <span key={c} className="events-chip">
            <button type="button" className="scene-icon-btn" title={t('events.playPcHaptic')} aria-label={t('events.playPcHaptic')} disabled={!pcm[c]} onClick={() => play(c, r.gain)}>▶</button>{c}
            {editable && clips.length > 1 && <button type="button" className="scene-icon-btn" aria-label={t('events.remove')} title={t('events.remove')} onClick={() => edit(tb => setRouteClips(tb, e.ref, i, clips.filter(x => x !== c)))}>✕</button>}
          </span>)}
          {!editable && <span className="agent-muted">× {atLabel(r.at)} × {r.gain}</span>}
        </div>
        {editable && <div className="events-row-edit">
          <select value="" aria-label={t('events.addClip')} onChange={ev => { const v = ev.target.value; ev.target.blur(); if (v) edit(tb => setRouteClips(tb, e.ref, i, [...clips, v])) }}>
            <option value="">{t('events.addClipMulti')}</option>
            {fitting.filter(c => !clips.includes(c)).map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <select value={r.at} aria-label={t('scene.route.at')} onChange={ev => { const v = ev.target.value; ev.target.blur(); edit(tb => updateOwnRoute(tb, e.ref, i, { at: v })) }}>
            {[...new Set([...positionsForCue(lib, e.ref.cue), r.at])].map(a => <option key={a} value={a}>{atLabel(a)}</option>)}
          </select>
          <NumberField value={r.gain} min={0} max={2} step={0.05} label={t('scene.route.gain')} onCommit={x => edit(tb => updateOwnRoute(tb, e.ref, i, { gain: x }))} />
          <button type="button" className="scene-icon-btn" aria-label={t('scene.route.remove')} title={t('scene.route.remove')} onClick={() => edit(tb => removeOwnRoute(tb, e.ref, i))}>✕</button>
        </div>}
      </div>
    })}
    {editable && <button type="button" className="toolbar-btn" onClick={() => { if (!edit(tb => addOwnRoute(tb, lib, e.ref))) useSceneStore.getState().note({ id: loop ? 'scene.route.noLoopClip' : 'scene.route.noClip', error: true }) }}>＋ {t('scene.route.add')}</button>}
  </section>
}

const VARIATION_FIELDS: { key: VariationNumberKey; max: number; step: number; loopOk: boolean }[] = [
  { key: 'gainJitterDb', max: 12, step: 0.5, loopOk: true },
  { key: 'pitchJitterSt', max: 12, step: 0.5, loopOk: false },
  { key: 'rateJitterPct', max: 50, step: 1, loopOk: false },
]

/** Repetition jitter (v2 `variation`); in a loop cue only the gain jitter applies. 0 = none (the field is left out). */
function VariationSection({ e, loop, edit }: { e: EffectiveEvent; loop: boolean; edit: Edit }) {
  const { t } = useI18n()
  const v: CueVariation = e.variation ?? {}, editable = e.own.variation
  const set = (patch: Partial<CueVariation>) => edit(tb => setVariation(tb, e.ref, patch))
  return <section className="events-sec">
    <h4>{t('events.variation')}</h4>
    <OverrideBar e={e} field="variation" edit={edit} />
    <div className="events-variation">
      {VARIATION_FIELDS.filter(f => !loop || f.loopOk).map(f => <label key={f.key} title={t(`events.variation.${f.key}.hint` as MessageId)}>{t(`events.variation.${f.key}` as MessageId)}
        <NumberField value={typeof v[f.key] === 'number' ? v[f.key] as number : 0} min={0} max={f.max} step={f.step} disabled={!editable} label={t(`events.variation.${f.key}` as MessageId)}
          onCommit={x => set({ [f.key]: x > 0 ? Math.min(f.max, x) : undefined })} /></label>)}
      {!loop && <label title={t('events.variation.pick.hint')}>{t('events.variation.pick')}
        <select value={v.pick ?? ''} disabled={!editable} onChange={ev => { const p = ev.target.value; ev.target.blur(); set({ pick: p ? p as CueVariation['pick'] : undefined }) }}>
          <option value="">{t('events.variation.pick.default')}</option>
          {PICK_MODES.map(p => <option key={p} value={p}>{t(`events.variation.pick.${p}` as MessageId)}</option>)}
        </select></label>}
    </div>
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
