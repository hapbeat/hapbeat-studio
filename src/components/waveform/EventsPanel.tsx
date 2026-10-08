import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useI18n } from '@/i18n/I18nProvider'
import { useSceneStore } from '@/stores/sceneStore'
import { useEventStore, type DecideTarget } from '@/stores/eventStore'
import { useAgentTrialStore } from '@/stores/agentTrialStore'
import { useWaveformStore } from '@/stores/waveformStore'
import { useEditorSettings } from '@/stores/editorSettings'
import { lastSceneProject, sceneProjectNames } from '@/utils/sceneRegistry'
import { useSceneVideoTarget } from '@/utils/editorSceneSync'
import { clipsForCue, isLoopCue, soundAllowed, positionsForCue, routeClips, sfxSounds, type CueTable } from '@/utils/sceneCueTable'
import type { SceneLib } from '@/utils/sceneData'
import {
  addPositionRoute, assignEventsForTrial, effectiveEvent, eventKey, listEvents, parseEventKey, removeOwnRoute, shownEventKey,
  setRouteClips, setSfxSounds, trialsForEvent, updateOwnRoute, firstFirings,
  resetAllReviews, setNone, setOverride, setReview, setUndecided, hasOwnMaterials, undecidedReserves, restoreReserve, soundFirstNote, noSoundNote,
  type EffectiveEvent, type EventRow, type SoundStatus,
} from '@/utils/cueEvents'
import { useConfirm } from '@/components/common/useConfirm'
import { useAtLabel } from '@/components/scene/SceneCuePanels'
import { useEditor } from './editorContext'
import { EditorMenu, EditorMenuItem, EditorMenuSection } from './EditorMenu'
import { openEventDefault, openEventHaptic, openEventSound } from './eventAudio'
import { MaterialList } from './MaterialList'
import { PairedList } from './PairedList'
import { useToast } from '@/components/common/Toast'
import { runDecision } from './eventDecide'
import { addReserves, removeReserve, requestAnswered, reviseAnswered } from '@/utils/agentTrialUi'
import type { MaterialReserve, TrialReserve } from '@/utils/editorUiSettings'
import { create } from 'zustand'
import { openMaterialForAdjust } from './eventEditing'
import { materialTrialByIds, materialTrialSummary, materialTrialTooltip, resolveMaterialTrial, type MaterialTrial } from '@/utils/materialTrial'
import { useEventGroups } from './useEventGroups'
import { detachCue, joinGroupOf, type GroupEdits } from '@/utils/eventGroups'
import './EventsPanel.css'
import '@/components/scene/VideoOverlay.css'

const NEW_FOLDER = ' new'

/**
 * "Events": the cues of the game project open in the Scene tab (same store, picked
 * through the project registry), whether each has its sound / haptic decided, and
 * per cue: its sound and haptic material candidates (▶ / ★ representative / ×5 /
 * remove), the AI trials made for it, and "add" of the selected editor clip.
 * Variation, creating / removing variants and scene multipliers live in the Scene tab (DEC-085); a variant that writes its own
 * sfx or haptics (DEC-085 addendum, 2026-10-06) is a child row of its cue (`bite › tear`) with the same material editing.
 * Cues the recording plays at the same moment are grouped
 * (display only). Edits mark the table unsaved (Save / Revert at the top, same
 * as the Scene tab); "decide" writes at once.
 * The selected event's detail is its own dock panel (EventDetailPanel); both follow the selection in useEventStore.
 */
