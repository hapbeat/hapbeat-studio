import { useMemo } from 'react'
import { useWaveformStore } from '@/stores/waveformStore'
import { useAgentTrialStore } from '@/stores/agentTrialStore'
import { useEditorSettings } from '@/stores/editorSettings'
import { useSceneStore } from '@/stores/sceneStore'
import { materialIntensity, setClipIntensity, setSoundIntensity } from '@/utils/sceneCueTable'
import { levelKey, useEventStore } from '@/stores/eventStore'
import { LevelSlider } from './LevelSlider'
import { useI18n } from '@/i18n/I18nProvider'
import { WaveformDisplay } from './WaveformDisplay'
import { TransportBar } from './TransportBar'
import { EditorMenu, EditorMenuItem, EditorMenuSection } from './EditorMenu'
import { useEditor } from './editorContext'
import { layoutPlacements, layoutStatus } from '@/utils/shownLayout'

/** Waveform panel: edited / original toggle, the display and the transport. Edit commands sit in one menu. */
export function WaveformPanel() {
  const { t } = useI18n()
  const s = useWaveformStore()
  const { original, setOriginal, pendingChain, preview, auditionKey, audioBuffer, shownLayout, soundLane, level, player, playback, pending, togglePlay, playFromStart } = useEditor()
  const audition = !!auditionKey
  const eventPreview = useEventStore(state => state.preview)
  /** The event material being adjusted (its own editor document, linked to the WAV). */
  const adjusting = useEditorSettings(state => s.clip ? state.materialLinks[s.clip.id] : undefined)
  const region = s.selectedRegion
  const duration = audioBuffer?.duration ?? 0
  const locked = s.isProcessing || audition
  /** Edited / Original also on a shown event material (Original: the file as it is, without its strength) and while adjusting; not on an AI candidate. */
  const canCompare = !s.isProcessing && (eventPreview ? true : !!s.clip && !audition)
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
  // One file or the material placed at its firings (DEC-085 / DEC-088): always said, with the file's own length.
  const layoutLine = shownLayout ? layoutStatus(shownLayout) : null
  const placements = useMemo(() => shownLayout ? layoutPlacements(shownLayout) : [], [shownLayout])
  return <div className="editor-panel editor-waveform-panel">
    <div className="editor-comparison">
      <strong className={`editor-active-name ${audition ? 'editor-auditioning' : ''}`}>{eventPreview ? t('events.preview.name', { name: eventPreview.label }) : auditionKey ? t('editor.agent.auditioning', { name: auditionKey })
        : adjusting ? t('editor.adjusting', { event: adjusting.event, file: `${adjusting.wav}.wav` }) : s.clip?.name ?? t('editor.noClip')}</strong>
      {/* Fixed width, always present (empty without a buffer): switching single / sequence never moves the controls. */}
      <span className={`editor-shown-layout ${shownLayout?.starts ? 'sequence' : ''}`} role="status" title={shownLayout?.starts ? t('editor.shown.sequenceHint') : undefined}>
        {layoutLine ? t(layoutLine.id, layoutLine.params) : ''}</span>
      {eventPreview ? <IntensitySlider key={eventPreview.material} target={eventPreview.target} wav={eventPreview.material} />
        : adjusting && !audition && <IntensitySlider key={adjusting.wav} target={adjusting.target} wav={adjusting.wav} project={adjusting.project} />}
      <div className="editor-segmented" role="group" aria-label={t('editor.showing')}>
        <button className={`toolbar-btn ${!original ? 'selected' : ''}`} disabled={!canCompare} aria-pressed={!original} title={t('editor.committedHint')} onClick={() => { if (original) s.setSelectedRegion(null); setOriginal(false) }}>∿ {t('editor.edited')}</button>
        <button className={`toolbar-btn ${original ? 'selected' : ''}`} disabled={!canCompare} aria-pressed={original} title={eventPreview ? t('editor.originalMaterialHint') : undefined} onClick={() => { s.setSelectedRegion(null); setOriginal(true) }}>↩ {t('editor.original')}</button>
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
      <WaveformDisplay original={original} scale={level} bufferOverride={audioBuffer} player={player} viewKey={auditionKey ?? undefined} placements={placements} soundLane={soundLane}
        transport={<TransportBar player={player} available={!!audioBuffer} playback={playback} pending={pending} onToggle={togglePlay} onFromStart={() => playFromStart()} />} />
    </div>
  </div>
}

/**
 * The strength of the shown event material (DEC-086): its intensity, always available (no "Adjust" needed), written
 * to the cue table (LevelSlider: live gain and drawing, saved debounced). The WAV keeps the shape; effects are for the shape.
 */
function IntensitySlider({ target, wav, project }: { target: 'sound' | 'haptic'; wav: string; project?: string }) {
  const { t } = useI18n()
  const saved = useSceneStore(state => state.table && (!project || state.lib?.project_name === project) && (target === 'sound' || state.table.clips[wav]) ? materialIntensity(state.table, target, wav) : null)
  if (saved === null) return null
  return <LevelSlider levelKey={levelKey.material(target, wav)} saved={saved} label={t('editor.intensity')} title={t('editor.intensityHint')}
    onSave={v => useSceneStore.getState().edit(tb => target === 'haptic' ? (tb.clips[wav] ? setClipIntensity(tb, wav, v) : null) : setSoundIntensity(tb, wav, v))} />
}
