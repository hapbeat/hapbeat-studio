import { useCallback, useRef } from 'react'
import type { SampleRate } from '@/types/waveform'
import { useWaveformStore } from '@/stores/waveformStore'

export function WaveformToolbar() {
  const fileInputRef = useRef<HTMLInputElement>(null)

  const clip = useWaveformStore((s) => s.clip)
  const undoStack = useWaveformStore((s) => s.undoStack)
  const redoStack = useWaveformStore((s) => s.redoStack)
  const isProcessing = useWaveformStore((s) => s.isProcessing)
  const selectedRegion = useWaveformStore((s) => s.selectedRegion)
  const exportAsMono = useWaveformStore((s) => s.exportAsMono)

  const loadFile = useWaveformStore((s) => s.loadFile)
  const undo = useWaveformStore((s) => s.undo)
  const redo = useWaveformStore((s) => s.redo)
  const setClipName = useWaveformStore((s) => s.setClipName)
  const setExportSampleRate = useWaveformStore((s) => s.setExportSampleRate)
  const setEventId = useWaveformStore((s) => s.setEventId)
  const setExportAsMono = useWaveformStore((s) => s.setExportAsMono)
  const exportWav = useWaveformStore((s) => s.exportWav)
  const cropToRegion = useWaveformStore((s) => s.cropToRegion)
  const deleteRegion = useWaveformStore((s) => s.deleteRegion)
  const revertToOriginal = useWaveformStore((s) => s.revertToOriginal)

  const handleLoadClick = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (!file) return
      try {
        await loadFile(file)
      } catch {
        alert('音声ファイルの読み込みに失敗しました。WAV / MP3 ファイルを選択してください。')
      }
      // Reset input so same file can be reloaded
      e.target.value = ''
    },
    [loadFile]
  )

  const handleExport = useCallback(async () => {
    try {
      const blob = await exportWav()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${clip?.name ?? 'clip'}.wav`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      alert(`エクスポートに失敗しました: ${err instanceof Error ? err.message : err}`)
    }
  }, [exportWav, clip?.name])

  const handleSampleRateChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      setExportSampleRate(Number(e.target.value) as SampleRate)
    },
    [setExportSampleRate]
  )

  return (
    <div className="waveform-toolbar">
      <input
        ref={fileInputRef}
        type="file"
        accept=".wav,.mp3,.ogg,.flac,.aac,.m4a,audio/*"
        onChange={handleFileChange}
        style={{ display: 'none' }}
      />

      <div className="toolbar-group">
        <button className="toolbar-btn" onClick={handleLoadClick} disabled={isProcessing}>
          Load Audio
        </button>
        <button
          className="toolbar-btn"
          onClick={handleExport}
          disabled={!clip || isProcessing}
        >
          Export
        </button>
      </div>

      <div className="toolbar-separator" />

      <div className="toolbar-group">
        <button
          className="toolbar-btn"
          onClick={undo}
          disabled={undoStack.length === 0 || isProcessing}
          title="Undo (Ctrl+Z)"
        >
          Undo
        </button>
        <button
          className="toolbar-btn"
          onClick={redo}
          disabled={redoStack.length === 0 || isProcessing}
          title="Redo (Ctrl+Shift+Z)"
        >
          Redo
        </button>
      </div>

      <div className="toolbar-separator" />

      <div className="toolbar-group">
        <button
          className="toolbar-btn"
          onClick={cropToRegion}
          disabled={!selectedRegion || isProcessing}
          title="選択範囲でクロップ"
        >
          Crop
        </button>
        <button
          className="toolbar-btn"
          onClick={deleteRegion}
          disabled={!selectedRegion || isProcessing}
          title="選択範囲を削除"
        >
          Delete
        </button>
        <button
          className="toolbar-btn"
          onClick={revertToOriginal}
          disabled={!clip || isProcessing}
          title="元に戻す"
        >
          Revert
        </button>
      </div>

      {clip && (
        <>
          <div className="toolbar-separator" />

          <div className="toolbar-group toolbar-meta">
            <label className="toolbar-field">
              <span>Name</span>
              <input
                type="text"
                value={clip.name}
                onChange={(e) => setClipName(e.target.value)}
                className="toolbar-input"
              />
            </label>

            <label className="toolbar-field">
              <span>Rate</span>
              <select
                value={clip.exportSampleRate}
                onChange={handleSampleRateChange}
                className="toolbar-select"
              >
                <option value={44100}>44.1 kHz</option>
                <option value={24000}>24 kHz</option>
                <option value={16000}>16 kHz</option>
              </select>
            </label>

            <label className="toolbar-field">
              <span>Event ID</span>
              <input
                type="text"
                value={clip.eventId ?? ''}
                onChange={(e) => setEventId(e.target.value)}
                placeholder="impact.hit"
                className="toolbar-input"
              />
            </label>

            <label className="toolbar-field toolbar-checkbox">
              <input
                type="checkbox"
                checked={exportAsMono}
                onChange={(e) => setExportAsMono(e.target.checked)}
              />
              <span>Mono Export</span>
            </label>
          </div>
        </>
      )}
    </div>
  )
}
