import { useEffect, useId, useMemo, useRef, useState, type TextareaHTMLAttributes } from 'react'
import { useI18n, type MessageId } from '@/i18n/I18nProvider'
import { useAgentTrialStore, type AuditionTarget } from '@/stores/agentTrialStore'
import { useHelperConnection } from '@/hooks/useHelperConnection'
import { useWaveformStore } from '@/stores/waveformStore'
import { localIsoString, type TrialRecord } from '@/utils/hapticKnowledge'
import type { HapticFeatures } from '@/utils/hapticFeatures'
import { clearRatingDraft, DraftKeeper, readFolderDraft, readLocalDraft, writeRatingDraft } from '@/utils/ratingDrafts'
import { addUseRange, isFreePlanCandidate, poolCandidates, reserveCandidates, addReserves, autoRatingContext, EMPTY_CONTEXT, formToRating, initialIntensity, loadRememberedContext, ratingFormIssue, ratingToForm, rememberContext, trialKind, verdictFromOverall, type CandidateRatingForm, type RatingForm } from '@/utils/agentTrialUi'
import { trialTarget, type TrialKind } from '@/utils/agentProtocol'
import { useAuditionPlan } from './EditorScenePanel'
import { BODY_POSITIONS, resolvePlaybackTargets, routePlaybackTargets } from '@/utils/playbackDevices'
import { useDeviceStore } from '@/stores/deviceStore'
import { appendActivity } from '@/utils/activityLog'
import { useToast } from '@/components/common/Toast'
import { toFirstPlay } from '@/utils/sceneSegments'
import { levelKey, useEventStore } from '@/stores/eventStore'
import { LevelSlider } from './LevelSlider'
import { assignEventsForTrial, candidateSound, companionSoundName, effectiveEvent, parseEventKey, trialEvent, cueRoutePositions } from '@/utils/cueEvents'
import { runDecision } from './eventDecide'
import { isLoopCue, sfxSounds } from '@/utils/sceneCueTable'
import { WaveformThumbnail } from './WaveformThumbnail'
import { EditorMenu, EditorMenuItem } from './EditorMenu'
import { filterTrials, nextAfter, stepQueue, trialQueue } from '@/utils/trialQueue'
import { useConfirm } from '@/components/common/useConfirm'
import { useEditor } from './editorContext'
import { useSceneVideoTarget } from '@/utils/editorSceneSync'
import { useSceneStore } from '@/stores/sceneStore'
import { useEditorSettings } from '@/stores/editorSettings'

/** Filter value for trials without a project (not a valid project name, so it cannot collide). */
const UNASSIGNED_FILTER = ' '
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const num = (v: number | null, digits: number, unit = '') => v === null ? '—' : `${v.toFixed(digits)}${unit}`
/**
 * Unsaved rating forms (see DraftKeeper): kept per trial across switches, reloads and
 * restarts (localStorage + `.hapbeat-editor/rating-drafts/<trialId>.json` of the open
 * editor folder), removed only when the rating is saved.
 */
const editorRoot = () => useWaveformStore.getState().folder?.root ?? null
const drafts = new DraftKeeper({
  readLocal: readLocalDraft,
  readFolder: async trial => { const root = editorRoot(); return root ? readFolderDraft(root, trial) : null },
  write: (trialId, form, savedAt) => writeRatingDraft(editorRoot(), trialId, form, savedAt),
  clear: trialId => clearRatingDraft(editorRoot(), trialId),
}, () => localIsoString(new Date()))
// Typing then closing / reloading the page within the debounce still keeps the last change.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') window.addEventListener('pagehide', () => drafts.flush())

/**
 * "AI trials": trials that a local agent dropped into hapbeat-agent/inbox/, their
 * candidates (audition / adopt) and the rating form. Polling is driven by WaveformEditor.
 * The dock keeps it mounted while its tab is in the background, so selection and
 * unsaved ratings survive tab switches.
 * Selection and audition live in agentTrialStore so MCP requests can drive them too.
 */
