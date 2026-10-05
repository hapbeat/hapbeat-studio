import { useId, useMemo, useState } from 'react'
import { useI18n } from '@/i18n/I18nProvider'
import { useSceneStore } from '@/stores/sceneStore'
import { useEventStore } from '@/stores/eventStore'
import { useAgentTrialStore } from '@/stores/agentTrialStore'
import { allEventKeys, effectiveEvent, resolveEventName, scaleAt } from '@/utils/cueEvents'
import { occurrences, runPosition } from '@/utils/sceneSegments'
import { useScene } from './sceneContext'

/**
 * Every firing of one event in the recording (DEC-085: moments are checked here, not in the
 * editor). ▶ plays the full replay from 1 s before it and selects the cue, so the Event panel edits that
 * event's values (multipliers, materials — per event, never per moment). Each row shows the firing's effective
 * multiplier (a variant's sfxVolume / hapticsGain ramped to rampTo along rampCurve, or its rampSteps, by which firing of its run it is).
 * "Reassign" sends the agent a request to make that firing another event / variant
 * (hapbeat-agent-message@1 `reassign`: a change of the game's routing).
 */
export function SceneOccurrences() {
  const { t } = useI18n()
  const { runtime } = useScene()
  const data = useSceneStore(s => s.data)
  const table = useSceneStore(s => s.table)
  const lib = useSceneStore(s => s.lib)
  const name = useEventStore(s => s.sceneOccurrences)
  const counts = useMemo(() => {
    const out = new Map<string, number>()
    for (const e of data?.full.events ?? []) if (!lib?.ticks.includes(e.name)) out.set(e.name, (out.get(e.name) ?? 0) + 1)
    return [...out].sort(([a], [b]) => a.localeCompare(b))
  }, [data, lib])
  const times = useMemo(() => name && data ? occurrences(data.full.events, name) : [], [name, data])
  const resolved = table && name ? resolveEventName(table, name) : null
  const effective = resolved && table ? effectiveEvent(table, resolved.ref) : null
  const multiplier = (at: number) => {
    if (!effective || !data || (effective.scale.sfx === 1 && effective.scale.haptics === 1 && effective.scale.rampTo === null && !effective.scale.steps)) return null
    const m = scaleAt(effective, runPosition(data.full.events, { t: at, name: name! }))
    return m.sfx === m.haptics ? `×${m.sfx.toFixed(2)}` : `♪×${m.sfx.toFixed(2)} ≋×${m.haptics.toFixed(2)}`
  }
  const [open, setOpen] = useState<number | null>(null)
  const [sent, setSent] = useState<Record<string, true>>({})
  const [status, setStatus] = useState('')
  if (!data || !counts.length) return null
  const play = (at: number) => { runtime.audio(); useSceneStore.getState().selectCue(name!, at); runtime.playFull(Math.max(0, at - 1)) }
  return <div className="scene-occ">
    <label className="scene-occ-pick" title={t('scene.occ.hint')}>
      <span className="scene-dim">{t('scene.occ.label')}</span>
      <select value={name ?? ''} aria-label={t('scene.occ.label')} onChange={e => { setOpen(null); setStatus(''); useEventStore.getState().openInScene(e.target.value || null) }}>
        <option value="">—</option>
        {counts.map(([n, c]) => <option key={n} value={n}>{t('scene.occ.count', { name: n, count: c })}</option>)}
      </select>
    </label>
    {name && <ol className="scene-occ-list">
      {times.map((at, i) => <li key={at}>
        <div className="scene-occ-row">
          <span className="scene-num">{i + 1}</span>
          <button type="button" className="scene-icon-btn" title={t('scene.occ.playHint')} onClick={e => { e.currentTarget.blur(); play(at) }}>▶ {at.toFixed(2)} s</button>
          <button type="button" className="scene-icon-btn" aria-expanded={open === i} title={t('scene.occ.reassignHint')} onClick={() => setOpen(open === i ? null : i)}>{t('scene.occ.reassign')}</button>
          <span className="scene-grow" />
          {multiplier(at) && <small className="scene-dim" title={t('scene.occ.multiplierHint')}>{multiplier(at)}</small>}
          {sent[`${name}@${at}`] && <span className="scene-on">{t('scene.occ.sent')}</span>}
        </div>
        {open === i && table && <ReassignForm from={name} at={at} keys={allEventKeys(table).filter(k => k !== name)}
          onSent={() => { setSent(s => ({ ...s, [`${name}@${at}`]: true })); setOpen(null); setStatus(t('scene.occ.sentStatus', { name, at: at.toFixed(2) })) }}
          onError={message => setStatus(message)} />}
      </li>)}
    </ol>}
    {status && <div className="scene-dim scene-occ-status" role="status">{status}</div>}
  </div>
}

function ReassignForm({ from, at, keys, onSent, onError }: { from: string; at: number; keys: string[]; onSent: () => void; onError: (message: string) => void }) {
  const { t } = useI18n()
  const listId = useId()
  const [to, setTo] = useState('')
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  const project = useSceneStore(s => s.lib?.project_name)
  const send = async () => {
    setBusy(true)
    try {
      const text = t('scene.occ.message', { name: from, at: at.toFixed(2), to: to.trim() }) + (comment.trim() ? `\n${comment.trim()}` : '')
      await useAgentTrialStore.getState().sendAgentMessage({ text, project, reassign: { cue: from, atSec: at, to: to.trim(), comment } })
      onSent()
    } catch (error) { onError(t('scene.occ.sendFailed', { error: error instanceof Error ? error.message : String(error) })) }
    finally { setBusy(false) }
  }
  return <div className="scene-occ-form">
    <input list={listId} value={to} placeholder={t('scene.occ.to')} aria-label={t('scene.occ.to')} onChange={e => setTo(e.target.value)} />
    <datalist id={listId}>{keys.map(k => <option key={k} value={k} />)}</datalist>
    <input value={comment} placeholder={t('scene.occ.comment')} aria-label={t('scene.occ.comment')} onChange={e => setComment(e.target.value)} />
    <button type="button" className="scene-icon-btn" disabled={busy || !/^[A-Za-z0-9_.-]{1,80}(:[a-z][a-z0-9_]{0,79})?$/.test(to.trim())} onClick={() => void send()}>{t('scene.occ.send')}</button>
  </div>
}
