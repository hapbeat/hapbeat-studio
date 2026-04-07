import { useRef, useCallback, useEffect, Component, type ReactNode } from 'react'
import { WaveformDisplay, type WaveformDisplayHandle } from './WaveformDisplay'
import { WaveformToolbar } from './WaveformToolbar'
import { TransportBar } from './TransportBar'
import { StatusBar } from './StatusBar'
import { EffectsPanel } from './EffectsPanel'
import { useWaveformStore } from '@/stores/waveformStore'
import './WaveformEditor.css'

/** Error boundary to prevent full-page crash */
class EditorErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('WaveformEditor error:', error, info)
  }

  render() {
    if (this.state.error) {
      return (
        <div className="waveform-error-boundary">
          <div className="error-title">エラーが発生しました</div>
          <div className="error-message">{this.state.error.message}</div>
          <button
            className="toolbar-btn"
            onClick={() => this.setState({ error: null })}
          >
            再試行
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

export function WaveformEditor() {
  return (
    <EditorErrorBoundary>
      <WaveformEditorInner />
    </EditorErrorBoundary>
  )
}

function WaveformEditorInner() {
  const displayRef = useRef<WaveformDisplayHandle>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const clip = useWaveformStore((s) => s.clip)
  const isProcessing = useWaveformStore((s) => s.isProcessing)
  const loadFile = useWaveformStore((s) => s.loadFile)

  // Drag and drop file loading
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'copy'
  }, [])

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()

      const file = e.dataTransfer.files[0]
      if (!file) return

      const ext = file.name.toLowerCase().split('.').pop()
      const supportedFormats = ['wav', 'mp3', 'ogg', 'flac', 'aac', 'm4a']
      if (!ext || !supportedFormats.includes(ext)) return

      try {
        await loadFile(file)
      } catch (err) {
        console.error('File load error:', err)
      }
    },
    [loadFile]
  )

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA') {
        return
      }

      const ws = displayRef.current?.wavesurfer
      const store = useWaveformStore.getState()

      if (e.key === ' ' && ws) {
        e.preventDefault()
        ws.playPause()
      } else if (e.key === 'z' && (e.ctrlKey || e.metaKey) && e.shiftKey) {
        e.preventDefault()
        store.redo()
      } else if (e.key === 'z' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        store.undo()
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (store.selectedRegion) {
          e.preventDefault()
          store.deleteRegion()
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  return (
    <div
      ref={containerRef}
      className="waveform-editor"
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <WaveformToolbar />

      <div className="waveform-main">
        {!clip && (
          <div className="waveform-empty">
            <div className="empty-icon">~</div>
            <div className="empty-message">音声ファイルをドラッグ＆ドロップ</div>
            <div className="empty-hint">
              または上部の「Load Audio」ボタンからファイルを選択（WAV / MP3 等）
            </div>
          </div>
        )}
        <div style={{ display: clip ? 'block' : 'none' }}>
          <WaveformDisplay ref={displayRef} />
        </div>
      </div>

      <TransportBar wavesurfer={displayRef.current?.wavesurfer ?? null} />

      {clip && <EffectsPanel />}

      <StatusBar />

      {isProcessing && (
        <div className="processing-overlay">
          <div className="processing-spinner" />
          <span>処理中...</span>
        </div>
      )}
    </div>
  )
}