export function EventsPanel() {
  const { t } = useI18n()
  const table = useSceneStore(s => s.table)
  const lib = useSceneStore(s => s.lib)
  const data = useSceneStore(s => s.data)
  const saveError = useSceneStore(s => s.saveError)
  const busy = useSceneStore(s => s.busy)
  const selected = useEventStore(s => s.selected)
  const { ask, dialog } = useConfirm()
  const rows = useMemo(() => table && lib ? listEvents(table, lib) : [], [table, lib])
  // 「同時」 groups with the user's edits (per project); an audition of a member plays the others as its context.
  const groups = useEventGroups()
  const groupEdits = useEditorSettings(s => lib ? s.eventGroupEdits[lib.project_name] : undefined)
  const setGroupEdits = (next: GroupEdits | null) => {
    if (!lib) return
    const all = { ...useEditorSettings.getState().eventGroupEdits }
    if (next && (next.detached.length || next.joined.length)) all[lib.project_name] = next; else delete all[lib.project_name]
    useEditorSettings.getState().update({ eventGroupEdits: all })
  }
  const select = (key: string) => {
    useEventStore.getState().select(key)
    // The Scene video panel (window or docked, never opened here) shows this event's moment.
    useSceneVideoTarget.getState().setTarget({ kind: 'event', key })
    // The waveform panel follows: the event's haptic, else its sound.
    openEventDefault(key)
  }
  const shown = shownEventKey(table, selected)
  // A selection made elsewhere (the AI panel's event pill) scrolls its row into view.
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => { list.current?.querySelector('.events-row.selected')?.scrollIntoView({ block: 'nearest' }) }, [shown])
  const requested = useOpenRequests()
  const one = (r: EventRow) => <EventRowButton key={r.key} row={r} selected={shown === r.key} onSelect={select}
    requested={{ sound: requested.has(`${r.key}|sound`), haptic: requested.has(`${r.key}|haptic`) }} />
  // A cue and, under it, its variants that write their own materials.
  const block = (r: EventRow) => {
    const children = table ? r.variants.filter(v => hasOwnMaterials(table, v.ref)) : []
    return children.length ? <div key={r.key} className="events-family">{one(r)}{children.map(one)}</div> : one(r)
  }
  const listItems: ReactNode[] = [], done = new Set<string>()
  /** The cues of each list item (a group, or one cue), in list order: the targets of 「グループに入れる」. */
  const itemCues: string[][] = []
  for (const r of rows) {
    if (done.has(r.key)) continue
    const group = groups.find(g => g.includes(r.key))
    itemCues.push(group ?? [r.key])
    if (!group) { listItems.push(block(r)); continue }
    group.forEach(k => done.add(k))
    listItems.push(<div key={`group:${group.join('+')}`} className="events-group" title={t('events.simultaneousHint')}>
      <div className="events-group-head">{group.join(' ＋ ')}<span className="events-tag simultaneous">{t('events.simultaneous')}</span></div>
      {group.map(k => rows.find(x => x.key === k)).filter((x): x is EventRow => !!x).map(block)}
    </div>)
  }
  // Group edits act on the selected event's cue.
  const selectedCue = shown ? parseEventKey(shown).cue : null
  const selectedItem = selectedCue ? itemCues.findIndex(c => c.includes(selectedCue)) : -1
  // Each other item named with its first firing in the recording, e.g. 「grab（3.2 秒）」.
  const firsts = useMemo(() => table && data ? firstFirings(table, data.full.events) : {}, [table, data])
  const itemLabel = (cues: string[]) => {
    const times = cues.map(c => firsts[c]).filter((x): x is number => x !== undefined)
    const name = cues.join(' ＋ ')
    return times.length ? t('events.group.at', { name, sec: Math.min(...times).toFixed(1) }) : name
  }
  const inGroup = selectedItem >= 0 && itemCues[selectedItem].length > 1
  return <div className="editor-panel events-panel">
    <div className="events-top">
      <ProjectPicker />
      <GroupPlaybackToggle />
      <EditorMenu label="⋯" title={t('events.menu')}>
        <EditorMenuItem disabled={!table} onSelect={() => void ask({ message: t('events.resetReviewsConfirm'), danger: true }).then(ok => { if (ok) useSceneStore.getState().edit(tb => resetAllReviews(tb)) })}>{t('events.resetReviews')}</EditorMenuItem>
        {selectedCue ? <EditorMenuSection label={t('events.group.join', { name: selectedCue })}>
          {itemCues.filter((_, i) => i !== selectedItem).map(cues => <EditorMenuItem key={cues.join('+')} onSelect={() => setGroupEdits(joinGroupOf(groupEdits, selectedCue, cues[0]))}>
            {t('events.group.joinWith', { target: itemLabel(cues) })}</EditorMenuItem>)}
        </EditorMenuSection> : <EditorMenuItem disabled onSelect={() => {}}>{t('events.group.joinPick')}</EditorMenuItem>}
        <EditorMenuItem disabled={!selectedCue || !inGroup} onSelect={() => { if (selectedCue) setGroupEdits(detachCue(groupEdits, selectedCue)) }}>
          {t('events.group.detach', { name: selectedCue ?? '' })}</EditorMenuItem>
        <EditorMenuItem disabled={!groupEdits} onSelect={() => setGroupEdits(null)}>{t('events.group.reset')}</EditorMenuItem>
      </EditorMenu>
    </div>
    {dialog}
    {saveError && <div className="events-dirty" role="status">{t(saveError.id, saveError.params)}
      <button type="button" className="toolbar-btn" disabled={busy} onClick={() => void useSceneStore.getState().revert()}>{t('events.revert')}</button></div>}
    {!table || !lib ? <p className="agent-muted">{t('events.noProject')}</p>
      : <div ref={list} className="events-list" role="listbox" aria-label={t('editor.panel.events')}>{listItems}</div>}
  </div>
}

/** "Event detail" (its own dock panel, beside the list by default): the event selected in the Events list. */
export function EventDetailPanel() {
  const { t } = useI18n()
  const table = useSceneStore(s => s.table)
  const lib = useSceneStore(s => s.lib)
  const selected = useEventStore(s => s.selected)
  const shown = shownEventKey(table, selected)
  const effective = table && shown ? effectiveEvent(table, parseEventKey(shown)) : null
  return <div className="editor-panel events-panel">
    {!table || !lib ? <p className="agent-muted">{t('events.noProject')}</p> : <div className="events-detail-scroll">
      {effective ? <EventDetail key={shown!} table={table} lib={lib} e={effective} />
        : <p className="agent-muted">{t('events.selectHint')}</p>}
    </div>}
  </div>
}

