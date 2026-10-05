import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useI18n } from '@/i18n/I18nProvider'
import { useSceneStore } from '@/stores/sceneStore'
import { useSceneSettings } from '@/stores/sceneSettings'
import { useEventStore } from '@/stores/eventStore'
import { useAgentTrialStore } from '@/stores/agentTrialStore'
import { familyColor } from '@/utils/sceneData'
import { addVariant, allEventKeys, effectiveEvent, parseEventKey, resolveEventName, scaleAt } from '@/utils/cueEvents'
import { VARIANT_NAME, type CueTable } from '@/utils/sceneCueTable'
import { runPosition } from '@/utils/sceneSegments'
import { HapticIcon } from './HapticIcon'
import { useScene } from './sceneContext'

/**
 * "Moments and events": every firing of the recording (viewer-data `full.events`, ticks left out) in time order,
 * one line each — number · time · event (`cue:variant`) · ▶ · "Change event…" — with its effective multiplier
 * (a variant's multipliers ramped by which firing of its run it is) at the right. One filter on top (all / one
 * event; it follows the cue selected in the Event panel or the timeline). ▶ plays the full replay from the
 * lead-in setting before the firing and selects its event. "Change event…" opens a one-line request over the
 * rows (nothing moves): an existing cue / variant or a new variant name, a comment, "Request" — a new variant is
 * made in the cue table at once (multipliers only, 1 / 1) so it can be tuned here, and the agent gets a
 * hapbeat-agent-message@1 `reassign` (the game's routing changes; the table holds no per-moment values).
 */
export function SceneMomentsPanel() {
  const { t } = useI18n()
  const { runtime } = useScene()
  const lib = useSceneStore(s => s.lib)
  const data = useSceneStore(s => s.data)
  const table = useSceneStore(s => s.table)
  const filter = useEventStore(s => s.sceneOccurrences) ?? ''
  // The event selected elsewhere (Event panel, timeline) filters the list; a ▶ here selects too and must not narrow it.
  const ownSelect = useRef(false)
  const selected = useSceneStore(s => s.sel?.name ?? null)
  useEffect(() => {
    if (ownSelect.current) { ownSelect.current = false; return }
    if (selected && selected !== useEventStore.getState().sceneOccurrences) useEventStore.setState({ sceneOccurrences: selected })
  }, [selected])
  const firings = useMemo(() => (data?.full.events ?? []).filter(e => !lib?.ticks.includes(e.name)).sort((a, b) => a.t - b.t), [data, lib])
  const names = useMemo(() => [...new Set(firings.map(f => f.name))].sort(), [firings])
  const [open, setOpen] = useState<string | null>(null)
  const [sent, setSent] = useState<Record<string, true>>({})
  const [status, setStatus] = useState('')
  if (!lib || !data) return <div className="scene-panel-empty">{t('scene.noProject')}</div>
  const multiplier = (name: string, at: number) => {
    const r = table ? resolveEventName(table, name) : null, e = r && table ? effectiveEvent(table, r.ref) : null
    if (!e || (e.scale.sfx === 1 && e.scale.haptics === 1 && e.scale.rampTo === null && !e.scale.steps)) return null
    const m = scaleAt(e, runPosition(data.full.events, { t: at, name }))
    return m.sfx === m.haptics ? `×${m.sfx.toFixed(2)}` : `♪×${m.sfx.toFixed(2)} ≋×${m.haptics.toFixed(2)}`
  }
  const play = (name: string, at: number) => {
    runtime.audio(); ownSelect.current = true
    useSceneStore.getState().selectCue(name, at)
    runtime.playFull(Math.max(0, at - useSceneSettings.getState().leadSec))
  }
  const shown = filter ? firings.filter(f => f.name === filter) : firings
  return <div className="scene-moments">
    <div className="scene-legend">
      {lib.families.map(f => <span key={f.label}><i style={{ background: f.color }} />{f.label}</span>)}
      <span><b className="scene-kinds"><span className="h"><HapticIcon /></span></b> {t('scene.legend.haptics')}</span>
      <span><b className="scene-kinds"><span className="s">♪</span></b> {t('scene.legend.sound')}</span>
    </div>
    <label className="scene-occ-pick" title={t('scene.occ.hint')}>
      <span className="scene-dim">{t('scene.occ.label')}</span>
      <select value={filter} aria-label={t('scene.occ.label')} onChange={e => { const v = e.target.value; e.target.blur(); setOpen(null); useEventStore.setState({ sceneOccurrences: v || null }) }}>
        <option value="">{t('scene.occ.all', { count: firings.length })}</option>
        {[...new Set([...names, ...(filter && !names.includes(filter) ? [filter] : [])])].map(n => <option key={n} value={n}>{t('scene.occ.count', { name: n, count: firings.filter(f => f.name === n).length })}</option>)}
      </select>
    </label>
    <div className="scene-occ-status scene-dim" role="status">{status}</div>
    <ol className="scene-occ-list">
      {shown.map(f => {
        const key = `${f.name}@${f.t}`, index = firings.indexOf(f) + 1, m = multiplier(f.name, f.t)
        return <li key={key} className="scene-occ-row">
          <span className="scene-num">{index}</span>
          <span className="scene-num">{f.t.toFixed(2)}s</span>
          <span className="scene-name" title={f.name}><i className="scene-dot" style={{ background: familyColor(lib, f.name) }} />{f.name}</span>
          <button type="button" className="scene-icon-btn" title={t('scene.occ.playHint')} aria-label={t('scene.occ.playHint')} onClick={e => { e.currentTarget.blur(); play(f.name, f.t) }}>▶</button>
          <button type="button" className="scene-icon-btn" aria-expanded={open === key} title={t('scene.occ.reassignHint')} onClick={() => setOpen(open === key ? null : key)}>{t('scene.occ.reassign')}</button>
          <span className="scene-occ-tail">
            {sent[key] && <span className="scene-on">{t('scene.occ.sent')}</span>}
            {m && <small className="scene-dim" title={t('scene.occ.multiplierHint')}>{m}</small>}
          </span>
          {open === key && table && <ChangeEventForm from={f.name} at={f.t} table={table}
            onClose={() => setOpen(null)}
            onSent={() => { setSent(s => ({ ...s, [key]: true })); setOpen(null); setStatus(t('scene.occ.sentStatus', { name: f.name, at: f.t.toFixed(2) })) }}
            onError={message => setStatus(message)} />}
        </li>
      })}
    </ol>
  </div>
}

