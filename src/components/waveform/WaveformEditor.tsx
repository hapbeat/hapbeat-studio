import { useEffect, useMemo, useRef, useState } from 'react'
import { WaveformDisplay } from './WaveformDisplay'
import { WaveformToolbar } from './WaveformToolbar'
import { TransportBar } from './TransportBar'
import { StatusBar } from './StatusBar'
import { WaveformThumbnail } from './WaveformThumbnail'
import { EffectsPanel } from './EffectsPanel'
import { useWaveformStore } from '@/stores/waveformStore'
import { useI18n } from '@/i18n/I18nProvider'
import { useHelperConnection } from '@/hooks/useHelperConnection'
import { EditorPlayback } from '@/utils/editorPlayback'
import { cropBuffer } from '@/utils/audioDsp'
import { encodeWavBlob } from '@/utils/wavIO'
import type { SampleRate } from '@/types/waveform'
import './WaveformEditor.css'
import { EditorDock } from './EditorDock'
import { useEditorSettings } from '@/stores/editorSettings'
import { EditorBufferPlayer } from '@/utils/editorBufferPlayer'
import { useEditorPreview } from '@/hooks/useEditorPreview'
import { sourceGroup } from '@/utils/editorWaveform'
import type { Recipe } from '@/utils/recipe'
import type { MessageId } from '@/i18n/I18nProvider'
import { RecipeDialog } from './RecipeDialog'
import { AgentTrialsPanel } from './AgentTrialsPanel'
import { useAgentTrialStore } from '@/stores/agentTrialStore'
import { useAgentEndpoint } from '@/hooks/useAgentEndpoint'
import { isDemoMode } from '@/demo/isDemoMode'
import { lookupMaterials, provenanceLine } from '@/utils/materials'
import type { WaveformClip } from '@/types/waveform'

