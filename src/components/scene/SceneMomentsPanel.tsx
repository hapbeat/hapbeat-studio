import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useI18n } from '@/i18n/I18nProvider'
import { useSceneStore } from '@/stores/sceneStore'
import { useSceneSettings } from '@/stores/sceneSettings'
import { useAgentTrialStore } from '@/stores/agentTrialStore'
import { useWaveformStore } from '@/stores/waveformStore'
import { clockText, familyColor, isTick } from '@/utils/sceneData'
import { addVariant, allEventKeys, effectiveEvent, parseEventKey, resolveEventName } from '@/utils/cueEvents'
import { VARIANT_NAME, type CueTable } from '@/utils/sceneCueTable'
import { HapticIcon, SoundIcon } from '@/components/common/KindIcon'
import { useMomentPlace } from './SceneCuePanels'
import { useScene } from './sceneContext'
import { removeOverride, setOverride as setSceneOverride, type OverriddenEvent } from '@/utils/sceneOverrides'
import { saveSceneOverrides } from '@/hooks/useSceneOverrides'
import { localIsoString } from '@/utils/hapticKnowledge'
import { MenuPopup } from '@/components/waveform/EditorMenu'
import { loopCueRunAt, loopCueRuns } from '@/utils/loopStretch'
import { useSceneStrength } from '@/stores/sceneStrength'
import { useSceneTimelineRange } from '@/stores/sceneTimelineRange'
import { firingNumber, firingRows, numberRangeText, shownIndexOf, type FiringRow } from '@/utils/sceneTimelineEdit'
import { firingStrength } from '@/utils/sceneFiringGain'

/**
 * "Moments and events" (DEC-112, scene-recording §3.4): the project's chapters first (when it has any: a click plays
 * that stretch, SceneRuntime.playChapter; keys 1–9), then the full replay, then one row per recorded firing — the
 * timeline's bars one to one, with the same numbers (firingRows: time order, edits applied; emitted firings are not
 * listed). The firings of one moment (within MOMENT_S) are consecutive rows joined by a group mark on the left. A click
 * on a row plays its moment (from the lead-in setting before its mark; a loop cue: the layer's active run that firing
 * starts, loopCueRunAt, from the lead-in before it to the lead-in after it, SceneRuntime.playSpan) and selects that
 * firing (the picked cue; a haptic one-shot also as the firing selection). "Change" opens a one-line request over the
 * rows (nothing moves): an existing event or a new `cue:variant`, a comment, "Request" — a new variant is made in the
 * cue table at once (multipliers only, 1 / 1) so it can be tuned here, and the agent gets a hapbeat-agent-message@1
 * `reassign` for that firing (the game's routing changes; the table holds no per-firing values).
 * The list follows the timeline (sceneTimelineRange): the rows it draws are bracketed by a purple line on the left and
 * named by a sticky line (「タイムライン: 04–08」, from the same numbers); the rows inside what repeats are tinted; rows of
 * selected firings are marked (chosen; the first is scrolled to when the selection changes); the picked firing's row
 * is the selected row (scrolled to).
 */