/**
 * Project picker over the registry (game projects linked once in the Scene tab / editor). The last opened project is
 * reopened on a page load (sceneStore restore); when its folder needs a click for permission, "allow" is offered here.
 */
function ProjectPicker() {
  const { t } = useI18n()
  const { linkSceneProject } = useEditor()
  const lib = useSceneStore(s => s.lib)
  const [names, setNames] = useState<string[]>([])
  const [need, setNeed] = useState<'needsClick' | 'dirty' | null>(null)
  const current = lib?.project_name ?? ''
  useEffect(() => { void sceneProjectNames().then(setNames, () => setNames([])) }, [current])
  useEffect(() => {
    setNeed(null)
    if (current) return
    let cancelled = false
    // After the page-load restore (it opens the last project when permitted): why it is not open yet, for "allow".
    void useSceneStore.getState().restore().then(async () => {
      const last = lastSceneProject()
      if (cancelled || !last || useSceneStore.getState().lib) return
      const r = await useSceneStore.getState().linkProject(last, false)
      if (!cancelled && !r.ok && (r.reason === 'needsClick' || r.reason === 'dirty')) setNeed(r.reason)
    })
    return () => { cancelled = true }
  }, [current])
  const options = [...new Set([...names, ...(current ? [current] : [])])].sort()
  return <div className="events-project">
    <label title={t('events.project')}><span className="events-project-icon" aria-hidden="true">📁</span>
      <select value={current} aria-label={t('events.project')} onChange={e => {
        const value = e.target.value
        e.target.blur()
        if (value === NEW_FOLDER) void linkSceneProject(null)
        else if (value) void linkSceneProject(value)
      }}>
        {!current && <option value="">{t('events.pickProject')}</option>}
        {options.map(n => <option key={n} value={n}>{n}</option>)}
        <option value={NEW_FOLDER}>{t('events.addProject')}</option>
      </select></label>
    {need === 'needsClick' && <button type="button" className="toolbar-btn" onClick={() => void linkSceneProject(lastSceneProject())}>{t('editor.scene.allowButton')}</button>}
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
  const child = row.ref.variant !== null
  return <button type="button" role="option" aria-selected={selected} className={`events-row ${child ? 'variant' : ''} ${selected ? 'selected' : ''}`} onClick={() => onSelect(row.key)} title={row.description ?? ''}>
    <span className="events-row-name">{child ? `${row.ref.cue} › ${row.ref.variant}` : row.key}{row.loop && <small>{t('events.loop')}</small>}</span>
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
      <button type="button" className="toolbar-btn" title={t('editor.scene.openHint')} onClick={() => openSceneVideo({ kind: 'event', key })}>▶ {t('editor.scene.open')}</button>
    </div>
    {e.description && <p className="agent-muted">{e.description}</p>}
    <div className="events-assign">
      <span className="events-assign-clip" title={clip?.name ?? ''}>{t('events.selectedClip', { name: clip?.name ?? '—' })}</span>
      <button type="button" className="toolbar-btn" disabled={!clip || !soundAllowed(lib, e.ref.cue)} title={t('events.addHint')} onClick={() => assign('sound')}>{t('events.assignSound')}</button>
      <button type="button" className="toolbar-btn" disabled={!clip} title={t('events.addHint')} onClick={() => assign('haptic')}>{t('events.assignHaptic')}</button>
    </div>
    <MaterialOrigin cue={e.ref.cue} />
    <SoundSection lib={lib} e={e} loop={loop} edit={edit} />
    <HapticSection table={table} lib={lib} e={e} loop={loop} edit={edit} />
    {e.ref.variant === null && variants.length > 0 && <p className="agent-muted" title={t('events.variantsInSceneHint')}>
      <button type="button" className="agent-link" onClick={() => useEventStore.getState().openInScene(key)}>{t('events.variantsInScene', { count: variants.length })}</button></p>}
    <TrialsSection project={lib.project_name} eventKey={key} />
  </div>
}