export function AgentTrialsPanel() {
  const { t } = useI18n()
  const { playbackDevices } = useEditor()
  /** Trial picked by a click in the list: its first candidate is auditioned (not played) once its audio is loaded. */
  const [autoTrialId, setAutoTrialId] = useState<string | null>(null)
  const pickTrial = (r: TrialRecord) => {
    setSelectedId(r.trial.id)
    setAutoTrialId(r.trial.id)
    // The Scene video (window or docked panel, never opened here) switches to this trial's moment;
    // its project stays the one open in the Events panel.
    useSceneVideoTarget.getState().setTarget({ kind: 'trial', trialId: r.trial.id })
  }
  const deviceNames = useMemo(() => [...new Set(playbackDevices.map(device => device.name).filter(Boolean))], [playbackDevices])
  /** '' = every trial; otherwise the trial's `project` (UNASSIGNED_FILTER = trials without one). */
  /** Remembered in the editor UI settings (localStorage, folder copy, export). */
  const projectFilter = useEditorSettings(s => s.trialProjectFilter)
  const setProjectFilter = (value: string) => useEditorSettings.getState().update({ trialProjectFilter: value })
  const trials = useAgentTrialStore(s => s.trials)
  useReserveBackfill(trials)
  const folder = useAgentTrialStore(s => s.folder)
  const polling = useAgentTrialStore(s => s.polling)
  const lastResult = useAgentTrialStore(s => s.lastResult)
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
  // Opening the tab / changing project / finishing the shown trial: open the oldest unrated one.
  useEffect(() => {
    if (!folder || (record && shown.includes(record))) return
    if (queue[0]) pickTrial(queue[0])
  }, [folder, projectFilter, targetFilter, record, shown, queue])
  const onDone = (info: DoneInfo) => {
    const next = nextAfter(queue, info.recordId)
    if (next) pickTrial(next); else setSelectedId(null)
  }
  const prev = stepQueue(queue, record?.trial.id ?? null, -1), next = stepQueue(queue, record?.trial.id ?? null, 1)
  const { openSceneVideo } = useEditor()
  const { ask, dialog } = useConfirm()
  const [panelNotice, setPanelNotice] = useState('')
  const dismiss = async (r: TrialRecord) => {
    try {
      // "Later" keeps any draft: the trial comes back from History with what was typed.
      await useAgentTrialStore.getState().setDismissed(r.trial.id, true)
      const root = useWaveformStore.getState().folder?.root
      if (root) void appendActivity(root, { at: localIsoString(new Date()), kind: 'dismissed', trialId: r.trial.id, ...(r.shortId ? { shortId: r.shortId } : {}) }).catch(() => {})
      onDone({ recordId: r.trial.id })
    } catch (error) { setPanelNotice(message(error)) }
  }
  const restore = async (r: TrialRecord) => {
    try { await useAgentTrialStore.getState().setDismissed(r.trial.id, false) } catch (error) { setPanelNotice(message(error)) }
  }
  /** History > "dismiss every unrated trial of this project" (confirmed; each can be restored from History). */
  const dismissAll = async () => {
    if (!queue.length || !await ask({ message: t('editor.agent.dismissAllConfirm', { count: queue.length }), danger: true })) return
    try {
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
    {/* One line: ‹ T9 › · what · [sound|haptic] · n left · History · Video · Dismiss. */}
    <div className="agent-queue-nav">
      <button type="button" className="toolbar-btn" disabled={!prev} aria-label={t('editor.agent.prevTrial')} title={t('editor.agent.prevTrial')} onClick={() => prev && pickTrial(prev)}>‹</button>
      <span className="agent-short-id large" title={record?.trial.id ?? ''}>{record?.shortId ?? '—'}</span>
      <button type="button" className="toolbar-btn" disabled={!next} aria-label={t('editor.agent.nextTrial')} title={t('editor.agent.nextTrial')} onClick={() => next && pickTrial(next)}>›</button>
      {record && <span className="agent-what" title={what}>{t(target === 'sound' ? 'editor.agent.rateSound' : 'editor.agent.rateHaptic', { what })}</span>}
      {record?.trial.scene && <span className="target-cue-badge" title={t('editor.scene.targetHint')}>{record.trial.scene.cues.join(' + ')}</span>}
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
        onClick={() => openSceneVideo({ kind: 'trial', trialId: record.trial.id })}>▶ {t('editor.agent.video')}</button>}
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
    {record ? <TrialDetail key={record.trial.id} record={record} known={trials} audition={audition} onAudition={onAudition} deviceNames={deviceNames} onSelectTrial={setSelectedId}
      autoAudition={autoTrialId === record.trial.id} onAutoAuditioned={() => setAutoTrialId(null)} onDone={onDone} />
      : <p className="agent-muted">{t(trials.length ? 'editor.agent.allDone' : 'editor.agent.selectTrial')}</p>}
  </div>
}

/** What the last save / dismissal did (shown by the panel above the next trial). */
interface DoneInfo { recordId: string }

/** Once per editor folder: ★3 candidates of ratings saved before reserves existed join their event's reserves. */
function useReserveBackfill(trials: TrialRecord[]) {
  const done = useEditorSettings(s => s.reservesBackfilled)
  useEffect(() => {
    if (done || !trials.length) return
    let map = useEditorSettings.getState().eventReserves
    for (const r of trials) {
      if (!r.rating || !r.trial.scene || r.dismissed) continue
      const ids = reserveCandidates(r.trial, r.rating)
      if (ids.length) map = addReserves(map, r.trial.scene.cues[0], ids.map(candidateId => ({ trialId: r.trial.id, candidateId, target: trialTarget(r.trial) })))
    }
    useEditorSettings.getState().update({ eventReserves: map, reservesBackfilled: true })
  }, [done, trials])
}

function TrialDetail({ record, known, audition, onAudition, deviceNames, onSelectTrial, autoAudition, onAutoAuditioned, onDone }: {
  record: TrialRecord; known: TrialRecord[]; audition: AuditionTarget | null
  onAudition: (target: AuditionTarget, buffer: AudioBuffer) => void; deviceNames: string[]; onSelectTrial: (id: string) => void
  /** After a save or a dismissal: the panel moves on. */
  onDone: (done: DoneInfo) => void
  /** Set after a click in the trial list: audition the first candidate (no playback) and bring the waveform forward. */
  autoAudition: boolean; onAutoAuditioned: () => void
}) {
  const { t } = useI18n()
  const { toast } = useToast()
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
  // Opening always restores the draft (this page's memory, else localStorage, then a newer folder copy unless typed over).
  const [opened] = useState(() => drafts.open(trial, () => ratingToForm(trial, rating, loadRememberedContext())))
  const [form, setForm] = useState<RatingForm>(opened.form)
  const [dirty, setDirty] = useState(opened.restored)
  /** The form came from a stored draft (shown until it is saved). */
  const [restored, setRestored] = useState(opened.restored)
  useEffect(() => {
    let cancelled = false
    void drafts.newerFromFolder(trial, opened.savedAt).then(found => { if (!cancelled && found) { setForm(found.form); setDirty(true); setRestored(true) } })
    return () => { cancelled = true }
  }, [trial.id, editorFolder])
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  // A rating written after this view opened (by this panel's save or elsewhere) replaces the form.
  // Compared by value, so a re-run effect (StrictMode) never resets a restored draft.
  const seenRatedAt = useRef(rating?.ratedAt)
  useEffect(() => {
    if (rating?.ratedAt === seenRatedAt.current) return
    seenRatedAt.current = rating?.ratedAt
    if (drafts.has(trial.id)) return
    setForm(ratingToForm(trial, rating, loadRememberedContext())); setDirty(false)
  }, [rating?.ratedAt])
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
  // The devices this trial's auditions go to (the selected connected ones at its first scene cue's positions).
  const { devices } = useHelperConnection()
  const sceneLib = useSceneStore(s => s.lib)
  const sceneTable = useSceneStore(s => s.table)
  const kitSelectedIps = useDeviceStore(s => s.kitSelectedIps)
  const routedIps = useMemo(() => {
    const ats = sceneLib && sceneTable && trial.scene && trial.scene.project === sceneLib.project_name ? cueRoutePositions(sceneTable, sceneLib, trial.scene.cues[0]) : null
    return routePlaybackTargets(resolvePlaybackTargets(devices, kitSelectedIps), ats).devices.map(d => d.ipAddress)
  }, [devices, kitSelectedIps, sceneLib, sceneTable, trial.scene])
  const auto = useMemo(() => autoRatingContext(devices, routedIps), [devices, routedIps])
  const kind: TrialKind | null = trialKind(trial, record.candidates.map(c => c.features?.durationSec),
    sceneLib && trial.scene?.project === sceneLib.project_name ? sceneLib.loop_cues : [])
  /** Sound trials rate overall / term match / comment only (no haptic dimensions or device conditions). */
  const target = trialTarget(trial)
  /** The event of the open Scene project this trial is for (its first scene cue), if any. */
  const event = sceneLib && sceneTable && trial.scene?.project === sceneLib.project_name ? trialEvent(sceneTable, trial.scene) : null
  /** A haptic trial's cue sounds (the pool, representative first): the sound played with each candidate is picked from them. */
  const soundPool = useMemo(() => target === 'haptic' && event && sceneTable ? sfxSounds(effectiveEvent(sceneTable, parseEventKey(event))?.sfx) : [], [target, event, sceneTable])
  const soundPicks = useEditorSettings(s => s.candidateSounds)
  const soundFirst = target === 'haptic' && !!event && !!sceneLib && !!sceneTable && !isLoopCue(sceneLib, parseEventKey(event).cue) && !effectiveEvent(sceneTable, parseEventKey(event))?.sfx
  const marks = useEditorSettings(s => s.eventMarks)
  /** The waveform selection while a candidate is auditioned: recorded as its "use only this part" range. */
  const region = useWaveformStore(s => s.selectedRegion)
  // On a stretch played at several firings the range is taken as seconds of one play.
  const plan = useAuditionPlan()
  const auditionSec = useAgentTrialStore(s => s.audition?.buffer.duration ?? 0)
  const selection = useMemo(() => toFirstPlay(region, plan?.targets ?? null, auditionSec), [region, plan, auditionSec])
  /** Every change goes to the draft keeper (memory now, the stores after 300 ms). */
  const edit = (update: (f: RatingForm) => RatingForm) => { const next = update(form); setForm(next); drafts.change(trial.id, next); setDirty(true); setSaveError(null) }
  const editCandidate = (cid: string, patch: Partial<CandidateRatingForm>) => edit(f => ({ ...f, candidates: { ...f.candidates, [cid]: { ...f.candidates[cid], ...patch } } }))
  // The candidates' strengths (form values, unsaved too) for the audition gain and "→ Event" / auto-assign.
  useEffect(() => {
    useEventStore.getState().setLevels(Object.fromEntries(trial.candidates.map(c => [levelKey.candidate(trial.id, c.id), form.candidates[c.id]?.intensity ?? initialIntensity(c)])))
  }, [form, trial])
  const issue = ratingFormIssue(form, trial)
  /** The best candidate becomes the sound / haptic of the trial's events (rating save with "assign on save"). */
  const autoAssign = useEditorSettings(s => s.autoAssignOnRating)
  /**
   * Adds the ★4+ candidates (best first, free-plan output excluded) to the material pool of the trial's first scene
   * cue, one decision each (each adds to the list: no duplicates, the existing representative stays first).
   */
  const addToPool = async (ids: string[]): Promise<{ added: string[]; excluded: { candidate: string; reason: string }[]; failures: string[] }> => {
    const scene = useSceneStore.getState()
    if (!scene.table || !scene.lib || scene.lib.project_name !== trial.scene!.project) return { added: [], excluded: [], failures: [t('events.auto.noProject', { project: trial.scene!.project })] }
    const events = assignEventsForTrial(scene.table, scene.lib, trial.scene!.cues.slice(0, 1), target)
    if (!events.length) return { added: [], excluded: [], failures: [t('events.auto.noEvents', { cues: trial.scene!.cues[0] })] }
    const added: string[] = [], excluded: { candidate: string; reason: string }[] = [], failures: string[] = []
    for (const id of ids) {
      try {
        const r = await runDecision({ target, source: { kind: 'candidate', trialId: trial.id, candidateId: id }, events, name: null, at: null,
          pairSound: target === 'haptic' ? candidateSound(trial, id, useEditorSettings.getState().candidateSounds) : null })
        if (r.ok) added.push(r.result.name)
        // A refusal that is not an error (the same sound is already there) is an exclusion, not a failure.
        else if (r.notice.error) failures.push(t(r.notice.id, r.notice.params))
        else excluded.push({ candidate: id, reason: t(r.notice.id, r.notice.params) })
      } catch (error) { failures.push(message(error)) }
    }
    return { added, excluded, failures }
  }
  /** Saves, then (auto-assign / auto-send) and hands over to the panel, which moves to the next unrated trial and shows what happened. */
  const save = async () => {
    if (issue || saving) return
    setSaving(true)
    const withAuto = target === 'sound' ? { ...form, context: EMPTY_CONTEXT } : { ...form, context: { ...form.context, ...(auto.device ? { device: auto.device } : {}), ...(auto.position ? { position: auto.position } : {}),
      ...(auto.deviceWiper !== null ? { deviceWiper: String(auto.deviceWiper), volumeLabel: auto.volumeLabel } : { volumeLabel: '' }) } }
    const body = formToRating(withAuto, trial, localIsoString(new Date()))
    try {
      await useAgentTrialStore.getState().saveRating(trial.id, body); if (target === 'haptic') rememberContext(withAuto.context); setDirty(false); setRestored(false)
      // Saved (and moving on): the only case the draft goes.
      await drafts.done(trial.id).catch(() => {})
    } catch (error) { setSaveError(message(error)); setSaving(false); return }
    setSaving(false)
    // What saving did goes to the operation log (console + .hapbeat-editor/activity-log.jsonl); only failures are shown.
    const excluded: { candidate: string; reason: string }[] = [], failures: string[] = []
    let added: string[] = []
    // Every ★4+ candidate joins the event's material pool (the pool, not one best, is what the game picks from).
    const pooled = poolCandidates(trial, body)
    for (const c of trial.candidates) if ((body.candidates[c.id]?.overall ?? 0) >= 4 && isFreePlanCandidate(c)) excluded.push({ candidate: c.id, reason: t('editor.agent.excludedFreePlan') })
    if (pooled.length && !trial.scene) excluded.push(...pooled.map(candidate => ({ candidate, reason: t('editor.agent.excludedNoScene') })))
    else if (pooled.length && !autoAssign) excluded.push(...pooled.map(candidate => ({ candidate, reason: t('editor.agent.excludedAssignOff') })))
    else if (pooled.length) { const r = await addToPool(pooled); added = r.added; excluded.push(...r.excluded); failures.push(...r.failures) }
    // ★3: the event's reserves (by reference, in the editor settings; not the cue table).
    const reserved = trial.scene ? reserveCandidates(trial, body) : []
    if (trial.scene && reserved.length) {
      const key = trial.scene.cues[0], settings = useEditorSettings.getState()
      settings.update({ eventReserves: addReserves(settings.eventReserves, key, reserved.map(candidateId => ({ trialId: trial.id, candidateId, target }))) })
    }
    const root = useWaveformStore.getState().folder?.root
    if (root) void appendActivity(root, { at: localIsoString(new Date()), kind: 'rated', trialId: trial.id, ...(record.shortId ? { shortId: record.shortId } : {}),
      ...(added.length ? { added } : {}), ...(reserved.length ? { reserved } : {}), ...(excluded.length ? { excluded } : {}), ...(failures.length ? { failures } : {}) }).catch(error => console.warn('[activity] not written', error))
    if (failures.length) toast(t('editor.agent.saveFailures', { id: record.shortId ?? trial.id, failures: failures.join(' / ') }), 'error')
    onDone({ recordId: trial.id })
  }
  const adopt = async (cid: string, label: string) => {
    try { await useAgentTrialStore.getState().adoptCandidate(trial.id, cid); setNotice(t('editor.agent.adopted', { name: label })) }
    catch (error) { setNotice(message(error)) }
  }
  const issueText = issue?.kind === 'bad-wiper' ? t('editor.agent.badWiper') : t('editor.agent.noneRated')
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
          {/*
            One grid, laid out by the card's own width (container query, not the viewport):
            narrow — head / meta (waveform, ★) / axes / notes; wide — head | meta, axes | notes.
          */}
          <div className="agent-card">
            <div className="agent-card-head">
              <button className="toolbar-btn agent-play-btn" disabled={!file?.audio || !!file?.error} aria-label={t(sounding ? 'wave.stop' : 'wave.play')} title={t('editor.agent.playHint')}
                onClick={() => toggleCandidate(trial.id, requested.id)}>
                <span className="transport-label-stack" aria-hidden="true"><span style={{ visibility: sounding ? 'hidden' : 'visible' }}>▶</span><span style={{ visibility: sounding ? 'visible' : 'hidden' }}>■</span></span>
              </button>
              <strong className="agent-short-id" title={t('editor.agent.shortIdHint')}>{record.shortId ? `${record.shortId}-${requested.id}` : requested.id}</strong>
              <span className="agent-card-name" title={[requested.label, requested.hypothesis, requested.method && t(`editor.agent.method.${requested.method}` as MessageId)].filter(Boolean).join('\n')}>{requested.label}</span>
              {/* By hand only (saving the rating assigns automatically): copy into the clip list / assign to the event. */}
              <span className="agent-card-actions">
                <button type="button" className="agent-icon-btn" disabled={!editorFolder || processing} title={t('editor.agent.toClipHint')} aria-label={t('editor.agent.toClipHint')}
                  onClick={() => void adopt(requested.id, requested.label)}>{t('editor.agent.toClip')}</button>
                <button type="button" className="agent-icon-btn" disabled={!buffer} title={t(target === 'sound' ? 'editor.agent.toEventSoundHint' : 'editor.agent.toEventHapticHint')}
                  aria-label={t(target === 'sound' ? 'editor.agent.toEventSoundHint' : 'editor.agent.toEventHapticHint')}
                  onClick={() => useEventStore.getState().requestDecide({ target, source: { kind: 'candidate', trialId: trial.id, candidateId: requested.id }, event })}>{t('editor.agent.toEvent')}</button>
              </span>
            </div>
            <div className="agent-card-meta">
              <span className="agent-thumb" title={featureText(file?.features ?? null)}>{buffer ? <WaveformThumbnail buffer={buffer} />
                : <small className={file?.error || loaded ? 'error' : ''}>{file?.error ? t('editor.agent.renderError', { message: file.error }) : loaded && 'error' in loaded ? loaded.error : file ? t('editor.agent.loadingAudio') : ''}</small>}</span>
              <Stars value={form.candidates[requested.id].overall} onChange={overall => editCandidate(requested.id, { overall })} />
              <VerdictTag overall={form.candidates[requested.id].overall} />
              {/* The strength (saved in the rating as `intensity`): this candidate's audition gain, live. */}
              <LevelSlider className="agent-card-level" levelKey={levelKey.candidate(trial.id, requested.id)} saved={form.candidates[requested.id].intensity}
                label={t('editor.intensity')} title={t(target === 'sound' ? 'editor.agent.intensitySoundHint' : 'editor.agent.intensityHapticHint')}
                onSave={intensity => { useEventStore.getState().setLevels({ [levelKey.candidate(trial.id, requested.id)]: intensity }); editCandidate(requested.id, { intensity }) }} />
              {/* A haptic candidate's sound (the cue's pool; its `sound`, else the representative), picked per candidate. */}
              {soundPool.length > 1 && <select className="agent-card-sound" aria-label={t('editor.agent.withSound')} title={t('editor.agent.withSoundHint')}
                value={((s: string | null) => s && soundPool.includes(s) ? s : soundPool[0])(sceneTable ? companionSoundName(sceneTable, { audition: { trial, candidateId: requested.id, picks: soundPicks }, material: null }) : null)}
                onChange={e => { const value = e.target.value; e.target.blur(); useEditorSettings.getState().update({ candidateSounds: { ...useEditorSettings.getState().candidateSounds, [`${trial.id}/${requested.id}`]: value } }) }}>
                {soundPool.map((s, i) => <option key={s} value={s}>{i === 0 ? `★ ${s}` : s}</option>)}
              </select>}
              {(marks[`${trial.id}/${requested.id}`] ?? []).map(m => <span key={`${m.project}:${m.event}:${m.target}`} className="editor-event-badge" title={m.project}>{m.target === 'sound' ? '♪' : '≋'} {m.event}</span>)}
            </div>
            <CandidateNotes value={form.candidates[requested.id]} onChange={patch => editCandidate(requested.id, patch)} selection={active ? selection : null} />
          </div>
        </article>
      })}
    </div>
    <div className="agent-trial-rating">
      {target === 'haptic' && <fieldset className="agent-context" title={t('editor.agent.context')}>
        {auto.device ? <div className="agent-field agent-field-auto" title={t('editor.agent.autoHint')}>{t('editor.agent.device')}<output>{auto.device}</output></div> : contextField('device', t('editor.agent.device'), `${ids}-devices`)}
        {auto.position ? <div className="agent-field agent-field-auto" title={t('editor.agent.autoHint')}>{t('editor.agent.position')}<output>{auto.position.split(', ').map(p => t(`position.${p}` as MessageId)).join(', ')}</output></div>
          : <label className="agent-field">{t('editor.agent.position')}<select value={form.context.position} onChange={e => { const value = e.target.value; edit(f => ({ ...f, context: { ...f.context, position: value } })) }}>
            <option value="">—</option>
            {BODY_POSITIONS.map(p => <option key={p} value={p}>{t(`position.${p}` as MessageId)}</option>)}
          </select></label>}
        {auto.deviceWiper !== null
          ? <div className="agent-field agent-field-auto" title={t('editor.agent.autoHint')}>{t('editor.agent.volume')}<output>{volumeText(auto.deviceWiper, auto.volumeLabel)}</output></div>
          : <label className="agent-field" title={t('editor.agent.wiperHint')}>{t('editor.agent.deviceWiper')}<input type="number" min={0} max={127} step={1} value={form.context.deviceWiper} onChange={e => { const value = e.target.value; edit(f => ({ ...f, context: { ...f.context, deviceWiper: value } })) }} /></label>}
        {contextField('note', t('editor.agent.note'))}
        <datalist id={`${ids}-devices`}>{deviceNames.map(name => <option key={name} value={name} />)}</datalist>
      </fieldset>}
      {/* The comment on the whole trial: comparisons between candidates ("B is closest, heavier") — the agent's main input. */}
      <TrialComment value={form.comment} onChange={comment => edit(f => ({ ...f, comment }))} />
      {/* One line: [Save and next] [Assign to event] (toggle) · status (the full reason on hover). Saving is the agent's cue (it watches rating.json). */}
      <div className="agent-save">
        <span title={issue ? issueText : ''}><button className="apply-effects-btn" disabled={!!issue || saving || (!dirty && !!rating)} onClick={() => void save()}>{t('editor.agent.saveNext')}</button></span>
        {trial.scene && <button type="button" className="agent-save-toggle" aria-pressed={autoAssign} title={t('events.auto.hint')}
          onClick={() => useEditorSettings.getState().update({ autoAssignOnRating: !autoAssign })}>{t('editor.agent.assignShort')}</button>}
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

