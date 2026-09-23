import { useEffect, useState } from 'react'
import type { EditorPlayback } from '@/utils/editorPlayback'
import type { EditorBufferPlayer } from '@/utils/editorBufferPlayer'
import { useEditorSettings } from '@/stores/editorSettings'
import { useWaveformStore } from '@/stores/waveformStore'
import { useI18n } from '@/i18n/I18nProvider'

export function TransportBar({ player: ws, available, playback, pending, muted, onMutedChange }: {
  player: EditorBufferPlayer; available: boolean; playback: EditorPlayback | null; pending: boolean; muted: boolean; onMutedChange: (value: boolean) => void
}) {
  const { t } = useI18n()
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const loop = useEditorSettings(s => s.loop)
  const loopDelay = useEditorSettings(s => s.loopDelay)
  const updateSettings = useEditorSettings(s => s.update)
  const region = useWaveformStore(s => s.selectedRegion)
  const processing = useWaveformStore(s => s.isProcessing)
  const setError = useWaveformStore(s => s.setError)
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
      <button className="transport-btn play-btn" disabled={!available || processing} aria-label={playing || pending ? t('wave.pause') : t('wave.play')} onClick={() => void playback?.toggle().catch(setError)}><span className="transport-label-stack" aria-hidden="true"><span style={{visibility: playing || pending ? 'hidden' : 'visible'}}>{t('wave.play')}</span><span style={{visibility: playing || pending ? 'visible' : 'hidden'}}>{t('wave.pause')}</span></span></button>
      <button className="transport-btn" disabled={!available} onClick={() => {playback?.stop(); ws?.setTime(0)}}>{t('wave.stop')}</button>
      <button className="toolbar-btn" disabled={!available || !region || processing} onClick={() => void playback?.play(region!.start, region!.end).catch(setError)}>{t('editor.playSelection')}</button>
    </div>
    <span className="transport-time">{time.toFixed(3)} / {(ws?.getDuration() ?? 0).toFixed(3)} s</span>
    <label><input type="checkbox" checked={loop} onChange={e => updateSettings({loop: e.target.checked})} />{t('editor.loop')}</label>
    <label className="editor-loop-delay">{t('editor.loopDelay')}<input type="number" min={0} max={60} step={.1} value={loopDelay} onChange={e => updateSettings({loopDelay: Math.max(0, Math.min(60, Number(e.target.value) || 0))})} />s</label>
    <span className="editor-output-note">{t('editor.outputTargets')}</span>
    <label><input type="checkbox" checked={!muted} onChange={e => onMutedChange(!e.target.checked)} />{t('editor.sound')}</label>
  </div>
}
