import { useEffect, useState } from 'react'
import type { EditorPlayback } from '@/utils/editorPlayback'
import type { EditorBufferPlayer } from '@/utils/editorBufferPlayer'
import { useEditorSettings } from '@/stores/editorSettings'
import { useWaveformStore } from '@/stores/waveformStore'
import { useI18n } from '@/i18n/I18nProvider'

/** Play / stop (two states; stopping rewinds), loop and loop silence. A selection limits playback to it. */
export function TransportBar({ player: ws, available, playback, pending, onToggle, onFromStart }: {
  player: EditorBufferPlayer; available: boolean; playback: EditorPlayback | null; pending: boolean; onToggle: () => void; onFromStart: () => void
}) {
  const { t } = useI18n()
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const loop = useEditorSettings(s => s.loop)
  const loopDelay = useEditorSettings(s => s.loopDelay)
  const updateSettings = useEditorSettings(s => s.update)
  const region = useWaveformStore(s => s.selectedRegion)
  const processing = useWaveformStore(s => s.isProcessing)
  useEffect(() => { playback?.configure(region, loop, loopDelay) }, [playback, region, loop, loopDelay])
  useEffect(() => {
    setPlaying(ws?.isPlaying() ?? false); setTime(ws?.getCurrentTime() ?? 0)
    if (!ws) return
    const unsubs = [ws.on('play', () => setPlaying(true)), ws.on('pause', () => setPlaying(false)), ws.on('timeupdate', setTime), ws.on('finish', () => {
      setPlaying(false)
    })]
    return () => unsubs.forEach(unsub => unsub())
  }, [ws, playback])
  return <div className="transport-bar">
    <div className="transport-buttons">
      <button className="transport-btn" disabled={!available || processing} title={t('editor.playFromStart')} aria-label={t('editor.playFromStart')} onClick={onFromStart}>⏮</button>
      <button className="transport-btn play-btn" disabled={!available || processing} aria-label={playing || pending ? t('wave.stop') : t('wave.play')} onClick={onToggle}><span className="transport-label-stack" aria-hidden="true"><span style={{visibility: playing || pending ? 'hidden' : 'visible'}}>▶ {t('wave.play')}</span><span style={{visibility: playing || pending ? 'visible' : 'hidden'}}>■ {t('wave.stop')}</span></span></button>
    </div>
    <span className="transport-time">{time.toFixed(3)} / {(ws?.getDuration() ?? 0).toFixed(3)} s</span>
    <label className="editor-checkbox"><input type="checkbox" checked={loop} onChange={e => updateSettings({loop: e.target.checked})} />{t('editor.loop')}</label>
    <label className="editor-loop-delay">{t('editor.loopDelay')}<input type="number" min={0} max={60} step={.1} value={loopDelay} onChange={e => updateSettings({loopDelay: Math.max(0, Math.min(60, Number(e.target.value) || 0))})} />s</label>
  </div>
}