/** Comment (one line, grows) and kept ranges (small). */
function CandidateNotes({ value, onChange, selection }: {
  value: CandidateRatingForm; onChange: (patch: Partial<CandidateRatingForm>) => void
  /** The waveform range selected on this candidate (only while it is the auditioned one). */
  selection: { start: number; end: number } | null
}) {
  const { t } = useI18n()
  return <div className="agent-notes">
    <GrowingTextarea className="agent-comment" rows={1} placeholder={t('editor.agent.comment')} aria-label={t('editor.agent.comment')} value={value.comment} onChange={comment => onChange({ comment })} />
    <span className="agent-use-range">
      <button className="agent-icon-btn" disabled={!selection || selection.end <= selection.start} title={t('editor.agent.useRangeHint')}
        onClick={() => { if (selection) onChange({ useRange: addUseRange(value.useRange, selection.start, selection.end) }) }}>{t('editor.agent.useRangeShort')}</button>
      {value.useRange.map((r, i) => <span key={`${r[0]}-${r[1]}`} className="agent-chip">{r[0].toFixed(2)}–{r[1].toFixed(2)}
        <button className="agent-chip-remove" aria-label={t('editor.agent.useRangeRemove')} title={t('editor.agent.useRangeRemove')} onClick={() => onChange({ useRange: value.useRange.filter((_, k) => k !== i) })}>✕</button></span>)}
    </span>
  </div>
}

/** The comment on the whole trial (grows with the text; the user often dictates it). */
function TrialComment({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const { t } = useI18n()
  return <GrowingTextarea className="agent-comment agent-trial-comment" rows={2} placeholder={t('editor.agent.trialComment')} aria-label={t('editor.agent.trialComment')}
    value={value} onChange={onChange} />
}

/** A comment textarea that grows with its text (one or two lines at rest). */
function GrowingTextarea({ value, onChange, ...rest }: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'> & { value: string; onChange: (value: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { const el = ref.current; if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px` } }, [value])
  return <textarea ref={ref} {...rest} value={value} onChange={e => onChange(e.target.value)} />
}

