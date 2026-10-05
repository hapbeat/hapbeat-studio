import { useWaveformStore } from '@/stores/waveformStore'
import { useAgentTrialStore } from '@/stores/agentTrialStore'
import { useEditorSettings } from '@/stores/editorSettings'
import { useSceneStore } from '@/stores/sceneStore'
import { materialIntensity, setClipIntensity, setSoundIntensity } from '@/utils/sceneCueTable'
import { levelKey, useEventStore } from '@/stores/eventStore'
import { useEffect, useMemo } from 'react'
import { LevelCommit, levelText } from '@/utils/levelCommit'
import { useI18n } from '@/i18n/I18nProvider'
import { WaveformDisplay } from './WaveformDisplay'
import { TransportBar } from './TransportBar'
import { EditorMenu, EditorMenuItem, EditorMenuSection } from './EditorMenu'
import { useEditor } from './editorContext'

/** Waveform panel: edited / original toggle, the display and the transport. Edit commands sit in one menu. */
export function WaveformPanel() {
  const { t } = useI18n()
  const s = useWaveformStore()
  const { original, setOriginal, pendingChain, preview, auditionKey, audioBuffer, level, player, playback, pending, togglePlay, playFromStart } = useEditor()
  const audition = !!auditionKey
  const eventPreview = useEventStore(state => state.preview)
  /** The event material being adjusted (its own editor document, linked to the WAV). */
  const adjusting = useEditorSettings(state => s.clip ? state.materialLinks[s.clip.id] : undefined)
  const region = s.selectedRegion
  const duration = audioBuffer?.duration ?? 0
  const locked = s.isProcessing || audition
  /** Extract works on the rendered buffer, so a pending chain is applied first (the selection survives). */
  const extract = async () => {
    const selection = useWaveformStore.getState().selectedRegion
    if (pendingChain && !original) {
      await s.applyEffects()
      if (useWaveformStore.getState().error) return
      useWaveformStore.getState().setSelectedRegion(selection)
    }
    useWaveformStore.getState().extractSelection()
  }
  const status = eventPreview ? t(eventPreview.target === 'sound' ? 'events.preview.soundHint' : 'events.preview.hapticHint')
    : audition ? t('editor.agent.auditionHint')
    : original ? t('editor.originalHint')
    : pendingChain ? (preview.error || t(preview.status === 'rendering' ? 'editor.previewRendering' : 'editor.previewHint'))
    : t('editor.selectionHint')
  return <div className="editor-panel editor-waveform-panel">
    <div className="editor-comparison">
      <strong className={`editor-active-name ${audition ? 'editor-auditioning' : ''}`}>{eventPreview ? t('events.preview.name', { name: eventPreview.label }) : auditionKey ? t('editor.agent.auditioning', { name: auditionKey })
        : adjusting ? t('editor.adjusting', { event: adjusting.event, file: `${adjusting.wav}.wav` }) : s.clip?.name ?? t('editor.noClip')}</strong>
      {eventPreview ? <IntensitySlider key={eventPreview.material} target={eventPreview.target} wav={eventPreview.material} />
        : adjusting && !audition && <IntensitySlider key={adjusting.wav} target={adjusting.target} wav={adjusting.wav} project={adjusting.project} />}
      <div className="editor-segmented" role="group" aria-label={t('editor.showing')}>
        <button className={`toolbar-btn ${!original ? 'selected' : ''}`} disabled={!s.clip || locked} aria-pressed={!original} title={t('editor.committedHint')} onClick={() => { if (original) s.setSelectedRegion(null); setOriginal(false) }}>∿ {t('editor.edited')}</button>
        <button className={`toolbar-btn ${original ? 'selected' : ''}`} disabled={!s.clip || locked} aria-pressed={original} onClick={() => { s.setSelectedRegion(null); setOriginal(true) }}>↩ {t('editor.original')}</button>
      </div>
      {audition && <button className="toolbar-btn" onClick={() => { useAgentTrialStore.getState().clearAudition(); useEventStore.getState().clearPreview() }}>{t('editor.agent.backToClip')}</button>}
      <button className="toolbar-btn editor-extract" onClick={() => void extract()} disabled={!region || locked}>✂ {t('editor.extract')}</button>
      <EditorMenu label={`${t('editor.editMenu')} ▾`} disabled={!s.clip || locked}>
        <EditorMenuItem onSelect={s.undo} disabled={original || !s.undoStack.length}>{t('editor.undo')} <kbd>Ctrl+Z</kbd></EditorMenuItem>
        <EditorMenuItem onSelect={s.redo} disabled={original || !s.redoStack.length}>{t('editor.redo')} <kbd>Ctrl+Shift+Z</kbd></EditorMenuItem>
        <EditorMenuItem onSelect={s.cropToRegion} disabled={original || !region}>{t('editor.trim')}</EditorMenuItem>
        <EditorMenuItem onSelect={s.deleteRegion} disabled={original || !region || (region.start === 0 && region.end === duration)}>{t('editor.cut')} <kbd>Delete</kbd></EditorMenuItem>
        <EditorMenuItem onSelect={s.revertToOriginal} disabled={!s.clip}>{t('editor.restore')}</EditorMenuItem>
        <EditorMenuSection label={t('editor.selectionRange')}>
          <div className="editor-menu-fields">
            <label className="toolbar-field">{t('editor.from')}<input className="editor-time-input" type="number" min={0} max={duration} step={.001} value={region?.start ?? 0}
              onChange={e => s.setSelectedRegion({ start: Number(e.target.value), end: region?.end ?? duration }, original, duration)} /></label>
            <label className="toolbar-field">{t('editor.to')}<input className="editor-time-input" type="number" min={0} max={duration} step={.001} value={region?.end ?? duration}
              onChange={e => s.setSelectedRegion({ start: region?.start ?? 0, end: Number(e.target.value) }, original, duration)} /></label>
          </div>
          <EditorMenuItem onSelect={() => s.setSelectedRegion(null)} disabled={!region}>{t('editor.deselect')}</EditorMenuItem>
        </EditorMenuSection>
      </EditorMenu>
    </div>
    <div className="editor-preview-status" role="status">{status}</div>
    <div className="waveform-main">
      {!s.clip && !audition && <div className="waveform-empty"><div className="empty-icon">∿</div><div className="empty-message">{t('wave.drop')}</div><div className="empty-hint">{t('editor.emptyHint')}</div></div>}
      <WaveformDisplay original={original} scale={level} bufferOverride={audioBuffer} player={player} viewKey={auditionKey ?? undefined}
        transport={<TransportBar player={player} available={!!audioBuffer} playback={playback} pending={pending} onToggle={togglePlay} onFromStart={() => playFromStart()} />} />
    </div>
  </div>
}

