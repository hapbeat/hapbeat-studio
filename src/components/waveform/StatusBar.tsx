import { useWaveformStore } from '@/stores/waveformStore'
import { validateWavForExport, estimateWavSize, formatFileSize } from '@/utils/wavIO'

export function StatusBar() {
  const clip = useWaveformStore((s) => s.clip)
  const exportAsMono = useWaveformStore((s) => s.exportAsMono)

  if (!clip) {
    return (
      <div className="status-bar">
        <span className="status-item">WAV ファイルを読み込んでください</span>
      </div>
    )
  }

  const { buffer, exportSampleRate } = clip
  const exportChannels = exportAsMono ? 1 : buffer.numberOfChannels
  const estimatedSize = estimateWavSize(buffer.duration, exportSampleRate, exportChannels)
  const validation = validateWavForExport(buffer, exportSampleRate)
  const sizeExceeded = estimatedSize > 1024 * 1024

  return (
    <div className="status-bar">
      <span className="status-item">
        PCM 16-bit {buffer.numberOfChannels === 1 ? 'mono' : 'stereo'}
      </span>
      <span className="status-separator">|</span>
      <span className="status-item">Source: {buffer.sampleRate} Hz</span>
      <span className="status-separator">|</span>
      <span className="status-item">Export: {exportSampleRate} Hz</span>
      {exportAsMono && buffer.numberOfChannels > 1 && (
        <>
          <span className="status-separator">|</span>
          <span className="status-item status-info">Mono Export</span>
        </>
      )}
      <span className="status-separator">|</span>
      <span className={`status-item ${sizeExceeded ? 'status-error' : ''}`}>
        Size: {formatFileSize(estimatedSize)} / 1024 KB max
      </span>
      {validation.warnings.map((w, i) => (
        <span key={i} className="status-item status-warning">
          {w}
        </span>
      ))}
      {validation.errors.map((e, i) => (
        <span key={i} className="status-item status-error">
          {e}
        </span>
      ))}
    </div>
  )
}
