import { useState } from 'react'
import type { SampleRate } from '@/types/waveform'
import { useWaveformStore } from '@/stores/waveformStore'
import { useI18n } from '@/i18n/I18nProvider'

export function WaveformToolbar({ original, preview = false, durationOverride }: {original: boolean; preview?: boolean; durationOverride?: number}) {
  const { t } = useI18n()
  const s = useWaveformStore()
  const [exported, setExported] = useState('')
  const region = s.selectedRegion
  const duration = durationOverride ?? (original ? s.clip?.originalBuffer : s.clip?.buffer)?.duration ?? 0
  return <div className="waveform-toolbar">
    <div className="toolbar-group">
      <button className="toolbar-btn editor-extract" onClick={s.extractSelection} disabled={!region || preview}>✂ {t('editor.extract')}</button>
      <button className="toolbar-btn" onClick={s.undo} disabled={preview || original || !s.undoStack.length} title="Ctrl+Z">{t('editor.undo')}</button>
      <button className="toolbar-btn" onClick={s.redo} disabled={preview || original || !s.redoStack.length} title="Ctrl+Shift+Z">{t('editor.redo')}</button>
      <button className="toolbar-btn" onClick={s.cropToRegion} disabled={preview || original || !region}>{t('editor.trim')}</button>
      <button className="toolbar-btn" onClick={s.deleteRegion} disabled={preview || original || !region || (region.start === 0 && region.end === s.clip?.buffer.duration)}>{t('editor.cut')}</button>
      <button className="toolbar-btn" onClick={s.revertToOriginal} disabled={!s.clip}>{t('editor.restore')}</button>
    </div>
    <div className="toolbar-group">
      <label className="toolbar-field">{t('editor.from')}<input className="editor-time-input" aria-label={t('editor.from')} type="number" min={0} max={duration} step={.001} disabled={!s.clip}
        value={region?.start ?? 0} onChange={e => s.setSelectedRegion({ start: Number(e.target.value), end: region?.end ?? duration }, original, duration)} /></label>
      <label className="toolbar-field">{t('editor.to')}<input className="editor-time-input" aria-label={t('editor.to')} type="number" min={0} max={duration} step={.001} disabled={!s.clip}
        value={region?.end ?? duration} onChange={e => s.setSelectedRegion({ start: region?.start ?? 0, end: Number(e.target.value) }, original, duration)} /></label>
      <button className="toolbar-btn" disabled={!region} onClick={() => s.setSelectedRegion(null)}>{t('editor.deselect')}</button>
    </div>
    <div className="toolbar-group toolbar-meta">
      <label className="toolbar-field">{t('editor.name')}<input className="toolbar-input" value={s.clip?.name ?? ''} disabled={!s.clip} onChange={e => s.setClipName(e.target.value)} /></label>
      <label className="toolbar-field">WAV <select value={s.clip?.exportSampleRate ?? 48000} disabled={!s.clip} onChange={e => s.setExportSampleRate(Number(e.target.value) as SampleRate)}>
        <option value={16000}>16 kHz</option><option value={24000}>24 kHz</option><option value={44100}>44.1 kHz</option><option value={48000}>48 kHz</option>
      </select></label>
      <label className="toolbar-field"><input type="checkbox" disabled={!s.clip} checked={s.exportAsMono} onChange={e => s.setExportAsMono(e.target.checked)} />Mono</label>
      <button className="toolbar-btn" disabled={!s.clip || preview} onClick={() => { void s.exportWav().then(setExported).catch(s.setError) }}>{t('editor.export')}</button>
    </div>
    <div className="editor-export-status" title={exported} role="status">{t('editor.exportTarget')} · {exported ? `exports/${exported}` : t('editor.exportHint')}</div>
  </div>
}
