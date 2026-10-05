import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useI18n, type MessageId } from '@/i18n/I18nProvider'
import { useAgentTrialStore, type AuditionTarget } from '@/stores/agentTrialStore'
import { useHelperConnection } from '@/hooks/useHelperConnection'
import { useWaveformStore } from '@/stores/waveformStore'
import { localIsoString, type Dimension, type DimensionsDoc, type TrialRecord } from '@/utils/hapticKnowledge'
import type { HapticFeatures } from '@/utils/hapticFeatures'
import { clearRatingDraft, DRAFT_DEBOUNCE_MS, newerDraft, readFolderDraft, readLocalDraft, writeRatingDraft } from '@/utils/ratingDrafts'
import { addUseRange, usableCandidates, autoRatingContext, EMPTY_CONTEXT, formToRating, jaPolePhrase, loadRememberedContext, POSITION_SUGGESTIONS, ratingFormIssue, ratingToForm, rememberContext, SOUND_DIMENSIONS, trialKind, verdictFromOverall, visibleDimensions, type CandidateRatingForm, type Direction, type RatingForm } from '@/utils/agentTrialUi'
import { trialTarget, type TrialKind } from '@/utils/agentProtocol'
import { useEventStore } from '@/stores/eventStore'
import { assignEventsForTrial, effectiveEvent, parseEventKey, trialEvent } from '@/utils/cueEvents'
import { runDecision } from './eventDecide'
import { DecidedNotice } from './DecideDialog'
import { isLoopCue } from '@/utils/sceneCueTable'
import { WaveformThumbnail } from './WaveformThumbnail'
import { EditorMenu, EditorMenuItem } from './EditorMenu'
import { filterTrials, nextAfter, stepQueue, trialQueue } from '@/utils/trialQueue'
import { useConfirm } from '@/components/common/useConfirm'
import { useEditor } from './editorContext'
import { useSceneVideoTarget } from '@/utils/editorSceneSync'
import { useSceneStore } from '@/stores/sceneStore'
import { useEditorSettings } from '@/stores/editorSettings'
import { wantedSceneProject } from '@/utils/trialScene'

/** Filter value for trials without a project (not a valid project name, so it cannot collide). */
const UNASSIGNED_FILTER = ' '
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const num = (v: number | null, digits: number, unit = '') => v === null ? '—' : `${v.toFixed(digits)}${unit}`
/**
 * Unsaved rating forms per trial id, kept while the page is open so switching
 * trials (the detail view remounts) or candidates does not lose them. Cleared on save.
 */
const drafts = new Map<string, RatingForm>()

/**
 * "AI trials": trials that a local agent dropped into hapbeat-agent/inbox/, their
 * candidates (audition / adopt) and the rating form. Polling is driven by WaveformEditor.
 * The dock keeps it mounted while its tab is in the background, so selection and
 * unsaved ratings survive tab switches.
 * Selection and audition live in agentTrialStore so MCP requests can drive them too.
 */
