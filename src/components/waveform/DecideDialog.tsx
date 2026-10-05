import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useI18n } from '@/i18n/I18nProvider'
import { useEventStore, type DecideRequest } from '@/stores/eventStore'
import { useSceneStore } from '@/stores/sceneStore'
import { useAgentTrialStore } from '@/stores/agentTrialStore'
import { useWaveformStore } from '@/stores/waveformStore'
import { useEditorSettings } from '@/stores/editorSettings'
import { isLoopCue, positionsForCue, soundAllowed } from '@/utils/sceneCueTable'
import { allEventKeys, defaultAt, effectiveEvent, matchesName, needsRouteForm, overwriteUsers, parseEventKey, sameBytes, trialEvent } from '@/utils/cueEvents'
import { useAtLabel } from '@/components/scene/SceneCuePanels'
import { autoWavName, decideSourceBuffer, encodeMaterial, existingWav, runDecision } from './eventDecide'
import { intensityForPeak } from '@/utils/materialLevel'
import '@/components/common/ConfirmDialog.css'
import './EventsPanel.css'

const message = (error: unknown) => error instanceof Error ? error.message : String(error)

/** "Decide" dialog (opened through eventStore.requestDecide from a trial candidate, the clip menu, Properties or the Events panel). */
export function DecideDialog() {
  const request = useEventStore(s => s.decide)
  if (!request) return null
  const source = request.source
  return <DecideForm key={`${request.target}:${source.kind === 'clip' ? source.clipId : `${source.trialId}/${source.candidateId}`}:${request.event ?? ''}`} request={request} />
}

/** The last decision: what was written, the import command (copy) and "Undo". */

