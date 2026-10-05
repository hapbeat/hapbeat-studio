import { useEffect, useId, useRef, useState } from 'react'
import { useI18n } from '@/i18n/I18nProvider'
import { useSceneStore } from '@/stores/sceneStore'
import { useSceneSettings } from '@/stores/sceneSettings'
import { useAgentTrialStore } from '@/stores/agentTrialStore'
import { useWaveformStore } from '@/stores/waveformStore'
import { familyColor } from '@/utils/sceneData'
import { addVariant, allEventKeys, effectiveEvent, parseEventKey, resolveEventName } from '@/utils/cueEvents'
import { VARIANT_NAME, type CueTable } from '@/utils/sceneCueTable'
import { HapticIcon } from './HapticIcon'
import { useMomentPlace } from './SceneCuePanels'
import { useScene } from './sceneContext'

/**
 * "Moments and events": the full replay, then one clip per cue moment, with which outputs its cues use. A click on
 * a row jumps to that moment (from the lead-in setting before its mark) and plays it. "Change" opens a one-line
 * request over the rows (nothing moves): an existing event or a new `cue:variant`, a comment, "Request" — a new
 * variant is made in the cue table at once (multipliers only, 1 / 1) so it can be tuned here, and the agent gets a
 * hapbeat-agent-message@1 `reassign` (the game's routing changes; the table holds no per-moment values).
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
  useEffect(() => { list.current?.querySelector('.scene-item.sel')?.scrollIntoView({ block: 'nearest' }) }, [cur])
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
        return <div key={k} className={`scene-item ${k === cur ? 'sel' : ''}`} title={t('scene.moment.playHint')}
          onClick={e => { if ((e.target as HTMLElement).closest('.scene-occ-form, button')) return; runtime.audio(); runtime.playMoment(k, useSceneSettings.getState().leadSec) }}>
          <span className="scene-num">{k === 0 ? '▶' : String(k).padStart(2, '0')}</span>
          <span className="scene-dot" style={{ background: familyColor(lib, it.name) }} />
          <span className="scene-name">{it.kind === 'full' ? t('scene.full') : <>{it.names.join(' + ')}{(() => { const p = placeOf(table, it.names, it.hand); return <small title={`${p.title}\n${t('scene.placeHint')}`}>{p.text}</small> })()}</>}</span>
          <span className="scene-kinds">{cues.length > 0 && <><span className="h">{cues.some(c => c.haptics.length) ? <HapticIcon /> : null}</span><span className="s">{cues.some(c => c.sfx) ? '♪' : ''}</span></>}</span>
          <span className="scene-num">{it.kind === 'full' ? '' : `${it.at.toFixed(1)}s`}</span>
          {it.kind === 'clip' && <button type="button" className="scene-icon-btn scene-open-editor" aria-expanded={open === k} title={`${t('scene.occ.reassignHint')}${sent[k] ? `\n${t('scene.occ.sent')}` : ''}`}
            onClick={e => { e.stopPropagation(); e.currentTarget.blur(); setOpen(open === k ? null : k) }}>{sent[k] ? `✓ ${t('scene.moment.change')}` : t('scene.moment.change')}</button>}
          {open === k && it.kind === 'clip' && table && <ChangeEventForm from={it.name} at={it.at} table={table}
            onClose={() => setOpen(null)}
            onSent={() => { setSent(s => ({ ...s, [k]: true })); setOpen(null); useSceneStore.getState().note({ id: 'scene.occ.sentStatus', params: { name: it.name, at: it.at.toFixed(2) } }) }}
            onError={message => useSceneStore.getState().note({ id: 'scene.occ.failed', params: { message }, error: true })} />}
        </div>
      })}
    </div>
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
    {needFolder ? <button type="button" className="scene-icon-btn" title={t('scene.occ.needFolderHint')} disabled={busy}
      onClick={() => void useWaveformStore.getState().openFolder().then(() => { if (useWaveformStore.getState().folder) void send() })}>{t('scene.occ.openFolder')}</button>
      : <button type="button" className="scene-icon-btn" disabled={busy || !valid} onClick={() => void send()}>{t('scene.occ.send')}</button>}
  </div>
}
