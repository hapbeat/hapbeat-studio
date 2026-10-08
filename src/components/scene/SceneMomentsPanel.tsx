import { Fragment, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useI18n } from '@/i18n/I18nProvider'
import { useSceneStore } from '@/stores/sceneStore'
import { useSceneSettings } from '@/stores/sceneSettings'
import { useAgentTrialStore } from '@/stores/agentTrialStore'
import { useWaveformStore } from '@/stores/waveformStore'
import { familyColor, offsetOf } from '@/utils/sceneData'
import { addVariant, allEventKeys, effectiveEvent, parseEventKey, resolveEventName } from '@/utils/cueEvents'
import { VARIANT_NAME, type CueTable } from '@/utils/sceneCueTable'
import { HapticIcon } from './HapticIcon'
import { useMomentPlace } from './SceneCuePanels'
import { useScene } from './sceneContext'
import { removeOverride, setOverride as setSceneOverride, type OverriddenClip } from '@/utils/sceneOverrides'
import { saveSceneOverrides } from '@/hooks/useSceneOverrides'
import { localIsoString } from '@/utils/hapticKnowledge'
import { MenuPopup } from '@/components/waveform/EditorMenu'
import { loopCueRunAt, loopCueRuns, nearestFiring } from '@/utils/loopStretch'

