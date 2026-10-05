import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { useI18n, type MessageId } from '@/i18n/I18nProvider'
import { useAgentTrialStore, type AuditionTarget } from '@/stores/agentTrialStore'
import { useHelperConnection } from '@/hooks/useHelperConnection'
import { useWaveformStore } from '@/stores/waveformStore'
import { localIsoString, type DimensionsDoc, type TrialRecord } from '@/utils/hapticKnowledge'
import type { HapticFeatures } from '@/utils/hapticFeatures'
import { clearRatingDraft, DRAFT_DEBOUNCE_MS, newerDraft, readFolderDraft, readLocalDraft, writeRatingDraft } from '@/utils/ratingDrafts'
import { addUseRange, usableCandidates, autoRatingContext, EMPTY_CONTEXT, formToRating, jaPolePhrase, loadRememberedContext, POSITION_SUGGESTIONS, ratingFormIssue, ratingToForm, rememberContext, trialKind, visibleDimensions, type CandidateRatingForm, type Direction, type RatingForm } from '@/utils/agentTrialUi'
import { trialTarget, VERDICTS, type TrialKind } from '@/utils/agentProtocol'
import { useEventStore } from '@/stores/eventStore'
import { assignEventsForTrial, effectiveEvent, parseEventKey, trialEvent } from '@/utils/cueEvents'
import { runDecision } from './eventDecide'
import { DecidedNotice } from './DecideDialog'
import { isLoopCue } from '@/utils/sceneCueTable'
import { WaveformThumbnail } from './WaveformThumbnail'
import { useEditor } from './editorContext'
import { useSceneVideoTarget } from '@/utils/editorSceneSync'
import { useSceneStore } from '@/stores/sceneStore'
import { useEditorSettings } from '@/stores/editorSettings'
import { wantedSceneProject } from '@/utils/trialScene'