function DecideForm({ request }: { request: DecideRequest }) {
  const { t } = useI18n()
  const atLabel = useAtLabel()
  const table = useSceneStore(s => s.table)
  const lib = useSceneStore(s => s.lib)
  const dirty = useSceneStore(s => s.dirty)
  const selected = useEventStore(s => s.selected)
  const trials = useAgentTrialStore(s => s.trials)
  const documents = useWaveformStore(s => s.documents)
  const marks = useEditorSettings(s => s.eventMarks)
  const close = () => useEventStore.getState().closeDecide()
  const { target, source } = request
  const record = source.kind === 'candidate' ? trials.find(r => r.trial.id === source.trialId) : undefined
  const sourceLabel = source.kind === 'clip' ? documents.find(d => d.clip.id === source.clipId)?.clip.name ?? source.clipId
    : `${source.trialId} / ${source.candidateId} ${record?.trial.candidates.find(c => c.id === source.candidateId)?.label ?? ''}`
  const events = useMemo(() => table && lib ? allEventKeys(table).filter(k => target === 'haptic' || soundAllowed(lib, parseEventKey(k).cue)) : [], [table, lib, target])
  const [event, setEvent] = useState(() => {
    // A clip opened from an event ("edit as clip") or decided before goes back to that event by default.
    const subject = source.kind === 'clip' ? source.clipId : `${source.trialId}/${source.candidateId}`
    const marked = lib ? (marks[subject] ?? []).filter(m => m.project === lib.project_name && m.target === target).map(m => m.event).pop() : undefined
    const wanted = [request.event, marked, record && table ? trialEvent(table, record.trial.scene) : null, selected]
    return wanted.find((k): k is string => !!k && events.includes(k)) ?? events[0] ?? ''
  })
  const ref = parseEventKey(event)
  const valid = !!table && !!lib && events.includes(event)
  // The WAV is encoded once; its default name comes from the source (free, or a file with the same bytes).
  const [wav, setWav] = useState<ArrayBuffer | null>(null)
  const [name, setName] = useState('')
  const [nameEdited, setNameEdited] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    void decideSourceBuffer(source).then(b => encodeMaterial(b, target)).then(m => { if (!cancelled) { setWav(m.wav); setIntensity(intensityForPeak(m.peak)) } }, e => { if (!cancelled) setError(message(e)) })
    return () => { cancelled = true }
  }, [])
  useEffect(() => {
    if (!wav || !valid || nameEdited) return
    let cancelled = false
    void autoWavName(target, source, wav, [event]).then(n => { if (!cancelled) setName(n.name) }, e => { if (!cancelled) setError(message(e)) })
    return () => { cancelled = true }
  }, [wav, event, valid, nameEdited])
  /** What is on disk under the name: none, the same bytes, or different bytes (only then the overwrite is confirmed). */
  const [onDisk, setOnDisk] = useState<'none' | 'same' | 'different'>('none')
  useEffect(() => {
    if (!wav || !name) { setOnDisk('none'); return }
    let cancelled = false
    void existingWav(target, name).then(b => { if (!cancelled) setOnDisk(!b ? 'none' : sameBytes(b, wav) ? 'same' : 'different') })
    return () => { cancelled = true }
  }, [wav, name, target])
  const [at, setAt] = useState(() => valid ? defaultAt(lib!, ref.cue) : 'hand')
  useEffect(() => { if (valid) setAt(defaultAt(lib!, ref.cue)) }, [event])
  /** The new material's intensity (its size before normalizing; DEC-086). */
  const [intensity, setIntensity] = useState(1)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) close() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy])

  const title = t(target === 'sound' ? 'events.decideSound' : 'events.decideHaptic')
  let body: JSX.Element
  let canSubmit = false
  if (!table || !lib) body = <p className="recipe-dialog-note">{t('events.decide.noProject')}</p>
  else if (!events.length) body = <p className="recipe-dialog-note">{t('events.decide.noEvents')}</p>
  else {
    const pattern = target === 'haptic' ? lib.clip_name : lib.sound_name
    const dir = target === 'haptic' ? lib.paths.clips : lib.paths.sounds
    const nameOk = matchesName(name, pattern) && !(target === 'sound' && lib.loop_sounds.includes(name))
    const users = valid ? overwriteUsers(table, target === 'haptic' ? 'clip' : 'sound', name, [event]) : []
    const routeForm = target === 'haptic' && valid && needsRouteForm(table, ref)
    const soundFirst = target === 'haptic' && valid && !isLoopCue(lib, ref.cue) && !effectiveEvent(table, ref)?.sfx
    const loopMismatch = target === 'haptic' && !!table.clips[name] && table.clips[name].loop !== isLoopCue(lib, ref.cue)
    canSubmit = valid && !!wav && nameOk && !loopMismatch && !dirty && !busy
    body = <>
      <p className="recipe-dialog-note">{t('events.decide.source', { source: sourceLabel })}</p>
      <label className="recipe-dialog-field">{t('events.decide.event')}
        <select value={event} onChange={e => { setEvent(e.target.value); setError(null) }}>
          {events.map(k => <option key={k} value={k}>{k}</option>)}
        </select>
      </label>
      {soundFirst && <p className="events-hint">{t('events.soundFirst')}</p>}
      <label className="recipe-dialog-field">{t(target === 'haptic' ? 'events.decide.clipName' : 'events.decide.soundName')}
        <input value={name} spellCheck={false} placeholder={wav ? '' : t('events.decide.preparing')} onChange={e => { setName(e.target.value); setNameEdited(true); setError(null) }} />
      </label>
      {name && !nameOk && <p className="events-warn">{t('events.decide.badName', { pattern })}</p>}
      {loopMismatch && <p className="events-warn">{t('events.decide.loopMismatch', { name })}</p>}
      {nameOk && onDisk === 'same' && <p className="recipe-dialog-note">{t('events.decide.sameFile', { file: `${dir}/${name}.wav` })}</p>}
      {nameOk && onDisk === 'different' && <p className="events-warn">{users.length ? t('events.decide.overwriteUsed', { file: `${dir}/${name}.wav`, events: users.join(', ') })
        : t('events.decide.overwrite', { file: `${dir}/${name}.wav` })}</p>}
      {routeForm && <div className="events-decide-route">
        <label className="recipe-dialog-field">{t('scene.route.at')}
          <select value={at} onChange={e => setAt(e.target.value)}>{positionsForCue(lib, ref.cue).map(a => <option key={a} value={a}>{atLabel(a)}</option>)}</select>
        </label>
      </div>}
      {!routeForm && target === 'haptic' && <p className="recipe-dialog-note">{t('events.decide.keepsRoute')}</p>}
      <p className="recipe-dialog-note">{t(target === 'haptic' ? 'events.decide.writesHaptic' : 'events.decide.writesSound', { dir, table: lib.paths.cues })}</p>
      {dirty && <p className="events-warn">{t('events.decide.dirty')}</p>}
      {error && <p className="events-warn" role="alert">{error}</p>}
    </>
  }
  const submit = async () => {
    if (!canSubmit || !wav) return
    setBusy(true); setError(null)
    try {
      const r = await runDecision({ target, source, events: [event], name, at, wav, intensity })
      // Success is logged (activity log), not shown: the dialog just closes.
      if (r.ok) { close(); return }
      else setError(t(r.notice.id, r.notice.params))
    } catch (e) { setError(message(e)) }
    finally { setBusy(false) }
  }
  return createPortal(
    <div className="confirm-dialog-backdrop" onClick={() => { if (!busy) close() }}>
      <div className="confirm-dialog recipe-dialog events-decide-dialog" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={title}>
        <div className="confirm-dialog-title">{title}</div>
        <div className="confirm-dialog-body recipe-dialog-body">{body}</div>
        <div className="confirm-dialog-actions">
          <button type="button" className="form-button-secondary" disabled={busy} onClick={close}>{t('common.cancel')}</button>
          {<button type="button" className="form-button" disabled={!canSubmit} onClick={() => void submit()}>{t(busy ? 'events.decide.writing' : onDisk === 'different' ? 'events.decide.overwriteSubmit' : 'events.decide.submit')}</button>}
        </div>
      </div>
    </div>,
    document.body,
  )
}