/**
 * "Moments and events": the full replay, then one clip per cue moment, with which outputs its cues use. A click on
 * a row jumps to that moment (from the lead-in setting before its mark) and plays it. "Change" opens a one-line
 * request over the rows (nothing moves): an existing event or a new `cue:variant`, a comment, "Request" — a new
 * variant is made in the cue table at once (multipliers only, 1 / 1) so it can be tuned here, and the agent gets a
 * hapbeat-agent-message@1 `reassign` (the game's routing changes; the table holds no per-moment values).
 * A moment of several cues lists each cue as its own row under it (one click selects that cue). A loop cue's row (the
 * moment's, or its cue row) plays its own span instead: the layer's active run its firing starts (loopCueRunAt), in the
 * full replay from the lead-in before it to the lead-in after it (SceneRuntime.playSpan); one-shot rows play the moment.
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
  const [open, setOpen] = useState<number | null>(null)
  const [sent, setSent] = useState<Record<number, true>>({})
  /** The row whose right-click menu ("Undo" of a changed firing) is open, and where (the pointer). */
  const [menu, setMenu] = useState<{ k: number; x: number; y: number } | null>(null)
  // The firing selected here or on the timeline (Event panel follows it too): its moment's row is marked and scrolled to.
  const sel = useSceneStore(s => s.sel)
  const data = useSceneStore(s => s.data)
  const span = useSceneStore(s => s.span)
  /** Each loop cue's active runs over the recording (once per recording). */
  const runsOf = useMemo(() => new Map(data && lib ? lib.loop_cues.map(c => [c, loopCueRuns(data.full.levels, data.fps, lib, c)]) : []), [data, lib])
  /** The span the row of cue `name` in moment `k` plays: its loop cue's run started by that firing (null for one-shot cues). */
  const rowSpan = (k: number, name: string) => { const it = items[k], runs = runsOf.get(name.split(':')[0]); return it?.kind === 'clip' && data && runs?.length ? loopCueRunAt(runs, data.full.events, name, it.at) : null }
  /** Whether the row of `name` in moment `k` is the span playing. */
  const spanPlaying = (k: number, name: string) => { const r = span && rowSpan(k, name); return !!r && r[0] === span![0] && r[1] === span![1] }
  /** The row of cue `name` in moment `k`: a loop cue plays its own span (selected at its firing in the full replay), a one-shot cue the moment. */
  const pickCue = (k: number, name: string) => {
    const it = items[k], run = rowSpan(k, name), lead = useSceneSettings.getState().leadSec
    runtime.audio()
    if (run && it && data) {
      runtime.playSpan(run, lead, lead)
      useSceneStore.getState().selectCue(name, nearestFiring(data.full.events, name, it.at))
      return
    }
    runtime.playMoment(k, lead)
    if (it?.kind === 'clip') useSceneStore.getState().selectCue(name, it.event)
  }
  const picked = useMemo(() => {
    const it = items[cur]
    if (!sel || sel.t == null || !it) return -1
    const replay = sel.t + offsetOf(it)
    return items.findIndex(x => x.kind === 'clip' && x.names.includes(sel.name) && Math.abs(x.at - replay) < 0.05)
  }, [sel, items, cur])
  useEffect(() => { list.current?.querySelector('.scene-item.picked, .scene-item.sel')?.scrollIntoView({ block: 'nearest' }) }, [cur, picked])
  if (!lib) return <div className="scene-panel-empty">{t('scene.noProject')}</div>
  return <div className="scene-moments">
    <div className="scene-legend">
      {lib.families.map(f => <span key={f.label}><i style={{ background: f.color }} />{f.label}</span>)}
      <span><b className="scene-kinds"><span className="h"><HapticIcon /></span></b> {t('scene.legend.haptics')}</span>
      <span><b className="scene-kinds"><span className="s">♪</span></b> {t('scene.legend.sound')}</span>
    </div>
    <div ref={list}>
      {items.map((it, k) => {
        // `cue:variant` names resolve like the game (an unknown variant plays its cue).
        const cues = it.kind === 'clip' && table ? it.names.map(n => { const r = resolveEventName(table, n); return r && effectiveEvent(table, r.ref) }).filter(e => !!e) : []
        const several = it.kind === 'clip' && it.names.length > 1
        const rowSel = span ? it.kind === 'clip' && !several && spanPlaying(k, it.name) : k === cur
        return <Fragment key={k}><div className={`scene-item ${rowSel ? 'sel' : ''} ${k === picked ? 'picked' : ''}`}
          title={it.kind === 'clip' && !several && rowSpan(k, it.name) ? t('scene.span.hint', { name: it.name }) : t('scene.moment.playHint')}
          onContextMenu={e => { if (!(it as OverriddenClip).from) return; e.preventDefault(); const at = { k, x: e.clientX, y: e.clientY }; setMenu(m => m?.k === k ? null : at) }}
          onClick={e => {
            if ((e.target as HTMLElement).closest('.scene-occ-form, button')) return
            // The timeline marks the moment's firing (video time of the clip) and the Event panel shows it (its first cue).
            if (it.kind === 'clip') pickCue(k, it.name)
            else { runtime.audio(); runtime.playMoment(k, useSceneSettings.getState().leadSec) }
          }}>
          <span className="scene-num">{k === 0 ? '▶' : String(k).padStart(2, '0')}</span>
          <span className="scene-dot" style={{ background: familyColor(lib, it.name) }} />
          <span className="scene-name">{it.kind === 'full' ? t('scene.full') : <>{(it as OverriddenClip).from
            ? <span className="scene-overridden" title={t('scene.override.hint', { from: (it as OverriddenClip).from! })}><i aria-hidden="true">◌</i>{it.names.join(' + ')}</span>
            : it.names.join(' + ')}{(() => { const p = placeOf(table, it.names, it.hand); return <small title={`${p.title}\n${t('scene.placeHint')}`}>{p.text}</small> })()}</>}</span>
          <span className="scene-kinds">{cues.length > 0 && <><span className="h">{cues.some(c => c.haptics.length) ? <HapticIcon /> : null}</span><span className="s">{cues.some(c => c.sfx) ? '♪' : ''}</span></>}</span>
          <span className="scene-num">{it.kind === 'full' ? '' : `${it.at.toFixed(1)}s`}</span>
          {it.kind === 'clip' && <span className="scene-item-actions">
            <button type="button" className="scene-icon-btn scene-open-editor" aria-expanded={open === k} title={`${t('scene.occ.reassignHint')}${sent[k] ? `\n${t('scene.occ.sent')}` : ''}`}
            onClick={e => { e.stopPropagation(); e.currentTarget.blur(); setOpen(open === k ? null : k) }}>{sent[k] ? `✓ ${t('scene.moment.change')}` : t('scene.moment.change')}</button>
          </span>}
          {menu?.k === k && (it as OverriddenClip).from && <MenuPopup anchor={list} at={menu} onClose={() => setMenu(null)} className="scene-occ-form scene-row-menu">
            <button type="button" role="menuitem" className="scene-icon-btn" autoFocus title={t('scene.override.undoHint')}
              onClick={e => { e.stopPropagation(); setMenu(null); const from = (it as OverriddenClip).from!
                void saveSceneOverrides(removeOverride(useSceneStore.getState().overrides, from, it.at)).catch(error => changeFailed(error instanceof Error ? error.message : String(error))) }}>{t('scene.override.undoTo', { from: (it as OverriddenClip).from! })}</button>
          </MenuPopup>}
          {open === k && it.kind === 'clip' && table && <ChangeEventForm from={(it as OverriddenClip).from ?? it.name} at={it.at} table={table}
            onClose={() => setOpen(null)}
            onSent={to => { setSent(s => ({ ...s, [k]: true })); setOpen(null); changedFiring((it as OverriddenClip).from ?? it.name, it.at, to) }}
            onError={changeFailed} />}
        </div>
        {several && it.names.map(name => <div key={name} className={`scene-item scene-subitem ${(span ? spanPlaying(k, name) : k === cur && sel?.name === name) ? 'sel' : ''}`}
          title={rowSpan(k, name) ? t('scene.span.hint', { name }) : t('scene.moment.cueHint', { name })} onClick={() => pickCue(k, name)}>
          <span className="scene-dot" style={{ background: familyColor(lib, name) }} />
          <span className="scene-name">{name}</span>
        </div>)}
        </Fragment>
      })}
    </div>
  </div>
}

/** After a "Change" request: noted, and the firing is the new event at once (scene-overrides, until re-recorded). */
export function changedFiring(from: string, atSec: number, to: string) {
  useSceneStore.getState().note({ id: 'scene.occ.sentStatus', params: { name: from, at: atSec.toFixed(2) } })
  void saveSceneOverrides(setSceneOverride(useSceneStore.getState().overrides, { from, atSec, to, requestedAt: localIsoString(new Date()) })).catch(error => changeFailed(error instanceof Error ? error.message : String(error)))
}
export const changeFailed = (message: string) => useSceneStore.getState().note({ id: 'scene.occ.failed', params: { message }, error: true })

const EVENT_NAME = /^[A-Za-z0-9_.-]{1,80}(:[a-z][a-z0-9_]{0,79})?$/

/** "Change event…": over the rows (absolute; nothing moves). An existing event or a new `cue:variant`, a comment, "Request". */
export function ChangeEventForm({ from, at, table, onSent, onError, onClose }: { from: string; at: number; table: CueTable; onSent: (to: string) => void; onError: (message: string) => void; onClose: () => void }) {
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