/** Trial tiles shown before "Show more" (unrated first, newest first). */
const TRIAL_TILE_LIMIT = 4
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
  const pickTrial = (r: TrialRecord) => {
    setSelectedId(r.trial.id)
    setAutoTrialId(r.trial.id)
    // The Scene video (window or docked panel, never opened here) switches to this trial's moment.
    useSceneVideoTarget.getState().setTarget({ kind: 'trial', trialId: r.trial.id })
    const wanted = wantedSceneProject({ scene: r.trial.scene, saved: useEditorSettings.getState().trialScenes[r.trial.id], fallback: r.trial.project })
    const scene = useSceneStore.getState()
    // Same as "▶ Video": this click may grant the folder permission or link the folder once.
    if (wanted && scene.lib?.project_name !== wanted) void linkSceneProject(wanted, { quietIfRefused: true })
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
  const shown = projectFilter === '' ? trials : trials.filter(r => (r.trial.project ?? UNASSIGNED_FILTER) === projectFilter)
  const [showAll, setShowAll] = useState(false)
  // Unrated trials first (newest first), then rated ones; the first few, the selected one and "Show more".
  const ordered = [...shown.filter(r => !r.rating), ...shown.filter(r => r.rating)]
  // Never more than the limit: a selected trial further down shows only in the heading below.
  const listed = showAll ? ordered : ordered.slice(0, TRIAL_TILE_LIMIT)
  return <div className="agent-panel">
    <div className={`agent-status ${storeError ? 'error' : ''}`} role="status">{storeError ?? t(!folder ? 'editor.agent.noFolder' : polling ? 'editor.agent.watching' : 'editor.agent.paused')}</div>
    <div className={`agent-mcp-status ${isConnected && folder ? 'ready' : ''}`} title={t('editor.agent.mcpHint')}>{t(!isConnected ? 'editor.agent.mcpHelperOff' : folder ? 'editor.agent.mcpReady' : 'editor.agent.mcpNoFolder')}</div>
    {projects.length > 0 && <label className="agent-project-filter">{t('editor.project')}
      <select value={projectFilter} onChange={e => {
        const value = e.target.value
        setProjectFilter(value)
        // Choosing a project also links its game footage (registered folder, else one folder pick; refusals are not asked again).
        if (value && value !== UNASSIGNED_FILTER) void linkSceneProject(value, { quietIfRefused: true })
      }}>
        <option value="">{t('editor.allProjects')}</option>
        {projects.map(name => <option key={name} value={name}>{name}</option>)}
        <option value={UNASSIGNED_FILTER}>{t('editor.unassigned')}</option>
      </select></label>}
    {/* Tiles in the panel's own (single) scroll; a long list is cut to the newest few, plus the selected one. */}
    <div className="agent-trial-list" aria-label={t('editor.agent.tab')}>
      {trials.length === 0 && rejected.length === 0 && <p className="agent-muted">{t('editor.agent.empty')}</p>}
      {listed.map(r => <button key={r.trial.id} className={`agent-trial-item ${r.trial.id === selectedId ? 'selected' : ''}`} aria-pressed={r.trial.id === selectedId} onClick={() => pickTrial(r)}
        title={`${r.trial.id} · ${t('editor.agent.candidateCount', { count: r.trial.candidates.length })}`}>
        {r.shortId && <span className="agent-short-id">{r.shortId}</span>}
        {/* A trial for a game event is titled by the event (scene.cues); its words come second. */}
        <strong>{r.trial.scene ? r.trial.scene.cues.join(' + ') : r.trial.terms.join(' · ')}</strong>
        <small>{r.trial.scene ? r.trial.terms.join(' · ') : ''}</small>
        <span className="agent-trial-badges">
          <span className={`agent-badge ${r.rating ? 'rated' : 'unrated'}`}>{t(r.rating ? 'editor.agent.rated' : 'editor.agent.unrated')}</span>
          {trialTarget(r.trial) === 'sound' && <span className="agent-badge">{t('editor.agent.targetSound')}</span>}
        </span>
        <small className="agent-trial-date">{new Date(r.trial.receivedAt).toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</small>
      </button>)}
      {shown.length > TRIAL_TILE_LIMIT && <button type="button" className="toolbar-btn agent-trial-more" onClick={() => setShowAll(!showAll)}>
        {showAll ? t('editor.agent.showFewer') : t('editor.agent.showMore', { count: shown.length - listed.length })}</button>}
      {rejected.map(r => <div key={`${r.file}\n${r.error}`} className="agent-rejected">
        <strong>{t('editor.agent.rejected', { file: r.file })}</strong>
        <button className="toolbar-btn" onClick={() => setRejected(list => list.filter(o => o !== r))}>{t('editor.agent.dismiss')}</button>
        <small>{r.error}</small><small>{t('editor.agent.rejectedHint')}</small>
      </div>)}
    </div>
    {record ? <TrialDetail key={record.trial.id} record={record} dimensions={dimensions} known={trials} audition={audition} onAudition={onAudition} deviceNames={deviceNames} onSelectTrial={setSelectedId}
      autoAudition={autoTrialId === record.trial.id} onAutoAuditioned={() => setAutoTrialId(null)} />
      : <p className="agent-muted">{t('editor.agent.selectTrial')}</p>}
  </div>
}

function TrialDetail({ record, dimensions, known, audition, onAudition, deviceNames, onSelectTrial, autoAudition, onAutoAuditioned }: {
  record: TrialRecord; dimensions: DimensionsDoc | null; known: TrialRecord[]; audition: AuditionTarget | null
  onAudition: (target: AuditionTarget, buffer: AudioBuffer) => void; deviceNames: string[]; onSelectTrial: (id: string) => void
  /** Set after a click in the trial list: audition the first candidate (no playback) and bring the waveform forward. */
  autoAudition: boolean; onAutoAuditioned: () => void
}) {
  const { t } = useI18n()
  const { openSceneVideo, focusEditorPanel, player, pending, toggleCandidate } = useEditor()
  /** The editor playback is sounding (the ▶ / ■ of the auditioned card). */
  const [playing, setPlaying] = useState(false)
  useEffect(() => {
    setPlaying(player.isPlaying())
    const unsubs = [player.on('play', () => setPlaying(true)), player.on('pause', () => setPlaying(false)), player.on('finish', () => setPlaying(false))]
    return () => unsubs.forEach(unsub => unsub())
  }, [player])
  const { trial, rating } = record
  const sceneSaved = useEditorSettings(s => s.trialScenes[trial.id])
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
  const shownDimensions = useMemo(() => dimensions && target === 'haptic' ? { ...dimensions, dimensions: visibleDimensions(dimensions.dimensions, kind) } : null, [dimensions, kind, target])
  /** The event of the open Scene project this trial is for (its first scene cue), if any. */
  const event = sceneLib && sceneTable && trial.scene?.project === sceneLib.project_name ? trialEvent(sceneTable, trial.scene) : null
  const soundFirst = target === 'haptic' && !!event && !!sceneLib && !!sceneTable && !isLoopCue(sceneLib, parseEventKey(event).cue) && !effectiveEvent(sceneTable, parseEventKey(event))?.sfx
  const marks = useEditorSettings(s => s.eventMarks)
  /** The waveform selection while a candidate is auditioned: recorded as its "use only this part" range. */
  const selection = useWaveformStore(s => s.selectedRegion)
  const edit = (update: (f: RatingForm) => RatingForm) => { touchedSinceMount.current = true; setForm(update); setDirty(true); setSaveError(null) }
  const editCandidate = (cid: string, patch: Partial<CandidateRatingForm>) => edit(f => ({ ...f, candidates: { ...f.candidates, [cid]: { ...f.candidates[cid], ...patch } } }))
  const issue = ratingFormIssue(form)
  const save = async () => {
    if (issue || saving) return
    setSaving(true)
    const withAuto = target === 'sound' ? { ...form, context: EMPTY_CONTEXT } : { ...form, context: { ...form.context, ...(auto.device ? { device: auto.device } : {}),
      ...(auto.deviceWiper !== null ? { deviceWiper: String(auto.deviceWiper), volumeLabel: auto.volumeLabel } : { volumeLabel: '' }) } }
    const body = formToRating(withAuto, trial, localIsoString(new Date()))
    let saved = false
    try {
      await useAgentTrialStore.getState().saveRating(trial.id, body); if (target === 'haptic') rememberContext(withAuto.context); drafts.delete(trial.id); setDirty(false); setRestored(false); saved = true
      await clearRatingDraft(editorFolder?.root ?? null, trial.id).catch(() => {})
    }
    catch (error) { setSaveError(message(error)) }
    finally { setSaving(false) }
    if (saved && usableCandidates(withAuto).length >= 2 && !body.best) setNotice(t('editor.agent.severalUsable', { ids: usableCandidates(withAuto).map(id => record.shortId ? `${record.shortId}-${id}` : id).join(', ') }))
    // Auto-assign only a unique top "use" candidate (written as best); otherwise the notice above asks to consult the agent.
    if (saved && body.best && trial.scene && autoAssign) await assignBest(body.best)
    else if (saved && trial.scene && autoAssign && usableCandidates(withAuto).length === 1 && !body.best) setNotice(t('editor.agent.useNeedsOverall'))
  }
  /** The best candidate becomes the sound / haptic of the trial's events (rating save with "assign on save"). */
  const autoAssign = useEditorSettings(s => s.autoAssignOnRating)
  const [assignedId, setAssignedId] = useState<number | null>(null)
  const lastResult = useEventStore(s => s.result)
  const assignBest = async (best: string) => {
    const scene = useSceneStore.getState()
    if (!scene.table || !scene.lib || scene.lib.project_name !== trial.scene!.project) { setNotice(t('events.auto.noProject', { project: trial.scene!.project })); return }
    const events = assignEventsForTrial(scene.table, scene.lib, trial.scene!.cues, target)
    if (!events.length) { setNotice(t('events.auto.noEvents', { cues: trial.scene!.cues.join(', ') })); return }
    try {
      const r = await runDecision({ target, source: { kind: 'candidate', trialId: trial.id, candidateId: best }, events, name: null, at: null, gain: 1 })
      if (r.ok) { setAssignedId(r.result.id); setNotice('') } else setNotice(t(r.notice.id, r.notice.params))
    } catch (error) { setNotice(message(error)) }
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
  const contextField = (key: keyof RatingForm['context'], label: string, list?: string) =>
    <label className="agent-field">{label}<input list={list} value={form.context[key]} onChange={e => { const value = e.target.value; edit(f => ({ ...f, context: { ...f.context, [key]: value } })) }} /></label>

  return <div className="agent-detail">
    <div className="agent-detail-head">
      {record.shortId && <span className="agent-short-id large" title={t('editor.agent.shortIdHint')}>{record.shortId}</span>}
      {trial.scene ? <><strong>{trial.scene.cues.join(' + ')}</strong><small>{trial.terms.join(' · ')} · {trial.id}</small></> : <strong>{trial.id}</strong>}
      <small>{t('editor.agent.received')}: {new Date(trial.receivedAt).toLocaleString()}{trial.agent && ` · ${t('editor.agent.agentName')}: ${[trial.agent.name, trial.agent.model].filter(Boolean).join(' / ')}`}</small>
      {trial.parentTrial && <small>{t('editor.agent.parent')}: {known.some(r => r.trial.id === trial.parentTrial)
        ? <button className="agent-link" onClick={() => onSelectTrial(trial.parentTrial!)}>{trial.parentTrial}</button> : trial.parentTrial}</small>}
      <button className="toolbar-btn agent-scene-btn" title={t('editor.scene.openHint')}
        onClick={() => openSceneVideo({ kind: 'trial', trialId: trial.id }, wantedSceneProject({ scene: trial.scene, saved: sceneSaved, fallback: trial.project }) ?? null)}>▶ {t('editor.scene.open')}</button>
    </div>
    <dl className="agent-detail-meta">
      <dt>{t('editor.agent.prompt')}</dt><dd>{trial.prompt}</dd>
      <dt>{t('editor.agent.terms')}</dt><dd>{trial.terms.map(term => <span className="agent-chip" key={term}>{term}</span>)}</dd>
      {trial.rationale && <><dt>{t('editor.agent.rationale')}</dt><dd>{trial.rationale}</dd></>}
    </dl>
    {kind === 'sequence' && <p className="agent-muted">{t('editor.agent.sequenceNote')}</p>}
    {target === 'sound' && <p className="agent-muted">{t('editor.agent.soundTrialNote')}</p>}
    {soundFirst && <p className="events-hint">{t('events.soundFirst')}</p>}
    <div className="agent-notice" role="status">{notice}</div>
    {lastResult && lastResult.id === assignedId && <DecidedNotice result={lastResult} />}
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
          {/* Row 1: ▶, id, label (thin waveform + features under it), verdict, overall. Row 2: comment (and use-for). The rest folds under "More". */}
          <div className="agent-card-row">
            <button className="toolbar-btn agent-play-btn" disabled={!file?.audio || !!file?.error} aria-label={t(sounding ? 'wave.stop' : 'wave.play')} title={t('editor.agent.playHint')}
              onClick={() => toggleCandidate(trial.id, requested.id)}>
              <span className="transport-label-stack" aria-hidden="true"><span style={{ visibility: sounding ? 'hidden' : 'visible' }}>▶</span><span style={{ visibility: sounding ? 'visible' : 'hidden' }}>■</span></span>
            </button>
            <strong className="agent-short-id" title={t('editor.agent.shortIdHint')}>{record.shortId ? `${record.shortId}-${requested.id}` : requested.id}</strong>
            <div className="agent-card-label" title={[requested.label, requested.hypothesis].filter(Boolean).join('\n')}>
              <span className="agent-card-name">{requested.label}{requested.method && <small className="agent-method" title={t('editor.agent.methodHint')}>{t(`editor.agent.method.${requested.method}` as MessageId)}</small>}</span>
              <div className="agent-card-meta">
                <span className="agent-thumb">{buffer ? <WaveformThumbnail buffer={buffer} />
                  : <small className={file?.error || loaded ? 'error' : ''}>{file?.error ? t('editor.agent.renderError', { message: file.error }) : loaded && 'error' in loaded ? loaded.error : file ? t('editor.agent.loadingAudio') : ''}</small>}</span>
                <FeatureLine features={file?.features ?? null} />
                {(marks[`${trial.id}/${requested.id}`] ?? []).map(m => <span key={`${m.project}:${m.event}:${m.target}`} className="editor-event-badge" title={m.project}>{m.target === 'sound' ? '♪' : '≋'} {m.event}</span>)}
              </div>
            </div>
            <QuickRating value={form.candidates[requested.id]} onChange={patch => editCandidate(requested.id, patch)} />
          </div>
          <CandidateRatingInputs value={form.candidates[requested.id]} terms={trial.terms} dimensions={shownDimensions} onChange={patch => editCandidate(requested.id, patch)}
            selection={active ? selection : null} details={<>
              {requested.hypothesis && <p className="agent-hypothesis">{requested.hypothesis}</p>}
              <div className="agent-candidate-actions">
                <button className="toolbar-btn" title={t('editor.agent.adoptHint')} disabled={!editorFolder || processing} onClick={() => void adopt(requested.id, requested.label)}>{t('editor.agent.adopt')}</button>
                <button className="toolbar-btn" disabled={!buffer} title={t('events.decideHint')}
                  onClick={() => useEventStore.getState().requestDecide({ target, source: { kind: 'candidate', trialId: trial.id, candidateId: requested.id }, event })}>{t(target === 'sound' ? 'events.decideSound' : 'events.decideHaptic')}</button>
              </div>
            </>} />
        </article>
      })}
    </div>
    <div className="agent-trial-rating">
      {target === 'haptic' && <fieldset className="agent-context"><legend>{t('editor.agent.context')}</legend>
        {auto.device ? <div className="agent-field agent-field-auto" title={t('editor.agent.autoHint')}>{t('editor.agent.device')}<output>{auto.device}</output></div> : contextField('device', t('editor.agent.device'), `${ids}-devices`)}
        {contextField('position', t('editor.agent.position'), `${ids}-positions`)}
        {auto.deviceWiper !== null
          ? <div className="agent-field agent-field-auto" title={t('editor.agent.autoHint')}>{t('editor.agent.volume')}<output>{volumeText(auto.deviceWiper, auto.volumeLabel)}</output></div>
          : <label className="agent-field" title={t('editor.agent.wiperHint')}>{t('editor.agent.deviceWiper')}<input type="number" min={0} max={127} step={1} value={form.context.deviceWiper} onChange={e => { const value = e.target.value; edit(f => ({ ...f, context: { ...f.context, deviceWiper: value } })) }} /></label>}
        {contextField('note', t('editor.agent.note'))}
        <datalist id={`${ids}-devices`}>{deviceNames.map(name => <option key={name} value={name} />)}</datalist>
        <datalist id={`${ids}-positions`}>{POSITION_SUGGESTIONS.map(p => <option key={p} value={p} />)}</datalist>
      </fieldset>}
      <div className="agent-save">
        <button className="apply-effects-btn" disabled={!!issue || saving || (!dirty && !!rating)} onClick={() => void save()}>{t('editor.agent.save')}</button>
        {trial.scene && <label className="agent-auto-assign" title={t('events.auto.hint')}>
          <input type="checkbox" checked={autoAssign} onChange={e => useEditorSettings.getState().update({ autoAssignOnRating: e.target.checked })} />{t('events.auto.label')}</label>}
        <span className={`agent-save-status ${saveError ? 'error' : !dirty && rating ? 'saved' : ''}`} role="status">{saveStatus}</span>
      </div>
    </div>
  </div>
}