/**
 * The strength of the shown event material (DEC-086): its intensity (0..1, dB shown too), always available (no "Adjust"
 * needed). A move applies at once as the playback gain and the drawing scale (the editor reads `liveLevel`); the cue
 * table is written on release or 500 ms after the last move (LevelCommit). The WAV keeps the shape; effects are for the shape.
 */
function IntensitySlider({ target, wav, project }: { target: 'sound' | 'haptic'; wav: string; project?: string }) {
  const { t } = useI18n()
  const key = levelKey.material(target, wav)
  const saved = useSceneStore(state => state.table && (!project || state.lib?.project_name === project) && (target === 'sound' || state.table.clips[wav]) ? materialIntensity(state.table, target, wav) : null)
  const live = useEventStore(state => state.liveLevel?.key === key ? state.liveLevel.value : null)
  const commit = useMemo(() => new LevelCommit(v => {
    useSceneStore.getState().edit(tb => target === 'haptic' ? (tb.clips[wav] ? setClipIntensity(tb, wav, v) : null) : setSoundIntensity(tb, wav, v))
    if (useEventStore.getState().liveLevel?.key === key) useEventStore.getState().setLiveLevel(null)
  }), [key, target, wav])
  useEffect(() => () => commit.flush(), [commit])
  if (saved === null) return null
  const value = live ?? saved
  return <label className="editor-intensity" title={t('editor.intensityHint')}>
    {t('editor.intensity')}
    <input type="range" min={0} max={1} step={0.01} value={value} aria-label={t('editor.intensity')}
      onChange={e => { const v = parseFloat(e.target.value); useEventStore.getState().setLiveLevel({ key, value: v }); commit.input(v) }}
      onPointerUp={() => commit.flush()} onKeyUp={() => commit.flush()} onBlur={() => commit.flush()} />
    <span className="editor-intensity-value">{levelText(value)}</span>
  </label>
}