const EVENT_NAME = /^[A-Za-z0-9_.-]{1,80}(:[a-z][a-z0-9_]{0,79})?$/

/** "Change event…": over the rows (absolute; nothing moves). An existing event or a new `cue:variant`, a comment, "Request". */
function ChangeEventForm({ from, at, table, onSent, onError, onClose }: { from: string; at: number; table: CueTable; onSent: () => void; onError: (message: string) => void; onClose: () => void }) {
  const { t } = useI18n()
  const listId = useId()
  const [to, setTo] = useState('')
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
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
      if (newVariant && ref) {
        const made = useSceneStore.getState().edit(tb => {
          const next = addVariant(tb, ref.cue, ref.variant!)
          next.cues[ref.cue].variants![ref.variant!] = { sfxVolume: 1, hapticsGain: 1 }
          return next
        })
        if (!made) throw new Error(t('scene.noProject'))
      }
      const text = t('scene.occ.message', { name: from, at: at.toFixed(2), to: target }) + (comment.trim() ? `\n${comment.trim()}` : '')
      await useAgentTrialStore.getState().sendAgentMessage({ text, project, reassign: { cue: from, atSec: at, to: target, comment } })
      onSent()
    } catch (error) { onError(t('scene.occ.sendFailed', { error: error instanceof Error ? error.message : String(error) })) }
    finally { setBusy(false) }
  }
  return <div className="scene-occ-form" role="dialog" aria-label={t('scene.occ.reassign')}
    onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); onClose() } }}>
    <input autoFocus list={listId} value={to} placeholder={t('scene.occ.to')} aria-label={t('scene.occ.to')} title={newVariant ? t('scene.occ.newVariant', { name: target }) : undefined} onChange={e => setTo(e.target.value)} />
    <datalist id={listId}>{allEventKeys(table).filter(k => k !== from).map(k => <option key={k} value={k} />)}</datalist>
    <input value={comment} placeholder={t('scene.occ.comment')} aria-label={t('scene.occ.comment')} onChange={e => setComment(e.target.value)}
      onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing && valid && !busy) void send() }} />
    <button type="button" className="scene-icon-btn" disabled={busy || !valid} onClick={() => void send()}>{t('scene.occ.send')}</button>
  </div>
}