function FeatureLine({ features: f }: { features: HapticFeatures | null }) {
  const { t } = useI18n()
  if (!f) return <div className="agent-features" />
  return <div className="agent-features" title={`${t('editor.agent.feature.centroid')} ${num(f.centroidHz, 0, ' Hz')} · ${t('editor.agent.feature.am')} ${num(f.amRateHz, 1, ' Hz')} / ${num(f.amDepth, 2)} · ${t('editor.agent.feature.flatness')} ${num(f.flatness, 2)} · ${t('editor.agent.feature.duration')} ${num(f.durationSec, 2, ' s')}`}>
    <span>{t('editor.agent.feature.centroid')} {num(f.centroidHz, 0, ' Hz')}</span>
    <span>{t('editor.agent.feature.am')} {num(f.amRateHz, 1, ' Hz')} / {num(f.amDepth, 2)}</span>
    <span>{t('editor.agent.feature.flatness')} {num(f.flatness, 2)}</span>
    <span>{t('editor.agent.feature.duration')} {num(f.durationSec, 2, ' s')}</span>
  </div>
}

/** Short "what this rates" tooltips for the seed dimensions; others get a generic low ↔ high line. */
const DIMENSION_HINTS: Record<string, MessageId> = {
  roughness: 'editor.agent.dimHint.roughness', weight: 'editor.agent.dimHint.weight', sharpness: 'editor.agent.dimHint.sharpness',
  intensity: 'editor.agent.dimHint.intensity', regularity: 'editor.agent.dimHint.regularity', continuity: 'editor.agent.dimHint.continuity',
  pleasantness: 'editor.agent.dimHint.pleasantness',
}
const TERM_LABELS = { '-2': 'editor.agent.tooWeak', '0': 'editor.agent.justRight', '2': 'editor.agent.tooStrong' } as const
/** Verdict (use / maybe / no) and the overall score, on the card's first row. */
function QuickRating({ value, onChange }: { value: CandidateRatingForm; onChange: (patch: Partial<CandidateRatingForm>) => void }) {
  const { t } = useI18n()
  return <div className="agent-quick">
    <div className="agent-verdict" role="group" aria-label={t('editor.agent.verdict')}>
      {VERDICTS.map(v => <button key={v} type="button" className={`agent-chip-btn verdict-${v} ${value.verdict === v ? 'selected' : ''}`} aria-pressed={value.verdict === v}
        onClick={() => onChange({ verdict: value.verdict === v ? null : v })}>{t(`editor.agent.verdict.${v}` as MessageId)}</button>)}
    </div>
    <div className="agent-overall" role="group" aria-label={t('editor.agent.overall')} title={t('editor.agent.overallHint')}>
      {[1, 2, 3, 4, 5].map(n => <button key={n} className={`toolbar-btn ${value.overall === n ? 'selected' : ''}`} aria-pressed={value.overall === n} onClick={() => onChange({ overall: value.overall === n ? null : n })}>{n}</button>)}
    </div>
  </div>
}