export function SceneMomentsPanel() {
  const { t } = useI18n()
  const { runtime } = useScene()
  const placeOf = useMomentPlace()
  const lib = useSceneStore(s => s.lib)
  const items = useSceneStore(s => s.items)
  const table = useSceneStore(s => s.table)
  const cur = useSceneStore(s => s.cur)
  const list = useRef<HTMLDivElement>(null)
  /** The row (its shown firing index) whose Change form is open; the rows whose request was sent (by recorded time and name). */
  const [open, setOpen] = useState<number | null>(null)
  const [sent, setSent] = useState<Record<string, true>>({})
  /** The row whose right-click menu ("Undo" of a changed firing) is open, and where (the pointer). */
  const [menu, setMenu] = useState<{ k: number; x: number; y: number } | null>(null)
  const sel = useSceneStore(s => s.sel)
  const data = useSceneStore(s => s.data)
  const span = useSceneStore(s => s.span)
  const chapter = useSceneStore(s => s.chapter)
  const edited = useSceneStore(s => s.edited)
  const recorded = useSceneStore(s => s.recorded)
  const selected = useSceneStrength(s => s.selected)
  const inView = useSceneTimelineRange(s => s.rows)
  const repeat = useSceneTimelineRange(s => s.repeat)
  const rows = useMemo(() => data && lib ? firingRows(items, data.full.events, lib.ticks) : [], [items, data, lib])
  /** Each shown firing's recorded index (viewer-data events[i]); emitted firings have none. */
  const recordedOf = useMemo(() => new Map(data && edited ? [...shownIndexOf(data.full.events, edited.full.events)].map(([i, k]) => [k, i]) : []), [data, edited])
  /** A shown firing's RECORDED time (viewer-data.json): an override and the Change request name a firing by it, also after its time was edited. */
  const atOf = (k: number) => { const i = recordedOf.get(k), r = i === undefined ? undefined : recorded?.full.events[i]; return r?.t ?? data?.full.events[k]?.t ?? 0 }
  const fromOf = (ev: OverriddenEvent) => ev.from ?? ev.name
  /** Each loop cue's active runs over the recording (once per recording). */
  const runsOf = useMemo(() => new Map(data && lib ? lib.loop_cues.map(c => [c, loopCueRuns(data.full.levels, data.fps, lib, c)]) : []), [data, lib])
  /** The span the row of firing `k` plays: its loop cue's run started by that firing (null for one-shot cues). */
  const rowSpan = (k: number) => {
    const ev = data?.full.events[k], runs = ev && runsOf.get(ev.name.split(':')[0])
    return ev && data && runs?.length ? loopCueRunAt(runs, data.full.events, ev.name, ev.t) : null
  }
  /** A row: a loop cue plays its own span, a one-shot cue its moment; that firing is the picked cue and (a haptic one-shot) the firing selection. */
  const pickRow = (row: FiringRow) => {
    const ev = data?.full.events[row.index]
    if (!ev || !data) return
    const run = rowSpan(row.index), lead = useSceneSettings.getState().leadSec
    runtime.audio()
    if (run) runtime.playSpan(run, lead, lead)
    else if (row.moment !== null) runtime.playMoment(row.moment, lead)
    else runtime.playFull(Math.max(0, ev.t - lead))
    useSceneStore.getState().selectCue(ev.name, ev.t)
    const i = recordedOf.get(row.index), oneShot = !!table && !isTick(lib?.ticks ?? [], ev.name) && !!firingStrength(table, data.full.events, ev)
    useSceneStrength.getState().select(i !== undefined && oneShot ? [i] : [], 'replace')
  }
  /** The picked firing's row (shown index), else -1. */
  const picked = useMemo(() => !sel || sel.t == null || !data ? -1 : data.full.events.findIndex(e => e.name === sel.name && Math.abs(e.t - sel.t!) < 0.02), [sel, data])
  const chosen = useMemo(() => new Set([...recordedOf].flatMap(([k, i]) => selected.has(i) ? [k] : [])), [recordedOf, selected])
  // The picked firing's row (a bar clicked, a row clicked), else the full replay's row when it is shown.
  useEffect(() => { const root = list.current; root?.querySelector('.scene-item.sel')?.scrollIntoView({ block: 'nearest' }) }, [cur, picked])
  // Another firing selection (the timeline): its first row in view.
  useEffect(() => { list.current?.querySelector('.scene-item.chosen')?.scrollIntoView({ block: 'nearest' }) }, [selected])
  if (!lib) return <div className="scene-panel-empty">{t('scene.noProject')}</div>
  const chapters = data?.chapters ?? []
  const full = items.findIndex(it => it.kind === 'full')
  const inRepeat = (time: number) => !!repeat && time >= repeat[0] && time <= repeat[1]
  return <div className="scene-moments">
    {chapters.length > 0 && <div className="scene-chapters">
      <div className="scene-chapters-head">{t('scene.chapters.heading')}</div>
      {chapters.map((c, i) => <div key={i} className={`scene-item scene-chapter ${i === chapter ? 'sel' : ''}`} title={t('scene.chapters.hint')}
        onClick={() => { runtime.audio(); runtime.playChapter(i) }}>
        <span className="scene-num">{i < 9 ? i + 1 : ''}</span>
        <span className="scene-name">{c.label}</span>
        <span className="scene-num">{clockText(c.start)}–{clockText(c.end)}</span>
      </div>)}
    </div>}
    <div className="scene-legend">
      {lib.families.map(f => <span key={f.label}><i style={{ background: f.color }} />{f.label}</span>)}
      <span className="scene-legend-kind"><HapticIcon size={14} decorative /> {t('scene.legend.haptics')}</span>
      <span className="scene-legend-kind"><SoundIcon size={14} decorative /> {t('scene.legend.sound')}</span>
    </div>
    <div className="scene-moments-inview" title={t('scene.moments.inViewHint')}>{t('scene.moments.inView', { range: numberRangeText(inView) || '—' })}</div>
    <div ref={list}>
      {full >= 0 && <div className={`scene-item ${cur === full && !span && picked < 0 ? 'sel' : ''}`} title={t('scene.moment.playHint')}
        onClick={() => { runtime.audio(); runtime.playMoment(full, useSceneSettings.getState().leadSec) }}>
        <span className="scene-num">▶</span>
        <span className="scene-dot" />
        <span className="scene-name">{t('scene.full')}</span>
      </div>}
      {data && rows.map(row => {
        const k = row.index, ev = data.full.events[k] as OverriddenEvent, from = fromOf(ev), sentKey = `${from}@${atOf(k)}`
        const view = !!inView && row.num >= inView[0] && row.num <= inView[1]
        const cls = ['scene-item', k === picked ? 'sel' : '', chosen.has(k) ? 'chosen' : '', inRepeat(ev.t) ? 'repeat' : '',
          view ? 'in-view' : '', view && row.num === inView![0] ? 'in-view-first' : '', view && row.num === inView![1] ? 'in-view-last' : '',
          row.group ? 'grp' : '', row.group && row.group.first ? 'grp-first' : '', row.group && row.group.last ? 'grp-last' : ''].filter(Boolean).join(' ')
        const place = placeOf(table, [ev.name], ev.hand)
        return <div key={k} className={cls} title={rowSpan(k) ? t('scene.span.hint', { name: ev.name }) : t('scene.moment.playHint')}
          onContextMenu={e => { if (!ev.from) return; e.preventDefault(); const at = { k, x: e.clientX, y: e.clientY }; setMenu(m => m?.k === k ? null : at) }}
          onClick={e => { if ((e.target as HTMLElement).closest('.scene-occ-form, button')) return; pickRow(row) }}>
          <span className="scene-num">{firingNumber(row.num)}</span>
          <span className="scene-dot" style={{ background: familyColor(lib, ev.name) }} />
          <span className="scene-name">{ev.from
            ? <span className="scene-overridden" title={t('scene.override.hint', { from: ev.from })}><i aria-hidden="true">◌</i>{ev.name}</span>
            : ev.name}<small title={`${place.title}\n${t('scene.placeHint')}`}>{place.text}</small></span>
          <CueKinds table={table} name={ev.name} />
          <span className="scene-num">{`${ev.t.toFixed(2)}s`}</span>
          <span className="scene-item-actions">
            <button type="button" className="scene-icon-btn scene-open-editor" aria-expanded={open === k} title={`${t('scene.occ.reassignHint')}${sent[sentKey] ? `\n${t('scene.occ.sent')}` : ''}`}
              onClick={e => { e.stopPropagation(); e.currentTarget.blur(); setOpen(open === k ? null : k) }}>{sent[sentKey] ? `✓ ${t('scene.moment.change')}` : t('scene.moment.change')}</button>
          </span>
          {menu?.k === k && ev.from && <MenuPopup anchor={list} at={menu} onClose={() => setMenu(null)} className="scene-occ-form scene-row-menu">
            <button type="button" role="menuitem" className="scene-icon-btn" autoFocus title={t('scene.override.undoHint')}
              onClick={e => { e.stopPropagation(); setMenu(null)
                void saveSceneOverrides(removeOverride(useSceneStore.getState().overrides, from, atOf(k))).catch(error => changeFailed(error instanceof Error ? error.message : String(error))) }}>{t('scene.override.undoTo', { from })}</button>
          </MenuPopup>}
          {open === k && table && <ChangeEventForm from={from} at={atOf(k)} table={table}
            onClose={() => setOpen(null)}
            onSent={to => { setSent(s => ({ ...s, [sentKey]: true })); setOpen(null); changedFiring(from, atOf(k), to) }}
            onError={changeFailed} />}
        </div>
      })}
    </div>
  </div>
}