export function WaveformEditor({ active }: { active: boolean }) {
  const { t } = useI18n()
  const s = useWaveformStore()
  const layout = useEditorSettings(s => s.layout)
  const columns = useEditorSettings(s => s.columns)
  const [original, setOriginal] = useState(false)
  const [showAllSources, setShowAllSources] = useState(false)
  useEffect(() => { setShowAllSources(false) }, [s.documents.length, s.folder])
  const activeGroup = s.clip ? sourceGroup(s.clip) : null
  const sourceGroups = useMemo(() => {
    const groups = new Map<string, typeof s.documents>()
    for (const doc of s.documents) {
      const key = sourceGroup(doc.clip)
      const group = groups.get(key) ?? []
      group.push(doc); groups.set(key, group)
    }
    return [...groups.entries()]
  }, [s.documents])
  const visibleDocuments = showAllSources ? s.documents : s.documents.filter(doc => sourceGroup(doc.clip) === activeGroup)
  const [muted, setMuted] = useState(false)
  const [previewEnabled, setPreviewEnabled] = useState(false)
  /** AI trial candidate shown / played instead of the clip (agentTrialStore). Editing is disabled meanwhile. */
  const audition = useAgentTrialStore(state => state.audition)
  const auditionKey = audition ? `${audition.trialId}/${audition.candidateId}` : null
  const [sideTab, setSideTab] = useState<'effects' | 'agent'>('effects')
  const unratedTrials = useAgentTrialStore(state => state.trials.filter(r => !r.rating).length)
  const focusRequest = useAgentTrialStore(state => state.focusRequest)
  useEffect(() => { if (focusRequest) setSideTab('agent') }, [focusRequest])
  useEffect(() => {
    if (!active || !s.folder) return
    useAgentTrialStore.getState().startPolling()
    return () => useAgentTrialStore.getState().stopPolling()
  }, [active, s.folder])
  useAgentEndpoint(active && !!s.folder, s.folder?.root.name ?? null)
  const preview = useEditorPreview(s.clip, s.effects, previewEnabled && !original && !audition)
  const [clipView, setClipView] = useState(() => localStorage.getItem('hapbeat-editor-clip-view') ?? 'cards')
  useEffect(() => { void useWaveformStore.getState().restoreFolder() }, [])
  const { isConnected, devices, send, subscribe } = useHelperConnection()
  // Refresh provenance from the helper ledger on connect and when sources change;
  // the result is stored in project.json so it also shows without the helper.
  const sourceShaKey = useMemo(() => [...new Set(s.documents.map(doc => doc.clip.sourceSha256).filter(Boolean))].sort().join(','), [s.documents])
  useEffect(() => {
    if (!isConnected || !sourceShaKey || s.isProcessing || isDemoMode()) return
    let cancelled = false
    void lookupMaterials({ send, subscribe }, sourceShaKey.split(','))
      .then(found => { if (!cancelled) useWaveformStore.getState().setProvenance(found) })
      .catch(error => console.warn('[editor] material_lookup failed', error))
    return () => { cancelled = true }
  }, [isConnected, sourceShaKey, s.isProcessing, send, subscribe])
  const provenanceText = (clip: WaveformClip) => {
    const line = provenanceLine(clip)
    if (line.key === 'known') return t('editor.provenance.known', { site: line.site, license: line.license }) + (line.needsReview ? t('editor.provenance.review') : '')
    return line.key === 'none' ? '' : t(`editor.provenance.${line.key}`)
  }
  const [selectedTargets, setSelectedTargets] = useState<string[] | null>(() => {
    try { const saved = JSON.parse(localStorage.getItem('hapbeat-editor-targets') ?? 'null'); return Array.isArray(saved) && saved.every(item => typeof item === 'string') ? saved : null } catch { return null }
  })
  const playbackDevices = devices.filter(device => !device.role || device.role === 'receiver')
  const targets = isConnected ? playbackDevices.filter(device => device.online && (selectedTargets === null || selectedTargets.includes(device.ipAddress))).map(device => device.ipAddress) : []
  const targetKey = targets.join(',')
  const audioBuffer = audition ? audition.buffer : original ? s.clip?.originalBuffer : previewEnabled ? (preview.buffer ?? s.clip?.buffer) : s.clip?.buffer
  const player = useMemo(() => new EditorBufferPlayer(null, undefined, s.setError), [s.clip?.id, original, auditionKey])
  useEffect(() => {player.activate(); return () => player.dispose()}, [player])
  player.setBuffer(audioBuffer ?? null)
  useEffect(() => {
    const selection = useWaveformStore.getState().selectedRegion
    if (selection && audioBuffer) useWaveformStore.getState().setSelectedRegion(selection, original, audioBuffer.duration)
  }, [audioBuffer, original])
  const [pending, setPending] = useState(false)
  const playback = useMemo(() => {
    let cached: {buffer: AudioBuffer; start: number; end: number; blob: Promise<Blob>} | null = null
    const keys = new WeakMap<Blob, string>()
    return new EditorPlayback(player, (start, end) => {
      const buffer = player.getBuffer()
      if (!buffer) return Promise.reject(new Error('Select a clip first'))
      if (!cached || cached.buffer !== buffer || cached.start !== start || cached.end !== end) cached = {buffer, start, end, blob: encodeWavBlob(start === 0 && end === buffer.duration ? buffer : cropBuffer(buffer, start, end), buffer.sampleRate as SampleRate)}
      return cached.blob
    }, targetKey ? targetKey.split(',') : [], send, async (blob, route, options) => {
      let key = keys.get(blob); if (!key) {key = crypto.randomUUID(); keys.set(blob, key)}
      await (await import('@/utils/audioStreamer')).streamClip(blob, route, {...options, cacheKey: key})
    }, setPending, s.setError)
  }, [player, targetKey, send, s.setError])
  useEffect(() => () => playback?.stop(), [playback])
  useEffect(() => { if (!active) playback?.stop() }, [active, playback])
  useEffect(() => {
    if (!playback) return
    const unsubs = [player.on('pause', () => playback.paused()), player.on('finish', () => playback.paused()), player.on('timeupdate', time => playback.timeUpdated(time)), player.on('seeking', time => playback.seek(time))]
    return () => unsubs.forEach(unsub => unsub())
  }, [player, playback])
  useEffect(() => {
    const toggle = () => { if (active && !useWaveformStore.getState().isProcessing) void playback?.toggle().catch(s.setError) }
    window.addEventListener('studio:editor-playback', toggle)
    return () => window.removeEventListener('studio:editor-playback', toggle)
  }, [active, playback, s.setError])
  const chooseTargets = (value: string[] | null) => { setSelectedTargets(value); localStorage.setItem('hapbeat-editor-targets', JSON.stringify(value)) }
  const input = useRef<HTMLInputElement>(null)
  const [recipeDialog, setRecipeDialog] = useState<{ container: HTMLElement; initial?: Recipe } | null>(null)
  const openRecipe = (anchor: HTMLElement, initial?: Recipe) => setRecipeDialog({ container: anchor.ownerDocument.body, initial })
  const createRecipeClip = (recipe: Recipe, presetId: string | null) => {
    s.addRecipeClip(recipe, presetId ? t(`editor.recipe.preset.${presetId}` as MessageId) : t('editor.recipe.clipName'), `recipe:${presetId ?? 'custom'}`)
    setRecipeDialog(null)
  }
  useEffect(() => { player.setMuted(muted) }, [player, muted])
  useEffect(() => { setOriginal(false); useAgentTrialStore.getState().clearAudition() }, [s.clip?.id])
  // MCP `audition` with play: true — the usual playback path (selected haptic targets, PC audio per the mute toggle).
  const playRequested = useAgentTrialStore(state => state.playRequested)
  useEffect(() => {
    if (!playRequested || !audition) return
    useAgentTrialStore.getState().clearPlayRequest()
    if (active && !useWaveformStore.getState().isProcessing) void playback.play().catch(s.setError)
  }, [playRequested, audition, playback, active, s.setError])
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      const state = useWaveformStore.getState()
      if (state.isProcessing || ['pending', 'saving', 'error'].includes(state.saveStatus)) { event.preventDefault(); event.returnValue = '' }
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [])
  useEffect(() => {
    if (!active) return
    const keydown = (event: KeyboardEvent) => {
      const element = event.target as HTMLElement
      if (element.closest('input, select, textarea, [contenteditable=true]') || (element.closest('button') && !element.closest('.editor-clip'))) return
      const state = useWaveformStore.getState()
      if (state.isProcessing) return

      if (original || previewEnabled || audition) return
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? state.redo() : state.undo() }
      if (event.key === 'Delete' && state.selectedRegion) { event.preventDefault(); state.deleteRegion() }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const docs = showAllSources ? state.documents : state.documents.filter(doc => state.clip && sourceGroup(doc.clip) === sourceGroup(state.clip))
        const index = docs.findIndex(d => d.clip.id === state.clip?.id)
        const next = docs[index + (event.key === 'ArrowDown' ? 1 : -1)]
        if (next) { event.preventDefault(); state.selectClip(next.clip.id) }
      }
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  }, [active, original, previewEnabled, showAllSources, audition])
  const folderName = s.folder?.root.name ?? s.rememberedFolder?.name
  return <div className="waveform-editor" onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' }}
    onDrop={e => { e.preventDefault(); if (s.folder) void s.loadFiles(Array.from(e.dataTransfer.files)); else s.setError(t('editor.chooseFirst')) }}>
    <div className="editor-folder-bar">
      <span className="editor-beta-label" title={t('editor.betaHint')}>BETA</span>
      <button className="toolbar-btn" onClick={() => void s.openFolder()} disabled={s.isProcessing || !('showDirectoryPicker' in window)}>▱ {t('editor.folder')}</button>
      <div className="editor-folder-name" title={t('editor.pathHint')}><strong>{folderName ? `${folderName}/` : t('editor.chooseFirst')}</strong></div>
      {!s.folder && s.rememberedFolder && <button className="toolbar-btn" disabled={s.isProcessing} onClick={() => void s.reconnectFolder()}>{t('editor.reconnect')}</button>}
      <span className={`editor-save-state ${s.saveStatus}`} role="status">{t(`editor.save.${s.saveStatus}`)}</span>
      <button className="toolbar-btn" disabled={!s.folder || s.isProcessing || s.saveStatus === 'saving'} onClick={() => void s.save().catch(() => {})}>{t('editor.saveNow')}</button>
    </div>
    <div className="editor-notice" role="status">{s.error ?? t('editor.workflow')}</div>
    <div className={`editor-content layout-${layout}`}>
    <section className="editor-track">
      <div className="editor-comparison">
        <strong className={`editor-active-name ${audition ? 'editor-auditioning' : ''}`}>{auditionKey ? t('editor.agent.auditioning', {name: auditionKey}) : s.clip?.name ?? t('editor.clips')}</strong>
        <button className={`toolbar-btn ${!original && !previewEnabled ? 'selected' : ''}`} disabled={!s.clip || s.isProcessing || !!audition} aria-pressed={!original && !previewEnabled} onClick={() => {if (original) s.setSelectedRegion(null); setOriginal(false); setPreviewEnabled(false)}}>∿ {t('editor.edited')}</button>
        <button className={`toolbar-btn ${original ? 'selected' : ''}`} disabled={!s.clip || s.isProcessing || !!audition} aria-pressed={original} onClick={() => {s.setSelectedRegion(null); setOriginal(true)}}>↩ {t('editor.original')}</button>
        <button className={`toolbar-btn ${previewEnabled && !original ? 'selected' : ''}`} disabled={!s.clip || s.isProcessing || !!audition} aria-pressed={previewEnabled && !original} onClick={() => {setOriginal(false); setPreviewEnabled(true)}}>{t('editor.preview')}</button>
        {audition ? <span><button className="toolbar-btn" onClick={() => useAgentTrialStore.getState().clearAudition()}>{t('editor.agent.backToClip')}</button></span>
          : <span>{original ? t('editor.originalHint') : t('editor.selectionHint')}</span>}
      </div>
      <div className="editor-preview-status" role="status">{audition ? t('editor.agent.auditionHint') : previewEnabled && !original ? (preview.error || t(preview.status === 'rendering' ? 'editor.previewRendering' : 'editor.previewHint')) : t('editor.committedHint')}</div>
      <div className="waveform-main">
        {!s.clip && !audition && <div className="waveform-empty"><div className="empty-icon">∿</div><div className="empty-message">{t('wave.drop')}</div><div className="empty-hint">{t('editor.emptyHint')}</div></div>}
        <WaveformDisplay original={original} bufferOverride={audioBuffer} player={player} viewKey={auditionKey ?? undefined} />
      </div>
      <TransportBar player={player} available={!!audioBuffer} playback={playback} pending={pending} muted={muted} onMutedChange={setMuted} />
      <div className="editor-targets">
        <strong>{t('editor.hapticTargets')}</strong>
        <button className="toolbar-btn" onClick={() => chooseTargets(null)}>{t('editor.allTargets')}</button>
        <button className="toolbar-btn" onClick={() => chooseTargets([])}>{t('editor.noTargets')}</button>
        <span className="editor-target-status">{isConnected ? `${targets.length} ${t('editor.targetCount')}` : t('editor.helperDisconnected')}</span>
        {playbackDevices.map(device => <label key={device.ipAddress} title={device.ipAddress}>
          <input type="checkbox" checked={selectedTargets === null || selectedTargets.includes(device.ipAddress)} onChange={event => {
            const current = selectedTargets ?? playbackDevices.map(item => item.ipAddress)
            chooseTargets(event.target.checked ? [...current, device.ipAddress] : current.filter(ip => ip !== device.ipAddress))
          }} />{device.name || device.ipAddress}{!device.online && ' (offline)'}
        </label>)}
      </div>
      <fieldset className="editor-edit-controls" disabled={s.isProcessing || !!audition}><WaveformToolbar original={original} preview={previewEnabled && !original} durationOverride={audioBuffer?.duration} /></fieldset>
    </section>
    <EditorDock active={active}><div className="editor-workspace">
      <aside className="editor-clips">
        <div className="editor-clips-heading">{t('editor.clips')} <span>{s.documents.length}</span></div>
        <div className="editor-view-switch">
          <label>{t('editor.columns')}<select value={columns} onChange={e => useEditorSettings.getState().update({columns: Number(e.target.value)})}><option value={0}>Auto</option><option value={1}>1</option><option value={2}>2</option><option value={3}>3</option></select></label>
          {(['text','cards','large'] as const).map(view => <button className={`toolbar-btn ${clipView === view ? 'selected' : ''}`} key={view} aria-pressed={clipView === view} onClick={() => { setClipView(view); localStorage.setItem('hapbeat-editor-clip-view', view) }}>{t(`editor.view.${view}`)}</button>)}
        </div>
        <input ref={input} type="file" multiple accept="audio/*,.wav,.mp3,.ogg,.flac,.aac,.m4a" hidden onChange={e => { void s.loadFiles(Array.from(e.target.files ?? [])); e.target.value = '' }} />
        <button className="toolbar-btn" disabled={!s.folder || s.isProcessing} onClick={() => input.current?.click()}>{t('editor.import')}</button>
        <button className="toolbar-btn" disabled={!s.folder || s.isProcessing} onClick={e => openRecipe(e.currentTarget)}>{t('editor.recipe.create')}</button>
        <nav className="editor-source-groups" aria-label={t('editor.sourceGroups')}>
          <button className={`toolbar-btn ${showAllSources ? 'selected' : ''}`} aria-pressed={showAllSources} onClick={() => setShowAllSources(!showAllSources)}>{t('editor.allSources')} ({s.documents.length})</button>
          {sourceGroups.map(([key, docs]) => <button key={key} className={`toolbar-btn ${!showAllSources && activeGroup === key ? 'selected' : ''}`} aria-pressed={!showAllSources && activeGroup === key} disabled={s.isProcessing}
            title={docs[0].clip.sourceFileName ?? docs[0].clip.name} onClick={() => {setShowAllSources(false); if (activeGroup !== key) s.selectClip(docs[0].clip.id)}}>
            <span>▱ {docs[0].clip.sourceFileName ?? docs[0].clip.name}</span><small>{docs.length}</small>
          </button>)}
        </nav>
        <div className={`editor-clip-list view-${clipView}`} style={columns && clipView !== 'text' ? {gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`} : undefined} aria-label={t('editor.clips')}>
          {visibleDocuments.map((doc, index) => <div className="editor-material" key={doc.clip.id}><button className={`editor-clip ${doc.clip.id === s.clip?.id ? 'selected' : ''}`} disabled={s.isProcessing}
            onClick={() => s.selectClip(doc.clip.id)} aria-pressed={doc.clip.id === s.clip?.id} title={doc.clip.name}>
            <span>{String(index + 1).padStart(2, '0')}</span><strong>{doc.clip.name}</strong><small>{doc.clip.buffer.duration.toFixed(3)} s · {doc.clip.buffer.numberOfChannels === 1 ? 'Mono' : 'Stereo'}</small>
            {clipView !== 'text' && <WaveformThumbnail buffer={doc.clip.buffer} />}
          </button>
          <div className="editor-material-meta">
            <input aria-label={`${t('editor.name')}: ${doc.clip.name}`} value={doc.clip.name} disabled={s.isProcessing} onChange={e => s.updateClipInfo(doc.clip.id, {name: e.target.value})} />
            <input aria-label={`${t('editor.description')}: ${doc.clip.name}`} placeholder={t('editor.description')} value={doc.clip.description ?? ''} disabled={s.isProcessing} onChange={e => s.updateClipInfo(doc.clip.id, {description: e.target.value})} />
            {doc.clip.sourceFileName && <small title={doc.clip.sourceFileName}>{t('editor.sourceFile')}: {doc.clip.sourceFileName}</small>}
            <small className="editor-provenance" title={doc.clip.provenance?.referrerUrl ?? undefined}>{provenanceText(doc.clip)}</small>
            {doc.clip.recipe && <button className="toolbar-btn" disabled={!s.folder || s.isProcessing} onClick={e => openRecipe(e.currentTarget, doc.clip.recipe)}>{t('editor.recipe.edit')}</button>}
          </div></div>)}
        </div>
        <button className="toolbar-btn" disabled={!s.clip || s.isProcessing || !!audition} onClick={s.duplicateClip}>⧉ {t('editor.variant')}</button>
        <p className="editor-help">{t('editor.shortcuts')}</p>
      </aside>
      <div className="editor-side">
        <div className="editor-side-tabs" role="tablist">
          <button role="tab" className={`toolbar-btn ${sideTab === 'effects' ? 'selected' : ''}`} aria-selected={sideTab === 'effects'} onClick={() => setSideTab('effects')}>{t('editor.agent.tabEffects')}</button>
          <button role="tab" className={`toolbar-btn ${sideTab === 'agent' ? 'selected' : ''}`} aria-selected={sideTab === 'agent'} onClick={() => setSideTab('agent')}>
            {t('editor.agent.tab')}<span className="agent-badge unrated" style={{visibility: unratedTrials ? 'visible' : 'hidden'}}>{t('editor.agent.unratedBadge', {count: unratedTrials})}</span></button>
        </div>
        <fieldset className="editor-edit-controls" hidden={sideTab !== 'effects'} disabled={!s.clip || original || s.isProcessing || !!audition}><EffectsPanel preview={previewEnabled} onPreviewChange={setPreviewEnabled} /></fieldset>
        <AgentTrialsPanel hidden={sideTab !== 'agent'} deviceNames={[...new Set(playbackDevices.map(device => device.name).filter(Boolean))]} />
      </div>
    </div>
    </EditorDock></div>
    <StatusBar />
    {recipeDialog && <RecipeDialog container={recipeDialog.container} initial={recipeDialog.initial} onCreate={createRecipeClip} onClose={() => setRecipeDialog(null)} />}
    {s.isProcessing && <div className="processing-overlay"><div className="processing-spinner" /><span>{t('wave.processing')}</span></div>}
  </div>
}