/** A one-row textarea that grows with its text. */
function GrowingTextarea({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { const el = ref.current; if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px` } }, [value])
  return <textarea ref={ref} className="agent-comment" rows={1} placeholder={placeholder} aria-label={placeholder} value={value} onChange={e => onChange(e.target.value)} />
}

function CandidateRatingInputs({ value, terms, dimensions, onChange, selection, details }: {
  value: CandidateRatingForm; terms: string[]; dimensions: DimensionsDoc | null; onChange: (patch: Partial<CandidateRatingForm>) => void
  /** The waveform range selected on this candidate (only while it is the auditioned one). */
  selection: { start: number; end: number } | null
  /** Extra content of the "More" fold (hypothesis, adopt / decide). */
  details?: ReactNode
}) {
  const { t, locale } = useI18n()
  const [more, setMore] = useState(false)
  /** How many folded inputs hold something (shown on the closed toggle). */
  const extra = Object.keys(value.termMatch).length + Object.keys(value.directions).length + value.useRange.length
  const setTerm = (term: string, v: number | undefined) => {
    const termMatch = { ...value.termMatch }
    if (v === undefined) delete termMatch[term]; else termMatch[term] = v
    onChange({ termMatch })
  }
  const setDirection = (dim: string, v: Direction) => {
    const directions = { ...value.directions }
    if (directions[dim] === v) delete directions[dim]; else directions[dim] = v
    onChange({ directions })
  }
  return <div className="agent-rating">
    <div className="agent-comment-row">
      <GrowingTextarea value={value.comment} placeholder={t('editor.agent.comment')} onChange={comment => onChange({ comment })} />
      {(value.verdict === 'use' || value.verdict === 'maybe' || value.useFor) && <input className="agent-use-for" value={value.useFor} maxLength={200}
        placeholder={t('editor.agent.useForPlaceholder')} aria-label={t('editor.agent.useFor')} onChange={e => onChange({ useFor: e.target.value })} />}
    </div>
    {/* Term match, directions, kept ranges and the rest fold away (closed at first). */}
    <button type="button" className="agent-more" aria-expanded={more} onClick={() => setMore(!more)}>
      <span aria-hidden="true">{more ? '▾' : '▸'}</span>{t('editor.agent.moreRating')}
      {extra > 0 && <small className="agent-more-count">{t('editor.agent.moreSet', { count: extra })}</small>}
    </button>
    {more && terms.map(term => {
      const v = value.termMatch[term]
      return <div className="agent-term" key={term}>
        <span>{t('editor.agent.termMatch', { term })}</span>
        <output>{v === undefined ? t('editor.agent.notSet') : `${v > 0 ? '+' : ''}${v}`}</output>
        <button className="toolbar-btn" disabled={v === undefined} onClick={() => setTerm(term, undefined)}>{t('editor.agent.clear')}</button>
        {/* onClick also records a click on the centre, where the value does not change. */}
        <input type="range" className={v === undefined ? 'unset' : ''} min={-2} max={2} step={1} value={v ?? 0} aria-label={t('editor.agent.termMatch', { term })}
          onChange={e => setTerm(term, Number(e.target.value))} onClick={e => setTerm(term, Number(e.currentTarget.value))} />
        <div className="agent-scale">{(['-2', '0', '2'] as const).map(k => <small key={k}>{t(TERM_LABELS[k])}</small>)}</div>
      </div>
    })}
    {more && dimensions && dimensions.dimensions.length > 0 && <div className="agent-directions" aria-label={t('editor.agent.directions')}>
      <small>{t('editor.agent.directions')}</small>
      {dimensions.dimensions.map(d => {
        const name = locale === 'ja' ? d.ja : d.en
        const [low, high] = d.poles[locale]
        const hint = DIMENSION_HINTS[d.id] ? t(DIMENSION_HINTS[d.id]) : t('editor.agent.dimHint.generic', { low, high })
        const pole = (p: string) => locale === 'ja' ? t('editor.agent.more', { pole: jaPolePhrase(p) }) : t('editor.agent.more', { pole: p })
        return <div className="agent-direction" key={d.id}>
          <span title={hint}>{name}:</span>
          {([-1, 0, 1] as Direction[]).map(v => <button key={v} title={hint} className={`agent-chip-btn ${value.directions[d.id] === v ? 'selected' : ''}`} aria-pressed={value.directions[d.id] === v} onClick={() => setDirection(d.id, v)}>
            {v === 0 ? t('editor.agent.fine') : pole(v < 0 ? low : high)}</button>)}
        </div>
      })}
    </div>}
    {more && <div className="agent-use-range">
      <button className="toolbar-btn" disabled={!selection || selection.end <= selection.start} title={t('editor.agent.useRangeHint')}
        onClick={() => { if (selection) onChange({ useRange: addUseRange(value.useRange, selection.start, selection.end) }) }}>{t('editor.agent.useRangeRecord')}</button>
      {value.useRange.map((r, i) => <span key={`${r[0]}-${r[1]}`} className="agent-chip">{r[0].toFixed(3)}–{r[1].toFixed(3)} s
        <button className="agent-chip-remove" aria-label={t('editor.agent.useRangeRemove')} title={t('editor.agent.useRangeRemove')} onClick={() => onChange({ useRange: value.useRange.filter((_, k) => k !== i) })}>✕</button></span>)}
    </div>}
    {more && details}
  </div>
}