/** Which outputs cue `name` uses (haptic / sound marks in fixed slots); empty for no name or an unknown cue. */
function CueKinds({ table, name }: { table: CueTable | null; name: string | null }) {
  // `cue:variant` names resolve like the game (an unknown variant plays its cue).
  const r = table && name ? resolveEventName(table, name) : null, e = r && table ? effectiveEvent(table, r.ref) : null
  return <span className="scene-kinds">
    <span>{e && e.haptics.length > 0 && <HapticIcon size={14} />}</span>
    <span>{e?.sfx && <SoundIcon size={14} />}</span>
  </span>
}

/** After a "Change" request: noted, and the firing is the new event at once (scene-overrides, until re-recorded). */
function changedFiring(from: string, atSec: number, to: string) {
  useSceneStore.getState().note({ id: 'scene.occ.sentStatus', params: { name: from, at: atSec.toFixed(2) } })
  void saveSceneOverrides(setSceneOverride(useSceneStore.getState().overrides, { from, atSec, to, requestedAt: localIsoString(new Date()) })).catch(error => changeFailed(error instanceof Error ? error.message : String(error)))
}
const changeFailed = (message: string) => useSceneStore.getState().note({ id: 'scene.occ.failed', params: { message }, error: true })

const EVENT_NAME = /^[A-Za-z0-9_.-]{1,80}(:[a-z][a-z0-9_]{0,79})?$/