/** The event's sound candidates (`sfx.sounds`; ★ = representative): a row click shows one in the waveform panel, ▶ plays it (PC only). */
function SoundSection({ lib, e, loop, edit }: { lib: SceneLib; e: EffectiveEvent; loop: boolean; edit: Edit }) {
  const { t } = useI18n()
  const allowed = soundAllowed(lib, e.ref.cue)
  const soundFiles = useSceneStore(s => s.soundFiles)
  const previewId = useEventStore(s => s.preview?.id)
  const key = eventKey(e.ref), sounds = sfxSounds(e.sfx)
  const missing = (name: string) => useWaveformStore.getState().setError(t('events.preview.missing', { name }))
  const play = (s: string) => { if (!openEventSound(key, s, true)) missing(s) }
  const show = (s: string) => { if (!openEventSound(key, s)) missing(s) }
  const set = (list: string[]) => edit(tb => setSfxSounds(tb, e.ref, list))
  const describe = useDescribeMaterial()
  // An approved sound is folded (its heading line stays); ▸ opens it.
  const [open, setOpen] = useState(e.review.sfx !== 'approved')
  return <section className="events-sec">
    <h4 className="events-sec-head"><Fold open={open} set={setOpen} />{t('events.sound')}{allowed && e.own.sfx && <><ReviewToggle e={e} field="sfx" edit={edit} /><DecisionBar e={e} field="sfx" edit={edit} /></>}
      {/* Ask for (more) sound candidates; after checking the sound (OK): on to the haptic — also for a cue without a sound. */}
      <span className="events-haptic-request"><button type="button" className="agent-icon-btn" title={t('events.soundRequest.hint')}
        onClick={() => { const k = `sound|${key}`; useReviseOpen.getState().set(useReviseOpen.getState().open === k ? null : k) }}>{t('events.soundRequest.button')}</button>
      <HapticRequestButton e={e} /></span></h4>
    <SoundRequestField cue={key} />
    {!open ? null : !allowed ? <p className="agent-muted">{t('scene.sound.loopCue')}</p> : !e.own.sfx ? <Inherited e={e} field="sfx" edit={edit} /> : <>
      {loop && <p className="agent-muted">{t('events.loopSoundHint')}</p>}
      {!sounds.length && <p className="agent-muted">{t(noSoundNote(e))}</p>}
      {/* A paired cue's sounds are listed as pairs in the haptic section. */}
      {e.variation?.paired === true ? sounds.length > 0 && <p className="agent-muted">{t('events.pair.inHaptics')}</p> : <MaterialList items={sounds} label={t('events.sound')} active={sounds.find(s => previewId === `${key}|sound|${s}`) ?? null} onPlay={play} onSelect={show}
        onReorder={set} onRemove={set}
        extra={s => <MaterialActions event={key} target="sound" wav={s} />}
        below={s => <ReviseField cue={key} target="sound" material={s} />} describe={describe} />}
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
  // An approved haptic is folded (its heading line stays); ▸ opens it.
  const [hOpen, setHOpen] = useState(e.review.haptics !== 'approved')
  const atLabel = useAtLabel()
  const previewId = useEventStore(s => s.preview?.id)
  const key = eventKey(e.ref)
  const fitting = clipsForCue(table, lib, e.ref.cue)
  const missing = (name: string) => useWaveformStore.getState().setError(t('events.preview.missing', { name }))
  const free = positionsForCue(lib, e.ref.cue).some(a => !e.haptics.some(r => r.at === a))
  const describe = useDescribeMaterial()
  return <section className="events-sec">
    <h4 className="events-sec-head"><Fold open={hOpen} set={setHOpen} />{t('events.haptic')}{e.own.haptics && <><ReviewToggle e={e} field="haptics" edit={edit} /><DecisionBar e={e} field="haptics" edit={edit} /></>}</h4>
    {hOpen && !e.own.haptics && <Inherited e={e} field="haptics" edit={edit} />}
    {hOpen && e.own.haptics && <>
    <SoundFirstNote note={soundFirstNote(e, loop)} />
    {!e.haptics.length && <p className="agent-muted">{t(e.decided.haptics ? 'events.hapticNone' : 'events.undecidedHaptic')}</p>}
    {e.haptics.map((r, i) => {
      const clips = routeClips(r), set = (list: string[]) => edit(tb => setRouteClips(tb, e.ref, i, list))
      return <div key={i} className="events-route" title={t('events.hapticRowsHint')}>
        <div className="events-route-head">
          <select value={r.at} aria-label={t('scene.route.at')} onChange={ev => { const v = ev.target.value; ev.target.blur(); edit(tb => updateOwnRoute(tb, e.ref, i, { at: v })) }}>
            {[...new Set([...positionsForCue(lib, e.ref.cue), r.at])].map(a => <option key={a} value={a}>{atLabel(a)}</option>)}
          </select>
          <select className="events-add-material" value="" aria-label={t('events.addClipMulti')} onChange={ev => { const x = ev.target.value; ev.target.blur(); if (x) set([...clips, x]) }}>
            <option value="">{t('events.addClipMulti')}</option>
            {fitting.filter(c => !clips.includes(c)).map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <button type="button" className="scene-icon-btn" aria-label={t('scene.route.remove')} title={t('scene.route.remove')} onClick={() => edit(tb => removeOwnRoute(tb, e.ref, i))}>✕</button>
        </div>
        {e.variation?.paired === true && i === 0 ? <PairedList e={e} edit={edit}
          active={previewId ? previewId.split('|')[2] ?? null : null}
          onPlay={(_, sound, clip, at) => { if (clip && at) { if (!openEventHaptic(key, clip, at, true)) missing(clip) } else if (sound && !openEventSound(key, sound, true)) missing(sound) }}
          onShow={(target, name, at) => { if (target === 'haptic' ? !openEventHaptic(key, name, at ?? r.at) : !openEventSound(key, name)) missing(name) }}
          extra={(target, name) => <MaterialActions event={key} target={target} wav={name} />} describe={describe} />
        : <MaterialList items={clips} label={t('scene.route.clip')} active={clips.find(c => previewId === `${key}|haptic|${c}|${r.at}`) ?? null}
          onPlay={c => { if (!openEventHaptic(key, c, r.at, true)) missing(c) }} onSelect={c => { if (!openEventHaptic(key, c, r.at)) missing(c) }} onReorder={set} onRemove={set} minItems={1}
          extra={c => <MaterialActions event={key} target="haptic" wav={c} />}
          below={c => <ReviseField cue={key} target="haptic" material={c} />} describe={describe} />}
      </div>
    })}
    <Reserves cue={e.ref.cue} target="haptic" />
    <button type="button" className="toolbar-btn events-add" disabled={!free} title={t('events.addPositionHint')}
      onClick={() => { if (!edit(tb => addPositionRoute(tb, lib, e.ref))) useWaveformStore.getState().setError(t(loop ? 'scene.route.noLoopClip' : 'scene.route.noClip')) }}>＋ {t('events.addPosition')}</button>
    </>}
  </section>
}

/** Before deciding a haptic: a warning while the event's sound is undecided, a neutral note when it is decided as none (see soundFirstNote). */
export function SoundFirstNote({ note }: { note: ReturnType<typeof soundFirstNote> }) {
  const { t } = useI18n()
  return note && <p className={`events-hint ${note === 'events.soundNoneDecided' ? 'decided' : ''}`}>{t(note)}</p>
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

/** "Adjust": the material opens in the waveform panel with the effects panel; changes go straight back to the event's WAV. */
function AdjustButton({ event, target, wav }: { event: string; target: DecideTarget; wav: string }) {
  const { t } = useI18n()
  const { focusEditorPanel } = useEditor()
  const [busy, setBusy] = useState(false)
  const open = async () => {
    setBusy(true)
    try { await openMaterialForAdjust(event, target, wav); focusEditorPanel('effects') }
    catch (error) { useWaveformStore.getState().setError(error) }
    finally { setBusy(false) }
  }
  return <button type="button" className="agent-icon-btn events-edit-clip" disabled={busy} title={t('events.adjustHint')} onClick={() => void open()}>{t('events.adjust')}</button>
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
 * Decided vs undecided: "None" (sfx: null / haptics: []) and, on a cue, "Back to undecided" (the key removed; its
 * materials move to the event's reserves, representative first, so nothing is lost).
 * A variant goes back to inheriting with the override bar instead.
 */
function DecisionBar({ e, field, edit }: { e: EffectiveEvent; field: 'sfx' | 'haptics'; edit: Edit }) {
  const { t } = useI18n()
  const isNone = e.decided[field] && (field === 'sfx' ? !e.sfx : e.haptics.length === 0)
  const toUndecided = () => {
    const table = useSceneStore.getState().table
    const moved = table ? undecidedReserves(table, e.ref.cue, field) : []
    if (!edit(tb => setUndecided(tb, e.ref.cue, field)) || !moved.length) return
    const settings = useEditorSettings.getState()
    settings.update({ eventReserves: addReserves(settings.eventReserves, e.ref.cue, moved) })
  }
  // Fixed slots on the section's head line: a button that does not apply is hidden, not removed (nothing moves).
  return <span className="events-decision">
    <button type="button" className="agent-icon-btn" style={{ visibility: isNone ? 'hidden' : 'visible' }} title={t(field === 'sfx' ? 'events.setNoneSoundHint' : 'events.setNoneHapticHint')} onClick={() => edit(tb => setNone(tb, e.ref, field))}>{t('events.setNone')}</button>
    {/* A cue: back to undecided; a variant (child row): back to its cue's (the override removed). */}
    {e.ref.variant === null
      ? <button type="button" className="agent-icon-btn" style={{ visibility: e.decided[field] ? 'visible' : 'hidden' }} title={t('events.setUndecidedHint')} onClick={toUndecided}>{t('events.setUndecided')}</button>
      : <button type="button" className="agent-icon-btn" title={t('events.backToParentHint', { parent: e.ref.cue })} onClick={() => edit(tb => setOverride(tb, e.ref, field, false))}>{t('events.backToParent', { parent: e.ref.cue })}</button>}
  </span>
}

type T = ReturnType<typeof useI18n>['t']
/** Tooltip lines of an AI-made material (label, hypothesis, the trial's rationale and prompt, 「AI 提案 T90・候補 B」). */
const originTooltip = (t: T, m: MaterialTrial) => materialTrialTooltip(m, t('events.mat.aiOrigin', { short: m.shortId, candidate: m.candidate.id }))

/** Tooltip lines for a material name written from an AI candidate (`<cue>_T90_B`), null for any other material. */
function useDescribeMaterial(): (name: string) => string | null {
  const { t } = useI18n()
  const trials = useAgentTrialStore(s => s.trials)
  return (name: string) => { const m = resolveMaterialTrial(name, trials); return m ? originTooltip(t, m) : null }
}

/**
 * Fixed-height line under the event head: the label and hypothesis of the AI candidate behind the material shown
 * in the waveform panel (an event material or reserve of this cue, or an AI reserve being auditioned); empty otherwise.
 * Always rendered so nothing below moves.
 */
function MaterialOrigin({ cue }: { cue: string }) {
  const { t } = useI18n()
  const trials = useAgentTrialStore(s => s.trials)
  const audition = useAgentTrialStore(s => s.audition)
  const preview = useEventStore(s => s.preview)
  const reserves = useEditorSettings(s => s.eventReserves)
  const origin = useMemo(() => {
    if (audition) {
      const reserved = Object.entries(reserves).some(([key, refs]) => parseEventKey(key).cue === cue && refs.some(r => !('material' in r) && r.trialId === audition.trialId && r.candidateId === audition.candidateId))
      return reserved ? materialTrialByIds(audition.trialId, audition.candidateId, trials) : null
    }
    return preview && parseEventKey(preview.event).cue === cue ? resolveMaterialTrial(preview.material, trials) : null
  }, [audition, preview, reserves, trials, cue])
  return <p className="events-mat-origin" aria-live="polite" title={origin ? originTooltip(t, origin) : ''}>
    {origin && <><span className="events-mat-origin-id">{t('events.mat.aiOrigin', { short: origin.shortId, candidate: origin.candidate.id })}</span> {materialTrialSummary(origin)}</>}
  </p>
}

/**
 * The event's reserves (editor settings): faint rows under the materials. ★3 AI candidates kept aside: ▶ auditions
 * the candidate as rendered; "Adopt" does what "→ Event" does (writes the WAV, adds it to the end of the pool,
 * tentative) and drops it from the reserves. Materials taken off by "back to undecided": ▶ plays the event's WAV;
 * "Put back" adds it to the end of the pool (tentative; the first back is the representative) and drops it from the
 * reserves. "Remove" only drops a reserve.
 */
function Reserves({ cue, target }: { cue: string; target: 'sound' | 'haptic' }) {
  const { t } = useI18n()
  const all = useEditorSettings(s => s.eventReserves)
  const shownOpen = useEditorSettings(s => s.reservesOpen)
  const shownAudition = useAgentTrialStore(s => s.audition ? `${s.audition.trialId}/${s.audition.candidateId}` : null)
  const trials = useAgentTrialStore(s => s.trials)
  const [busy, setBusy] = useState(false)
  const atLabel = useAtLabel()
  const previewId = useEventStore(s => s.preview?.id)
  const describe = useDescribeMaterial()
  const entries = Object.entries(all).filter(([key]) => parseEventKey(key).cue === cue).flatMap(([key, refs]) => refs.filter(r => r.target === target).map(r => ({ key, r })))
  const rows = entries.flatMap(({ key, r }) => 'material' in r ? [] : [{ key, ...r }])
  const materials = entries.flatMap(({ key, r }) => 'material' in r ? [{ key, r }] : [])
  if (!entries.length) return null
  const drop = (key: string, r: TrialReserve | MaterialReserve) => useEditorSettings.getState().update({ eventReserves: removeReserve(useEditorSettings.getState().eventReserves, key, r) })
  const missing = (name: string) => useWaveformStore.getState().setError(t('events.preview.missing', { name }))
  const open = (key: string, r: MaterialReserve, autoplay: boolean) => {
    const ok = r.target === 'sound' ? openEventSound(key, r.material, autoplay) : openEventHaptic(key, r.material, r.at ?? '', autoplay)
    if (!ok) missing(r.material)
  }
  const putBack = (key: string, r: MaterialReserve) => { if (useSceneStore.getState().edit(tb => restoreReserve(tb, parseEventKey(key).cue, r))) drop(key, r) }
  const adopt = async (row: typeof rows[number]) => {
    const scene = useSceneStore.getState()
    if (!scene.table || !scene.lib) { useWaveformStore.getState().setError(t('scene.save.noProject')); return }
    const events = assignEventsForTrial(scene.table, scene.lib, [row.key], target)
    if (!events.length) { useWaveformStore.getState().setError(t('events.auto.noEvents', { cues: row.key })); return }
    setBusy(true)
    try {
      const r = await runDecision({ target, source: { kind: 'candidate', trialId: row.trialId, candidateId: row.candidateId }, events, name: null, at: null })
      if (r.ok) drop(row.key, row); else useWaveformStore.getState().setError(t(r.notice.id, r.notice.params))
    } catch (error) { useWaveformStore.getState().setError(error) }
    finally { setBusy(false) }
  }
  const show = (row: typeof rows[number]) => void useAgentTrialStore.getState().requestAudition(row.trialId, row.candidateId, false, false).catch(error => useWaveformStore.getState().setError(error))
  return <>
    <button type="button" className="events-reserves-toggle" aria-expanded={shownOpen} title={t('events.reservesHint')}
      onClick={() => useEditorSettings.getState().update({ reservesOpen: !shownOpen })}>{shownOpen ? '▾' : '▸'} {t('events.reservesCount', { count: entries.length })}</button>
    {shownOpen && <ul className="events-reserves" aria-label={t('events.reserves')} title={t('events.reservesHint')}>
    {materials.map(({ key, r }) => {
      const name = r.target === 'haptic' && r.at ? `${r.material} · ${atLabel(r.at)}` : r.material
      const id = r.target === 'sound' ? `${key}|sound|${r.material}` : `${key}|haptic|${r.material}|${r.at ?? ''}`
      return <li key={`${key}/material/${r.target}/${r.material}/${r.at ?? ''}`} className={`events-mat events-reserve selectable ${previewId === id ? 'active' : ''}`}
        onClick={e => { if (!(e.target as HTMLElement).closest('button')) open(key, r, false) }}>
        <button type="button" className="agent-icon-btn" aria-label={t('events.mat.play', { name })} title={t('events.mat.play', { name })} onClick={() => open(key, r, true)}>▶</button>
        <span className="events-mat-name" title={[name, describe(r.material)].filter(Boolean).join('\n')}>{name}</span>
        <span />
        <button type="button" className="agent-icon-btn" title={t('events.reservePutBackHint')} onClick={() => putBack(key, r)}>{t('events.reservePutBack')}</button>
        <button type="button" className="agent-icon-btn" title={t('events.reserveRemoveMaterialHint')} onClick={() => drop(key, r)}>{t('events.mat.remove')}</button>
      </li>
    })}
    {rows.map(row => {
      const record = trials.find(r => r.trial.id === row.trialId)
      const name = `${record?.shortId ? `${record.shortId}-` : ''}${row.candidateId} ${record?.trial.candidates.find(c => c.id === row.candidateId)?.label ?? row.trialId}`
      const origin = materialTrialByIds(row.trialId, row.candidateId, trials)
      // A click on the row (not its buttons) shows it in the waveform panel without playing; ▶ plays.
      return <li key={`${row.key}/${row.trialId}/${row.candidateId}`} className={`events-mat events-reserve selectable ${shownAudition === `${row.trialId}/${row.candidateId}` ? 'active' : ''}`}
        onClick={e => { if (record && !(e.target as HTMLElement).closest('button')) show(row) }}>
        <button type="button" className="agent-icon-btn" disabled={!record} aria-label={t('events.mat.play', { name })} title={t('events.mat.play', { name })}
          onClick={() => void useAgentTrialStore.getState().requestAudition(row.trialId, row.candidateId, true, false).catch(error => useWaveformStore.getState().setError(error))}>▶</button>
        <span className="events-mat-name" title={[`${name}${row.key !== cue ? ` (${row.key})` : ''}`, origin ? originTooltip(t, origin) : ''].filter(Boolean).join('\n')}>{name}{row.key !== cue ? ` · ${row.key}` : ''}</span>
        <span />
        <button type="button" className="agent-icon-btn" disabled={busy || !record} title={t('events.reserveAdoptHint')} onClick={() => void adopt(row)}>{t('events.reserveAdopt')}</button>
        <button type="button" className="agent-icon-btn" title={t('events.reserveRemoveHint')} onClick={() => drop(row.key, row)}>{t('events.mat.remove')}</button>
      </li>
    })}
  </ul>}
  </>
}

/** Which material's remake comment field is open (one at a time). */
const useReviseOpen = create<{ open: string | null; set: (open: string | null) => void }>(set => ({ open: null, set: open => set({ open }) }))
const reviseKey = (cue: string, target: string, material: string) => `${cue}|${target}|${material}`

/** "Adjust" and "Remake" (opens the one-line comment under the row) of one material row. */
function MaterialActions({ event, target, wav }: { event: string; target: DecideTarget; wav: string }) {
  const { t } = useI18n()
  return <span className="events-mat-actions">
    <AdjustButton event={event} target={target} wav={wav} />
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

/** The one-line remake comment under a material row (outbox `revise`). */
function ReviseField({ cue, target, material }: { cue: string; target: 'sound' | 'haptic'; material: string }) {
  const { t } = useI18n()
  return <RequestField fieldKey={reviseKey(cue, target, material)} placeholder={t('events.revise.placeholder')} hint={t('events.revise.hint')}
    send={async comment => {
      const project = useSceneStore.getState().lib?.project_name
      await useAgentTrialStore.getState().sendAgentMessage({ text: t('events.revise.message', { cue, material, comment }), project, revise: { cue, target, material, comment } })
      const settings = useEditorSettings.getState()
      settings.update({ revisePending: [...settings.revisePending, { cue, target, material, at: new Date().toISOString() }] })
    }} />
}

/** Unsent request comments by field (kept when a field is closed, back when it opens again). */
const DRAFTS_KEY = 'hapbeat-request-drafts'
const readDrafts = (): Record<string, string> => { try { return JSON.parse(localStorage.getItem(DRAFTS_KEY) ?? '{}') as Record<string, string> } catch { return {} } }
const writeDraft = (key: string, text: string) => {
  const drafts = readDrafts()
  if (text) drafts[key] = text; else delete drafts[key]
  try { localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts)) } catch { /* a draft only */ }
}

/**
 * A one-line request to the agent with a fixed-width "Request" button (Enter does the same, Esc closes).
 * Sending closes it (the list badge turns "requested"); closing keeps what was typed as a draft.
 * Only a failure is announced (toast).
 */
function RequestField({ fieldKey, placeholder, hint, send }: { fieldKey: string; placeholder: string; hint: string; send: (comment: string) => Promise<void> }) {
  const { t } = useI18n()
  const { toast } = useToast()
  const open = useReviseOpen(s => s.open === fieldKey)
  const [comment, setComment] = useState(() => readDrafts()[fieldKey] ?? '')
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (open) setComment(readDrafts()[fieldKey] ?? '') }, [open, fieldKey])
  if (!open) return null
  const close = () => useReviseOpen.getState().set(null)
  const submit = async () => {
    const text = comment.trim()
    if (!text || busy) return
    setBusy(true)
    try { await send(text); writeDraft(fieldKey, ''); setComment(''); close() }
    catch (err) { toast(t('events.revise.failed', { error: err instanceof Error ? err.message : String(err) }), 'error') }
    finally { setBusy(false) }
  }
  return <div className="events-revise">
    <input autoFocus value={comment} disabled={busy} placeholder={placeholder} aria-label={placeholder} title={hint}
      onChange={e => { setComment(e.target.value); writeDraft(fieldKey, e.target.value) }}
      onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); void submit() } else if (e.key === 'Escape') { e.preventDefault(); close() } }} />
    <button type="button" className="agent-icon-btn events-request-send" disabled={busy || !comment.trim()} onClick={() => void submit()}>{t('events.request.send')}</button>
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
  const { toast } = useToast()
  const sound = sfxSounds(e.sfx)[0] ?? null
  const send = async () => {
    try {
      const project = useSceneStore.getState().lib?.project_name
      await useAgentTrialStore.getState().sendAgentMessage({ text: t('events.hapticRequest.message', { cue, sound: sound ?? t('events.hapticRequest.noSound') }), project, haptic: { cue, sound } })
      const settings = useEditorSettings.getState()
      settings.update({ hapticPending: [...settings.hapticPending, { cue, at: new Date().toISOString() }] })
    } catch (err) { toast(t('events.revise.failed', { error: err instanceof Error ? err.message : String(err) }), 'error') }
  }
  const title = [t('events.hapticRequest.hint'), ...(e.decided.sfx ? [] : [t('events.hapticRequest.soundUndecided')])].join('\n')
  return <button type="button" className="agent-icon-btn" title={title} onClick={() => void send()}>{t('events.hapticRequest.button')}</button>
}