export function AgentTrialsPanel() {
  const { t } = useI18n()
  const { playbackDevices, linkSceneProject } = useEditor()
  /** Trial picked by a click in the list: its first candidate is auditioned (not played) once its audio is loaded. */
  const [autoTrialId, setAutoTrialId] = useState<string | null>(null)
  /** `interactive` (a click): may ask for the game folder; automatic opens only use an already permitted one. */
  const pickTrial = (r: TrialRecord, interactive = true) => {
    setSelectedId(r.trial.id)
    setAutoTrialId(r.trial.id)
    // The Scene video (window or docked panel, never opened here) switches to this trial's moment.
    useSceneVideoTarget.getState().setTarget({ kind: 'trial', trialId: r.trial.id })
    const wanted = wantedSceneProject({ scene: r.trial.scene, saved: useEditorSettings.getState().trialScenes[r.trial.id], fallback: r.trial.project })
    const scene = useSceneStore.getState()
    // Same as "▶ Video": this click may grant the folder permission or link the folder once.
    if (wanted && scene.lib?.project_name !== wanted) {
      if (interactive) void linkSceneProject(wanted, { quietIfRefused: true }); else void useSceneStore.getState().linkProject(wanted, false)
    }
  }
  const deviceNames = useMemo(() => [...new Set(playbackDevices.map(device => device.name).filter(Boolean))], [playbackDevices])
  /** '' = every trial; otherwise the trial's `project` (UNASSIGNED_FILTER = trials without one). */
  /** Remembered in the editor UI settings (localStorage, folder copy, export). */
  const projectFilter = useEditorSettings(s => s.trialProjectFilter)
  const setProjectFilter = (value: string) => useEditorSettings.getState().update({ trialProjectFilter: value })
  const trials = useAgentTrialStore(s => s.trials)
  const folder = useAgentTrialStore(s => s.folder)
  const polling = useAgentTrialStore(s => s.polling)
  const lastResult = useAgentTrialStore(s => s.lastResult)
  const dimensions = useAgentTrialStore(s => s.dimensions)
  const storeError = useAgentTrialStore(s => s.error)
  const selectedId = useAgentTrialStore(s => s.selectedTrialId)
  const setSelectedId = useAgentTrialStore(s => s.selectTrial)
  const audition = useAgentTrialStore(s => s.audition)
  const onAudition = useAgentTrialStore(s => s.startAudition)
  const { isConnected } = useHelperConnection()
  // lastResult only covers the latest poll, so rejections are kept until dismissed.
  const [rejected, setRejected] = useState<{ file: string; error: string }[]>([])
  useEffect(() => {
    const fresh = lastResult?.rejected ?? []
    if (fresh.length) setRejected(list => [...list, ...fresh.filter(r => !list.some(o => o.file === r.file && o.error === r.error))])
  }, [lastResult])
  useEffect(() => { setRejected([]) }, [folder])
  const record = trials.find(r => r.trial.id === selectedId) ?? null
  const projects = useMemo(() => [...new Set(trials.map(r => r.trial.project).filter((p): p is string => !!p))].sort((a, b) => a.localeCompare(b)), [trials])
  const targetFilter = useEditorSettings(s => s.trialTargetFilter)
  const shown = useMemo(() => filterTrials(trials, projectFilter, targetFilter), [trials, projectFilter, targetFilter])
  // Work top-down: the unrated, not dismissed trials of the project, oldest first.
  const queue = useMemo(() => trialQueue(shown), [shown])
  const inQueue = !!record && queue.some(r => r.trial.id === record.trial.id)
  // Opening the tab / changing project / finishing the shown trial: open the oldest unrated one (no folder prompt without a click).
  useEffect(() => {
    if (!folder || (record && shown.includes(record))) return
    if (queue[0]) pickTrial(queue[0], false)
  }, [folder, projectFilter, targetFilter, record, shown, queue])
  const [done, setDone] = useState<(DoneInfo & { record: TrialRecord }) | null>(null)
  const decided = useEventStore(s => s.result)
  const onDone = (info: DoneInfo) => {
    const finished = trials.find(r => r.trial.id === info.recordId)
    if (finished) setDone({ ...info, record: finished })
    const next = nextAfter(queue, info.recordId)
    if (next) pickTrial(next, false); else setSelectedId(null)
  }
  const prev = stepQueue(queue, record?.trial.id ?? null, -1), next = stepQueue(queue, record?.trial.id ?? null, 1)
  const autoSend = useEditorSettings(s => s.autoSendOnRating)
  const { openSceneVideo } = useEditor()
  const { ask, dialog } = useConfirm()
  const [panelNotice, setPanelNotice] = useState('')
  const dismiss = async (r: TrialRecord) => {
    try {
      await useAgentTrialStore.getState().setDismissed(r.trial.id, true); drafts.delete(r.trial.id)
      await clearRatingDraft(useWaveformStore.getState().folder?.root ?? null, r.trial.id).catch(() => {})
      onDone({ recordId: r.trial.id, notes: [], assignedId: null, kind: 'dismissed' })
    } catch (error) { setPanelNotice(message(error)) }
  }
  const restore = async (r: TrialRecord) => {
    try { await useAgentTrialStore.getState().setDismissed(r.trial.id, false) } catch (error) { setPanelNotice(message(error)) }
  }
  /** History > "dismiss every unrated trial of this project" (confirmed; each can be restored from History). */
  const dismissAll = async () => {
    if (!queue.length || !await ask({ message: t('editor.agent.dismissAllConfirm', { count: queue.length }), danger: true })) return
    try {
      for (const r of queue) { drafts.delete(r.trial.id); await clearRatingDraft(useWaveformStore.getState().folder?.root ?? null, r.trial.id).catch(() => {}) }
      await useAgentTrialStore.getState().dismissMany(queue.map(r => r.trial.id)); setSelectedId(null)
    } catch (error) { setPanelNotice(message(error)) }
  }
  const target = record ? trialTarget(record.trial) : null
  const what = record ? (record.trial.scene ? record.trial.scene.cues.join(' + ') : record.trial.terms.join(' · ')) : ''
  return <div className="agent-panel">
    {dialog}
    {/* One line: watcher / MCP state, project and target filters. */}
    <div className="agent-topline">
      <span className={`agent-status ${storeError ? 'error' : ''}`} role="status" title={storeError ?? ''}>{storeError ?? t(!folder ? 'editor.agent.noFolder' : polling ? 'editor.agent.watching' : 'editor.agent.paused')}</span>
      <span className={`agent-mcp-status ${isConnected && folder ? 'ready' : ''}`} title={t('editor.agent.mcpHint')}>{t(!isConnected ? 'editor.agent.mcpHelperOff' : folder ? 'editor.agent.mcpReady' : 'editor.agent.mcpNoFolder')}</span>
      {projects.length > 0 && <select className="agent-filter" value={projectFilter} aria-label={t('editor.project')} title={t('editor.project')} onChange={e => {
        const value = e.target.value
        setProjectFilter(value)
        // Choosing a project also links its game footage (registered folder, else one folder pick; refusals are not asked again).
        if (value && value !== UNASSIGNED_FILTER) void linkSceneProject(value, { quietIfRefused: true })
      }}>
        <option value="">{t('editor.allProjects')}</option>
        {projects.map(name => <option key={name} value={name}>{name}</option>)}
        <option value={UNASSIGNED_FILTER}>{t('editor.unassigned')}</option>
      </select>}
      <select className="agent-filter" value={targetFilter} aria-label={t('editor.agent.targetFilter')} title={t('editor.agent.targetFilter')}
        onChange={e => useEditorSettings.getState().update({ trialTargetFilter: e.target.value as '' | 'sound' | 'haptic' })}>
        <option value="">{t('editor.agent.targetAll')}</option>
        <option value="sound">{t('editor.agent.targetSound')}</option>
        <option value="haptic">{t('editor.agent.targetHaptic')}</option>
      </select>
    </div>
    {folder && <AgentMessageBox record={record ?? trials[0] ?? null} />}
    {/* One line: ‹ T9 › · what · [sound|haptic] · n left · History · Video · Dismiss. */}
    <div className="agent-queue-nav">
      <button type="button" className="toolbar-btn" disabled={!prev} aria-label={t('editor.agent.prevTrial')} title={t('editor.agent.prevTrial')} onClick={() => prev && pickTrial(prev)}>‹</button>
      <span className="agent-short-id large" title={record?.trial.id ?? ''}>{record?.shortId ?? '—'}</span>
      <button type="button" className="toolbar-btn" disabled={!next} aria-label={t('editor.agent.nextTrial')} title={t('editor.agent.nextTrial')} onClick={() => next && pickTrial(next)}>›</button>
      {record && <span className="agent-what" title={what}>{t(target === 'sound' ? 'editor.agent.rateSound' : 'editor.agent.rateHaptic', { what })}</span>}
      {record && <span className={`agent-target-badge ${target}`}>{t(target === 'sound' ? 'editor.agent.targetSound' : 'editor.agent.targetHaptic')}</span>}
      <span className="agent-remaining">{record && !inQueue ? t(record.dismissed ? 'editor.agent.fromHistoryDismissed' : 'editor.agent.fromHistory') : t('editor.agent.remaining', { count: queue.length })}</span>
      <EditorMenu label={`${t('editor.agent.history')} ▾`} title={t('editor.agent.historyHint')} className="agent-history">
        {shown.length === 0 && <p className="editor-menu-note">{t('editor.agent.empty')}</p>}
        {shown.map(r => <EditorMenuItem key={r.trial.id} checked={r.trial.id === selectedId} onSelect={() => pickTrial(r)}>
          <span className="agent-short-id">{r.shortId ?? ''}</span> {r.trial.scene ? r.trial.scene.cues.join(' + ') : r.trial.terms.join(' · ')}
          <small className="agent-history-state">{t(trialTarget(r.trial) === 'sound' ? 'editor.agent.targetSound' : 'editor.agent.targetHaptic')} · {t(r.dismissed ? 'editor.agent.dismissedBadge' : r.rating ? 'editor.agent.rated' : 'editor.agent.unrated')}</small>
        </EditorMenuItem>)}
        <EditorMenuItem disabled={!queue.length} onSelect={() => void dismissAll()}>{t('editor.agent.dismissAll', { count: queue.length })}</EditorMenuItem>
      </EditorMenu>
      {record && <button className="toolbar-btn" title={t('editor.scene.openHint')}
        onClick={() => openSceneVideo({ kind: 'trial', trialId: record.trial.id }, wantedSceneProject({ scene: record.trial.scene, saved: useEditorSettings.getState().trialScenes[record.trial.id], fallback: record.trial.project }) ?? null)}>▶ {t('editor.agent.video')}</button>}
      {record && (record.dismissed ? <button className="toolbar-btn" onClick={() => void restore(record)}>{t('editor.agent.restore')}</button>
        : !record.rating && <button className="toolbar-btn" title={t('editor.agent.dismissHint')} onClick={() => void dismiss(record)}>{t('editor.agent.dismissTrial')}</button>)}
    </div>
    {panelNotice && <p className="agent-muted" role="status">{panelNotice}</p>}
    {trials.length === 0 && rejected.length === 0 && <p className="agent-muted">{t('editor.agent.empty')}</p>}
    {rejected.map(r => <div key={`${r.file}\n${r.error}`} className="agent-rejected">
      <strong>{t('editor.agent.rejected', { file: r.file })}</strong>
      <button className="toolbar-btn" onClick={() => setRejected(list => list.filter(o => o !== r))}>{t('editor.agent.dismiss')}</button>
      <small>{r.error}</small><small>{t('editor.agent.rejectedHint')}</small>
    </div>)}
    {done && <div className="agent-done" role="status">
      <div className="agent-done-head">{t(done.kind === 'dismissed' ? 'editor.agent.doneDismissed' : 'editor.agent.doneRated', { id: done.record.shortId ?? done.record.trial.id })}
        <button type="button" className="toolbar-btn" onClick={() => setDone(null)}>{t('common.close')}</button></div>
      {done.notes.map(n => <p key={n} className="agent-muted">{n}</p>)}
      {decided && decided.id === done.assignedId && <DecidedNotice result={decided} />}
      {done.kind === 'rated' && !autoSend && <AgentMessageBox record={done.record} saved />}
    </div>}
    {record ? <TrialDetail key={record.trial.id} record={record} dimensions={dimensions} known={trials} audition={audition} onAudition={onAudition} deviceNames={deviceNames} onSelectTrial={setSelectedId}
      autoAudition={autoTrialId === record.trial.id} onAutoAuditioned={() => setAutoTrialId(null)} onDone={onDone} />
      : <p className="agent-muted">{t(trials.length ? 'editor.agent.allDone' : 'editor.agent.selectTrial')}</p>}
  </div>
}

