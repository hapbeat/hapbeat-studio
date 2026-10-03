import { useWaveformStore } from '@/stores/waveformStore'
import { useAgentTrialStore } from '@/stores/agentTrialStore'
import { useI18n } from '@/i18n/I18nProvider'
import { WaveformDisplay } from './WaveformDisplay'
import { TransportBar } from './TransportBar'
import { EditorMenu, EditorMenuItem, EditorMenuSection } from './EditorMenu'
import { useEditor } from './editorContext'

/** Waveform panel: what is shown (edited / original / preview), the display and the transport. Edit commands sit in one menu. */
export function WaveformPanel() {
  const { t } = useI18n()
  const s = useWaveformStore()
  const { original, setOriginal, previewEnabled, setPreviewEnabled, preview, auditionKey, audioBuffer, player, playback, pending } = useEditor()
  const audition = !!auditionKey
  const region = s.selectedRegion
  const isPreview = previewEnabled && !original
  const duration = audioBuffer?.duration ?? 0
  const locked = s.isProcessing || audition
  return <div className="editor-panel editor-waveform-panel">
    <div className="editor-comparison">
      <strong className={`editor-active-name ${audition ? 'editor-auditioning' : ''}`}>{auditionKey ? t('editor.agent.auditioning', { name: auditionKey }) : s.clip?.name ?? t('editor.noClip')}</strong>
      <div className="editor-segmented" role="group" aria-label={t('editor.showing')}>
        <button className={`toolbar-btn ${!original && !previewEnabled ? 'selected' : ''}`} disabled={!s.clip || locked} aria-pressed={!original && !previewEnabled} title={t('editor.committedHint')} onClick={() => { if (original) s.setSelectedRegion(null); setOriginal(false); setPreviewEnabled(false) }}>∿ {t('editor.edited')}</button>
        <button className={`toolbar-btn ${original ? 'selected' : ''}`} disabled={!s.clip || locked} aria-pressed={original} onClick={() => { s.setSelectedRegion(null); setOriginal(true) }}>↩ {t('editor.original')}</button>
        <button className={`toolbar-btn ${isPreview ? 'selected' : ''}`} disabled={!s.clip || locked} aria-pressed={isPreview} onClick={() => { setOriginal(false); setPreviewEnabled(true) }}>{t('editor.preview')}</button>
      </div>
      {audition && <button className="toolbar-btn" onClick={() => useAgentTrialStore.getState().clearAudition()}>{t('editor.agent.backToClip')}</button>}
      <button className="toolbar-btn editor-extract" onClick={s.extractSelection} disabled={!region || isPreview || locked}>✂ {t('editor.extract')}</button>
      <EditorMenu label={`${t('editor.editMenu')} ▾`} disabled={!s.clip || locked}>
        <EditorMenuItem onSelect={s.undo} disabled={isPreview || original || !s.undoStack.length}>{t('editor.undo')} <kbd>Ctrl+Z</kbd></EditorMenuItem>
        <EditorMenuItem onSelect={s.redo} disabled={isPreview || original || !s.redoStack.length}>{t('editor.redo')} <kbd>Ctrl+Shift+Z</kbd></EditorMenuItem>
        <EditorMenuItem onSelect={s.cropToRegion} disabled={isPreview || original || !region}>{t('editor.trim')}</EditorMenuItem>
        <EditorMenuItem onSelect={s.deleteRegion} disabled={isPreview || original || !region || (region.start === 0 && region.end === s.clip?.buffer.duration)}>{t('editor.cut')} <kbd>Delete</kbd></EditorMenuItem>
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
    <div className="editor-preview-status" role="status">{audition ? t('editor.agent.auditionHint') : isPreview ? (preview.error || t(preview.status === 'rendering' ? 'editor.previewRendering' : 'editor.previewHint')) : original ? t('editor.originalHint') : t('editor.selectionHint')}</div>
    <div className="waveform-main">
      {!s.clip && !audition && <div className="waveform-empty"><div className="empty-icon">∿</div><div className="empty-message">{t('wave.drop')}</div><div className="empty-hint">{t('editor.emptyHint')}</div></div>}
      <WaveformDisplay original={original} bufferOverride={audioBuffer} player={player} viewKey={auditionKey ?? undefined} />
    </div>
    <TransportBar player={player} available={!!audioBuffer} playback={playback} pending={pending} />
  </div>
}