/** The one-line sound request under the sound heading (outbox `sound`). */
function SoundRequestField({ cue }: { cue: string }) {
  const { t } = useI18n()
  return <RequestField fieldKey={`sound|${cue}`} placeholder={t('events.soundRequest.placeholder')} hint={t('events.soundRequest.hint')}
    send={async comment => {
      const project = useSceneStore.getState().lib?.project_name
      await useAgentTrialStore.getState().sendAgentMessage({ text: t('events.soundRequest.message', { cue, comment }), project, sound: { cue, comment } })
      const settings = useEditorSettings.getState()
      settings.update({ soundPending: [...settings.soundPending, { cue, at: new Date().toISOString() }] })
    }} />
}

/**
 * A child row's field it inherits (DEC-085 addendum): "same as <cue>" and one button that gives this situation its own
 * copy (an override to edit here). Variation and the variants themselves stay in the Scene tab.
 */
function Inherited({ e, field, edit }: { e: EffectiveEvent; field: 'sfx' | 'haptics'; edit: Edit }) {
  const { t } = useI18n()
  return <p className="events-inherited">
    <span>{t('events.inherited', { parent: e.ref.cue })}</span>
    <button type="button" className="agent-icon-btn" title={t('events.overrideHereHint', { parent: e.ref.cue })} onClick={() => edit(tb => setOverride(tb, e.ref, field, true))}>{t('events.overrideHere')}</button>
  </p>
}

/** "Play the group" / "This row only" (editor setting, default the group): what an audition plays at the stretch. Fixed width. */
function GroupPlaybackToggle() {
  const { t } = useI18n()
  const on = useEditorSettings(s => s.groupPlayback)
  return <button type="button" className="agent-save-toggle events-group-toggle" aria-pressed={on} aria-label={t(on ? 'events.groupPlayback.group' : 'events.groupPlayback.row')} title={t('events.groupPlayback.hint')}
    onClick={() => useEditorSettings.getState().update({ groupPlayback: !on })}>
    <span className="transport-label-stack" aria-hidden="true"><span style={{ visibility: on ? 'visible' : 'hidden' }}>{t('events.groupPlayback.group')}</span><span style={{ visibility: on ? 'hidden' : 'visible' }}>{t('events.groupPlayback.row')}</span></span>
  </button>
}

/** ▸ / ▾ in a section heading. */
function Fold({ open, set }: { open: boolean; set: (open: boolean) => void }) {
  const { t } = useI18n()
  return <button type="button" className="events-fold" aria-expanded={open} title={t(open ? 'events.fold.close' : 'events.fold.open')} onClick={() => set(!open)}>{open ? '▾' : '▸'}</button>
}