/** What the last save / dismissal did (shown by the panel above the next trial). */
interface DoneInfo { recordId: string; notes: string[]; assignedId: number | null; kind: 'rated' | 'dismissed' }

function TrialDetail({ record, dimensions, known, audition, onAudition, deviceNames, onSelectTrial, autoAudition, onAutoAuditioned, onDone }: {
  record: TrialRecord; dimensions: DimensionsDoc | null; known: TrialRecord[]; audition: AuditionTarget | null
  onAudition: (target: AuditionTarget, buffer: AudioBuffer) => void; deviceNames: string[]; onSelectTrial: (id: string) => void
  /** After a save or a dismissal: the panel moves on. */
  onDone: (done: DoneInfo) => void
  /** Set after a click in the trial list: audition the first candidate (no playback) and bring the waveform forward. */
  autoAudition: boolean; onAutoAuditioned: () => void
}) {
  const { t } = useI18n()
  const { focusEditorPanel, player, pending, toggleCandidate } = useEditor()
  /** The editor playback is sounding (the ▶ / ■ of the auditioned card). */
  const [playing, setPlaying] = useState(false)
  useEffect(() => {
    setPlaying(player.isPlaying())
    const unsubs = [player.on('play', () => setPlaying(true)), player.on('pause', () => setPlaying(false)), player.on('finish', () => setPlaying(false))]
    return () => unsubs.forEach(unsub => unsub())
  }, [player])
  const { trial, rating } = record
  const ids = useId()
  const editorFolder = useWaveformStore(s => s.folder)
  const processing = useWaveformStore(s => s.isProcessing)
  // Unsaved form: this page's memory first, else the draft kept across reloads (localStorage now, the folder copy below).
  const [localDraft] = useState(() => drafts.has(trial.id) ? null : readLocalDraft(trial))
  const [form, setForm] = useState<RatingForm>(() => drafts.get(trial.id) ?? localDraft?.form ?? ratingToForm(trial, rating, loadRememberedContext()))
  const [dirty, setDirty] = useState(() => drafts.has(trial.id) || !!localDraft)
  /** The form came from a stored draft (shown until it is saved). */
  const [restored, setRestored] = useState(!!localDraft)
  const touchedSinceMount = useRef(false)
  useEffect(() => {
    if (drafts.has(trial.id) || !editorFolder) return
    let cancelled = false
    void readFolderDraft(editorFolder.root, trial).then(found => {
      if (cancelled || touchedSinceMount.current || !found || newerDraft(localDraft, found) !== found || found === localDraft) return
      setForm(found.form); setDirty(true); setRestored(true)
    })
    return () => { cancelled = true }
  }, [trial.id, editorFolder])
  // Every change is kept as a draft (debounced) in the editor folder and localStorage.
  useEffect(() => {
    if (!dirty) return
    const timer = setTimeout(() => { void writeRatingDraft(editorFolder?.root ?? null, trial.id, form, localIsoString(new Date())).catch(() => {}) }, DRAFT_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [form, dirty, trial.id, editorFolder])
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  // Re-sync with disk after a save (or a rating written elsewhere), not on every poll.
  // The first run is the mount: keep a draft restored above.
  const mounted = useRef(false)
  useEffect(() => {
    if (!mounted.current) { mounted.current = true; return }
    drafts.delete(trial.id); setForm(ratingToForm(trial, rating, loadRememberedContext())); setDirty(false)
  }, [rating?.ratedAt])
  useEffect(() => { if (dirty) drafts.set(trial.id, form); else drafts.delete(trial.id) }, [form, dirty, trial.id])
  const [audio, setAudio] = useState<Record<string, AudioBuffer | { error: string }>>({})
  const renderable = record.candidates.filter(c => c.audio && !c.error).map(c => c.id).join(',')
  useEffect(() => {
    let cancelled = false
    for (const cid of renderable ? renderable.split(',') : []) void useAgentTrialStore.getState().loadCandidateAudio(trial.id, cid)
      .then(buffer => { if (!cancelled) setAudio(a => ({ ...a, [cid]: buffer })) }, error => { if (!cancelled) setAudio(a => ({ ...a, [cid]: { error: message(error) } })) })
    return () => { cancelled = true }
  }, [trial.id, renderable])
  const first = trial.candidates[0]?.id
  const firstAudio = first ? audio[first] : undefined
  useEffect(() => {
    if (!autoAudition || !first || !firstAudio) return
    onAutoAuditioned()
    if ('error' in firstAudio || audition?.trialId === trial.id) return
    onAudition({ trialId: trial.id, candidateId: first }, firstAudio)
    focusEditorPanel('waveform')
  }, [autoAudition, first, firstAudio])

  // Device names and body volume come from the helper (playback targets); typed only when it cannot tell.
  const { targets } = useEditor()
  const { devices } = useHelperConnection()
  const auto = useMemo(() => autoRatingContext(devices, targets), [devices, targets])
  const sceneLib = useSceneStore(s => s.lib)
  const sceneTable = useSceneStore(s => s.table)
  const kind: TrialKind | null = trialKind(trial, record.candidates.map(c => c.features?.durationSec),
    sceneLib && trial.scene?.project === sceneLib.project_name ? sceneLib.loop_cues : [])
  /** Sound trials rate overall / term match / comment only (no haptic dimensions or device conditions). */
  const target = trialTarget(trial)
  /** Axes to rate: the sound set for a sound trial, else the haptic dimensions without pleasantness (repetition only for loop / sequence). */
  const axes = useMemo(() => target === 'sound' ? SOUND_DIMENSIONS : dimensions ? visibleDimensions(dimensions.dimensions, kind) : [], [dimensions, kind, target])
  /** The event of the open Scene project this trial is for (its first scene cue), if any. */
  const event = sceneLib && sceneTable && trial.scene?.project === sceneLib.project_name ? trialEvent(sceneTable, trial.scene) : null
  const soundFirst = target === 'haptic' && !!event && !!sceneLib && !!sceneTable && !isLoopCue(sceneLib, parseEventKey(event).cue) && !effectiveEvent(sceneTable, parseEventKey(event))?.sfx
  const marks = useEditorSettings(s => s.eventMarks)
  /** The waveform selection while a candidate is auditioned: recorded as its "use only this part" range. */
  const selection = useWaveformStore(s => s.selectedRegion)
  const edit = (update: (f: RatingForm) => RatingForm) => { touchedSinceMount.current = true; setForm(update); setDirty(true); setSaveError(null) }
  const editCandidate = (cid: string, patch: Partial<CandidateRatingForm>) => edit(f => ({ ...f, candidates: { ...f.candidates, [cid]: { ...f.candidates[cid], ...patch } } }))
  const issue = ratingFormIssue(form)
  const autoSend = useEditorSettings(s => s.autoSendOnRating)
  /** The best candidate becomes the sound / haptic of the trial's events (rating save with "assign on save"). */
  const autoAssign = useEditorSettings(s => s.autoAssignOnRating)
  const assignBest = async (best: string): Promise<{ note?: string; assignedId?: number }> => {
    const scene = useSceneStore.getState()
    if (!scene.table || !scene.lib || scene.lib.project_name !== trial.scene!.project) return { note: t('events.auto.noProject', { project: trial.scene!.project }) }
    const events = assignEventsForTrial(scene.table, scene.lib, trial.scene!.cues, target)
    if (!events.length) return { note: t('events.auto.noEvents', { cues: trial.scene!.cues.join(', ') }) }
    try {
      const r = await runDecision({ target, source: { kind: 'candidate', trialId: trial.id, candidateId: best }, events, name: null, at: null, gain: 1 })
      return r.ok ? { assignedId: r.result.id } : { note: t(r.notice.id, r.notice.params) }
    } catch (error) { return { note: message(error) } }
  }
  /** Saves, then (auto-assign / auto-send) and hands over to the panel, which moves to the next unrated trial and shows what happened. */
  const save = async () => {
    if (issue || saving) return
    setSaving(true)
    const withAuto = target === 'sound' ? { ...form, context: EMPTY_CONTEXT } : { ...form, context: { ...form.context, ...(auto.device ? { device: auto.device } : {}),
      ...(auto.deviceWiper !== null ? { deviceWiper: String(auto.deviceWiper), volumeLabel: auto.volumeLabel } : { volumeLabel: '' }) } }
    const body = formToRating(withAuto, trial, localIsoString(new Date()))
    try {
      await useAgentTrialStore.getState().saveRating(trial.id, body); if (target === 'haptic') rememberContext(withAuto.context); drafts.delete(trial.id); setDirty(false); setRestored(false)
      await clearRatingDraft(editorFolder?.root ?? null, trial.id).catch(() => {})
    } catch (error) { setSaveError(message(error)); setSaving(false); return }
    setSaving(false)
    const notes: string[] = []
    let assignedId: number | null = null
    if (autoSend) {
      try { await useAgentTrialStore.getState().sendAgentMessage(messageFor(record, t('editor.agent.msgSaved', { id: trialName(record) }))); notes.push(t('editor.agent.msgAutoSent')) }
      catch (error) { notes.push(t('editor.agent.msgFailed', { message: message(error) })) }
    }
    const usable = usableCandidates(withAuto)
    if (usable.length >= 2 && !body.best) notes.push(t('editor.agent.severalUsable', { ids: usable.map(id => record.shortId ? `${record.shortId}-${id}` : id).join(', ') }))
    // Auto-assign only a unique top "use" candidate (written as best); otherwise the notice above asks to consult the agent.
    if (body.best && trial.scene && autoAssign) { const r = await assignBest(body.best); if (r.note) notes.push(r.note); assignedId = r.assignedId ?? null }
    else if (trial.scene && autoAssign && usable.length === 1 && !body.best) notes.push(t('editor.agent.useNeedsOverall'))
    onDone({ recordId: trial.id, notes, assignedId, kind: 'rated' })
  }
  const adopt = async (cid: string, label: string) => {
    try { await useAgentTrialStore.getState().adoptCandidate(trial.id, cid); setNotice(t('editor.agent.adopted', { name: label })) }
    catch (error) { setNotice(message(error)) }
  }
  const issueText = issue?.kind === 'missing-overall' ? t('editor.agent.missingOverall', { id: issue.candidateId })
    : issue?.kind === 'bad-wiper' ? t('editor.agent.badWiper') : t('editor.agent.noneRated')
  const volumeText = (wiper: number, label: string) => {
    const [level, steps] = label.split('/')
    return label ? t('editor.agent.volumeWithSteps', { wiper, level, steps }) : t('editor.agent.deviceWiperOnly', { wiper })
  }
  const saveStatus = saveError ? t('editor.agent.saveFailed', { message: saveError }) : dirty ? `${restored ? t('editor.agent.draftRestored') + ' ' : ''}${issue ? issueText : t('editor.agent.unsaved')}`
    : rating ? t('editor.agent.saved', { time: new Date(rating.ratedAt).toLocaleString() }) : issueText
  /** One word in the save line; the sentence is its title. */
  const shortStatus = saveError ? t('editor.agent.statusError') : issue ? t(issue.kind === 'bad-wiper' ? 'editor.agent.statusWiper' : 'editor.agent.statusNeedsScore')
    : dirty ? t(restored ? 'editor.agent.statusDraft' : 'editor.agent.statusUnsaved') : rating ? t('editor.agent.statusSaved') : ''
  const contextField = (key: keyof RatingForm['context'], label: string, list?: string) =>
    <label className="agent-field">{label}<input list={list} value={form.context[key]} onChange={e => { const value = e.target.value; edit(f => ({ ...f, context: { ...f.context, [key]: value } })) }} /></label>

  return <div className="agent-detail">
    {/* The request in one line (rationale, words and parent on hover). */}
    <p className="agent-prompt" title={[trial.prompt, trial.rationale, `${t('editor.agent.terms')}: ${trial.terms.join(', ')}`, trial.parentTrial && `${t('editor.agent.parent')}: ${trial.parentTrial}`, `${t('editor.agent.received')}: ${new Date(trial.receivedAt).toLocaleString()}`].filter(Boolean).join('\n')}>
      {trial.terms.map(term => <span className="agent-chip" key={term}>{term}</span>)}{trial.prompt}
      {trial.parentTrial && known.some(r => r.trial.id === trial.parentTrial) && <button className="agent-link" onClick={() => onSelectTrial(trial.parentTrial!)}>↖ {known.find(r => r.trial.id === trial.parentTrial)?.shortId ?? trial.parentTrial}</button>}
    </p>
    {kind === 'sequence' && <p className="agent-muted">{t('editor.agent.sequenceNote')}</p>}
    {soundFirst && <p className="events-hint">{t('events.soundFirst')}</p>}
    <div className="agent-notice" role="status">{notice}</div>
    <div className="agent-candidates">
      {trial.candidates.map(requested => {
        const file = record.candidates.find(c => c.id === requested.id)
        const loaded = audio[requested.id], buffer = loaded && !('error' in loaded) ? loaded : null
        const active = audition?.trialId === trial.id && audition.candidateId === requested.id
        // Clicking anywhere on the card (except its own controls) auditions it in the waveform panel.
        const select = (event: { target: EventTarget }) => {
          if (!buffer || active || (event.target as HTMLElement).closest('button, input, select, textarea, label, a')) return
          onAudition({ trialId: trial.id, candidateId: requested.id }, buffer)
        }
        const sounding = active && (playing || pending)
        return <article key={requested.id} className={`agent-candidate ${active ? 'auditioning' : ''} ${sounding ? 'playing' : ''} ${buffer ? 'selectable' : ''}`} aria-current={active || undefined} onClick={select}
          tabIndex={0} data-trial-id={trial.id} data-candidate-id={requested.id}>
          {/* Line 1: ▶ id label · overall ★ · derived verdict · marks / actions. Line 2: direction axes (grid) · comment · kept ranges. */}
          <div className="agent-card-row">
            <button className="toolbar-btn agent-play-btn" disabled={!file?.audio || !!file?.error} aria-label={t(sounding ? 'wave.stop' : 'wave.play')} title={t('editor.agent.playHint')}
              onClick={() => toggleCandidate(trial.id, requested.id)}>
              <span className="transport-label-stack" aria-hidden="true"><span style={{ visibility: sounding ? 'hidden' : 'visible' }}>▶</span><span style={{ visibility: sounding ? 'visible' : 'hidden' }}>■</span></span>
            </button>
            <strong className="agent-short-id" title={t('editor.agent.shortIdHint')}>{record.shortId ? `${record.shortId}-${requested.id}` : requested.id}</strong>
            <span className="agent-card-name" title={[requested.label, requested.hypothesis, requested.method && t(`editor.agent.method.${requested.method}` as MessageId)].filter(Boolean).join('\n')}>{requested.label}</span>
            <span className="agent-thumb" title={featureText(file?.features ?? null)}>{buffer ? <WaveformThumbnail buffer={buffer} />
              : <small className={file?.error || loaded ? 'error' : ''}>{file?.error ? t('editor.agent.renderError', { message: file.error }) : loaded && 'error' in loaded ? loaded.error : file ? t('editor.agent.loadingAudio') : ''}</small>}</span>
            <Stars value={form.candidates[requested.id].overall} onChange={overall => editCandidate(requested.id, { overall })} />
            <VerdictTag overall={form.candidates[requested.id].overall} />
            {(marks[`${trial.id}/${requested.id}`] ?? []).map(m => <span key={`${m.project}:${m.event}:${m.target}`} className="editor-event-badge" title={m.project}>{m.target === 'sound' ? '♪' : '≋'} {m.event}</span>)}
            {/* By hand only (saving the rating assigns automatically): copy into the clip list / assign to the event. */}
            <button type="button" className="agent-icon-btn" disabled={!editorFolder || processing} title={t('editor.agent.toClipHint')} aria-label={t('editor.agent.toClipHint')}
              onClick={() => void adopt(requested.id, requested.label)}>{t('editor.agent.toClip')}</button>
            <button type="button" className="agent-icon-btn" disabled={!buffer} title={t(target === 'sound' ? 'editor.agent.toEventSoundHint' : 'editor.agent.toEventHapticHint')}
              aria-label={t(target === 'sound' ? 'editor.agent.toEventSoundHint' : 'editor.agent.toEventHapticHint')}
              onClick={() => useEventStore.getState().requestDecide({ target, source: { kind: 'candidate', trialId: trial.id, candidateId: requested.id }, event })}>{t('editor.agent.toEvent')}</button>
          </div>
          <div className="agent-card-row2">
            <Directions value={form.candidates[requested.id]} axes={axes} onChange={patch => editCandidate(requested.id, patch)} />
            <CandidateNotes value={form.candidates[requested.id]} onChange={patch => editCandidate(requested.id, patch)} selection={active ? selection : null} />
          </div>
        </article>
      })}
    </div>
    <div className="agent-trial-rating">
      {target === 'haptic' && <fieldset className="agent-context" title={t('editor.agent.context')}>
        {auto.device ? <div className="agent-field agent-field-auto" title={t('editor.agent.autoHint')}>{t('editor.agent.device')}<output>{auto.device}</output></div> : contextField('device', t('editor.agent.device'), `${ids}-devices`)}
        {contextField('position', t('editor.agent.position'), `${ids}-positions`)}
        {auto.deviceWiper !== null
          ? <div className="agent-field agent-field-auto" title={t('editor.agent.autoHint')}>{t('editor.agent.volume')}<output>{volumeText(auto.deviceWiper, auto.volumeLabel)}</output></div>
          : <label className="agent-field" title={t('editor.agent.wiperHint')}>{t('editor.agent.deviceWiper')}<input type="number" min={0} max={127} step={1} value={form.context.deviceWiper} onChange={e => { const value = e.target.value; edit(f => ({ ...f, context: { ...f.context, deviceWiper: value } })) }} /></label>}
        {contextField('note', t('editor.agent.note'))}
        <datalist id={`${ids}-devices`}>{deviceNames.map(name => <option key={name} value={name} />)}</datalist>
        <datalist id={`${ids}-positions`}>{POSITION_SUGGESTIONS.map(p => <option key={p} value={p} />)}</datalist>
      </fieldset>}
      {/* One line: [Save and next] ☑ assign ☑ send · status (the full reason on hover). */}
      <div className="agent-save">
        <span title={issue ? issueText : ''}><button className="apply-effects-btn" disabled={!!issue || saving || (!dirty && !!rating)} onClick={() => void save()}>{t('editor.agent.saveNext')}</button></span>
        {trial.scene && <label className="agent-auto-assign" title={t('events.auto.hint')}>
          <input type="checkbox" checked={autoAssign} onChange={e => useEditorSettings.getState().update({ autoAssignOnRating: e.target.checked })} />{t('editor.agent.assignShort')}</label>}
        <label className="agent-auto-assign" title={t('editor.agent.msgAutoHint')}>
          <input type="checkbox" checked={autoSend} onChange={e => useEditorSettings.getState().update({ autoSendOnRating: e.target.checked })} />{t('editor.agent.sendShort')}</label>
        <span className={`agent-save-status ${saveError ? 'error' : !dirty && rating ? 'saved' : ''}`} role="status" title={saveStatus}>{shortStatus}</span>
      </div>
    </div>
  </div>
}

/** Feature numbers of a candidate (shown as the thumbnail's tooltip). */
function featureText(f: HapticFeatures | null): string {
  if (!f) return ''
  return `centroid ${num(f.centroidHz, 0, ' Hz')} · AM ${num(f.amRateHz, 1, ' Hz')} / ${num(f.amDepth, 2)} · flatness ${num(f.flatness, 2)} · ${num(f.durationSec, 2, ' s')}`
}

/** Overall 1–5 as stars (click the same star again to clear). */
function Stars({ value, onChange }: { value: number | null; onChange: (value: number | null) => void }) {
  const { t } = useI18n()
  return <span className="agent-stars" role="group" aria-label={t('editor.agent.overall')} title={t('editor.agent.overallHint')}>
    {[1, 2, 3, 4, 5].map(n => <button key={n} type="button" className={`agent-star ${value !== null && n <= value ? 'on' : ''}`} aria-pressed={value === n} aria-label={`${n}`}
      onClick={() => onChange(value === n ? null : n)}>★</button>)}
  </span>
}

/** The verdict written with the rating, derived from the overall score (4–5 use, 3 maybe, 1–2 no). Fixed width. */
function VerdictTag({ overall }: { overall: number | null }) {
  const { t } = useI18n()
  const v = verdictFromOverall(overall)
  return <small className={`agent-verdict-tag ${v ?? ''}`} title={t('editor.agent.verdictHint')}>{v ? t(`editor.agent.verdict.${v}` as MessageId) : ''}</small>
}

/** "How to change it": per axis `low [−][・][+] high`, buttons without text (title "more …"); a grid of 2–3 columns. */
function Directions({ value, axes, onChange }: { value: CandidateRatingForm; axes: Dimension[]; onChange: (patch: Partial<CandidateRatingForm>) => void }) {
  const { t, locale } = useI18n()
  const setDirection = (dim: string, v: Direction) => {
    const directions = { ...value.directions }
    if (directions[dim] === v) delete directions[dim]; else directions[dim] = v
    onChange({ directions })
  }
  if (!axes.length) return null
  return <div className="agent-axes" aria-label={t('editor.agent.directions')}>
    {axes.map(d => {
      const [low, high] = d.poles[locale]
      const hint = DIMENSION_HINTS[d.id] ? t(DIMENSION_HINTS[d.id]) : t('editor.agent.dimHint.generic', { low, high })
      const more = (p: string) => locale === 'ja' ? t('editor.agent.more', { pole: jaPolePhrase(p) }) : t('editor.agent.more', { pole: p })
      const titles: Record<Direction, string> = { [-1]: more(low), 0: t('editor.agent.fine'), 1: more(high) }
      return <div className="agent-axis" key={d.id} title={`${locale === 'ja' ? d.ja : d.en}: ${hint}`}>
        <span className="agent-axis-pole">{low}</span>
        {([-1, 0, 1] as Direction[]).map(v => <button key={v} type="button" className={`agent-axis-btn ${value.directions[d.id] === v ? 'selected' : ''}`} aria-pressed={value.directions[d.id] === v}
          title={titles[v]} aria-label={titles[v]} onClick={() => setDirection(d.id, v)}>{v === 0 ? '·' : v < 0 ? '−' : '+'}</button>)}
        <span className="agent-axis-pole">{high}</span>
      </div>
    })}
  </div>
}

/** Short "what this rates" tooltips for the seed dimensions; others get a generic low ↔ high line. */
const DIMENSION_HINTS: Record<string, MessageId> = {
  roughness: 'editor.agent.dimHint.roughness', weight: 'editor.agent.dimHint.weight', sharpness: 'editor.agent.dimHint.sharpness',
  intensity: 'editor.agent.dimHint.intensity', regularity: 'editor.agent.dimHint.regularity', continuity: 'editor.agent.dimHint.continuity',
}

/** Comment (one line, grows) and kept ranges (small). */
function CandidateNotes({ value, onChange, selection }: {
  value: CandidateRatingForm; onChange: (patch: Partial<CandidateRatingForm>) => void
  /** The waveform range selected on this candidate (only while it is the auditioned one). */
  selection: { start: number; end: number } | null
}) {
  const { t } = useI18n()
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { const el = ref.current; if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px` } }, [value.comment])
  return <div className="agent-notes">
    <textarea ref={ref} className="agent-comment" rows={1} placeholder={t('editor.agent.comment')} aria-label={t('editor.agent.comment')} value={value.comment} onChange={e => onChange({ comment: e.target.value })} />
    <span className="agent-use-range">
      <button className="agent-icon-btn" disabled={!selection || selection.end <= selection.start} title={t('editor.agent.useRangeHint')}
        onClick={() => { if (selection) onChange({ useRange: addUseRange(value.useRange, selection.start, selection.end) }) }}>{t('editor.agent.useRangeShort')}</button>
      {value.useRange.map((r, i) => <span key={`${r[0]}-${r[1]}`} className="agent-chip">{r[0].toFixed(2)}–{r[1].toFixed(2)}
        <button className="agent-chip-remove" aria-label={t('editor.agent.useRangeRemove')} title={t('editor.agent.useRangeRemove')} onClick={() => onChange({ useRange: value.useRange.filter((_, k) => k !== i) })}>✕</button></span>)}
    </span>
  </div>
}

/** Ids and project of a trial for an outbox message. */
function messageFor(record: TrialRecord, text: string) {
  const { trial } = record
  return { text, project: trial.project ?? trial.scene?.project, trialIds: [trial.id], shortIds: record.shortId ? [record.shortId] : undefined }
}
const trialName = (record: TrialRecord) => record.shortId ?? record.trial.id

/**
 * "Send to the agent": an optional short text (the default names the trial by
 * its short id) written to hapbeat-agent/outbox/ for the agent session to pick up.
 */
function AgentMessageBox({ record, saved }: { record: TrialRecord | null; saved?: boolean }) {
  const { t } = useI18n()
  const [text, setText] = useState('')
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null)
  const [sending, setSending] = useState(false)
  const fallback = !record ? t('editor.agent.msgGeneric') : saved || record.rating ? t('editor.agent.msgSaved', { id: trialName(record) }) : t('editor.agent.msgAbout', { id: trialName(record) })
  const send = async () => {
    setSending(true)
    try {
      const body = (text.trim() || fallback)
      await useAgentTrialStore.getState().sendAgentMessage(record ? messageFor(record, body) : { text: body })
      setText(''); setStatus({ ok: true, text: t('editor.agent.msgSent') })
    } catch (error) { setStatus({ ok: false, text: t('editor.agent.msgFailed', { message: message(error) }) }) }
    finally { setSending(false) }
  }
  return <div className="agent-message" title={t('editor.agent.msgHint')}>
    <input value={text} placeholder={fallback} aria-label={t('editor.agent.msgSend')} maxLength={4000}
      onChange={e => { setText(e.target.value); setStatus(null) }} onKeyDown={e => { if (e.key === 'Enter' && !sending) void send() }} />
    <button type="button" className="toolbar-btn" disabled={sending} onClick={() => void send()}>{t('editor.agent.msgSend')}</button>
    <span className={`agent-message-status ${status && !status.ok ? 'error' : ''}`} role="status">{status?.text ?? ''}</span>
  </div>
}