/** "Change event…": over the rows (absolute; nothing moves). An existing event or a new `cue:variant`, a comment, "Request". */
function ChangeEventForm({ from, at, table, onSent, onError, onClose }: { from: string; at: number; table: CueTable; onSent: (to: string) => void; onError: (message: string) => void; onClose: () => void }) {
  const { t } = useI18n()
  const listId = useId()
  const [to, setTo] = useState('')
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  /** No editor folder could be restored: "Open the editor folder" is offered, and the request continues once chosen. */
  const [needFolder, setNeedFolder] = useState(false)
  const project = useSceneStore(s => s.lib?.project_name)
  const target = to.trim()
  const ref = EVENT_NAME.test(target) ? parseEventKey(target) : null
  const exists = !!ref && (ref.variant === null ? !!table.cues[ref.cue] : !!table.cues[ref.cue]?.variants?.[ref.variant])
  // A new variant of a known cue is made at once (multipliers only); a new cue is not (the game must fire it first).
  const newVariant = !!ref && !exists && ref.variant !== null && !!table.cues[ref.cue] && VARIANT_NAME.test(ref.variant)
  const valid = target !== from && (exists || newVariant)
  const send = async () => {
    setBusy(true)
    try {
      // The cue table first (the game project; no editor folder needed): a new variant exists at once.
      if (newVariant && ref) {
        const made = useSceneStore.getState().edit(tb => {
          const next = addVariant(tb, ref.cue, ref.variant!)
          next.cues[ref.cue].variants![ref.variant!] = { sfxVolume: 1, hapticsGain: 1 }
          return next
        })
        if (!made) throw new Error(t('scene.noProject'))
      }
      // The outbox lives in the editor folder: the remembered one (asking permission within this click), else pick one.
      if (!await useWaveformStore.getState().ensureFolder()) { setNeedFolder(true); return }
      setNeedFolder(false)
      const text = t('scene.occ.message', { name: from, at: at.toFixed(2), to: target }) + (comment.trim() ? `\n${comment.trim()}` : '')
      await useAgentTrialStore.getState().sendAgentMessage({ text, project, reassign: { cue: from, atSec: at, to: target, comment } })
      onSent(target)
    } catch (error) { onError(t('scene.occ.sendFailed', { error: error instanceof Error ? error.message : String(error) })) }
    finally { setBusy(false) }
  }
  return <div className="scene-occ-form" role="dialog" aria-label={t('scene.occ.reassign')}
    onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); onClose() } }}>
    <input autoFocus list={listId} value={to} placeholder={t('scene.occ.to')} aria-label={t('scene.occ.to')} title={newVariant ? t('scene.occ.newVariant', { name: target }) : undefined} onChange={e => setTo(e.target.value)} />
    <datalist id={listId}>{allEventKeys(table).filter(k => k !== from).map(k => <option key={k} value={k} />)}</datalist>
    <input value={comment} placeholder={t('scene.occ.comment')} aria-label={t('scene.occ.comment')} onChange={e => setComment(e.target.value)}
      onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing && valid && !busy) void send() }} />
    {needFolder ? <button type="button" className="scene-icon-btn" title={t('scene.occ.needFolderHint')} disabled={busy}
      onClick={() => void useWaveformStore.getState().openFolder().then(() => { if (useWaveformStore.getState().folder) void send() })}>{t('scene.occ.openFolder')}</button>
      : <button type="button" className="scene-icon-btn" disabled={busy || !valid} onClick={() => void send()}>{t('scene.occ.send')}</button>}
  </div>
}
