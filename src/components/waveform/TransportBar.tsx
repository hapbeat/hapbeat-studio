import { useState, useEffect, useCallback } from 'react'
import type WaveSurfer from 'wavesurfer.js'
import { formatDuration } from '@/utils/wavIO'
import { useWaveformStore } from '@/stores/waveformStore'
import { useI18n } from '@/i18n/I18nProvider'

interface TransportBarProps {
  wavesurfer: WaveSurfer | null
}

export function TransportBar({ wavesurfer }: TransportBarProps) {
  const { t } = useI18n()
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const clip = useWaveformStore((s) => s.clip)
  const duration = clip?.buffer.duration ?? 0

  useEffect(() => {
    if (!wavesurfer) return

    const onPlay = () => setIsPlaying(true)
    const onPause = () => setIsPlaying(false)
    const onFinish = () => setIsPlaying(false)
    const onTimeUpdate = (time: number) => setCurrentTime(time)

    wavesurfer.on('play', onPlay)
    wavesurfer.on('pause', onPause)
    wavesurfer.on('finish', onFinish)
    wavesurfer.on('timeupdate', onTimeUpdate)

    return () => {
      wavesurfer.un('play', onPlay)
      wavesurfer.un('pause', onPause)
      wavesurfer.un('finish', onFinish)
      wavesurfer.un('timeupdate', onTimeUpdate)
    }
  }, [wavesurfer])

  const handlePlayPause = useCallback(() => {
    if (!wavesurfer) return
    wavesurfer.playPause()
  }, [wavesurfer])

  const handleStop = useCallback(() => {
    if (!wavesurfer) return
    wavesurfer.stop()
    setCurrentTime(0)
  }, [wavesurfer])

  const handleSkipStart = useCallback(() => {
    if (!wavesurfer) return
    wavesurfer.setTime(0)
    setCurrentTime(0)
  }, [wavesurfer])

  const handleSkipEnd = useCallback(() => {
    if (!wavesurfer) return
    wavesurfer.setTime(duration)
    setCurrentTime(duration)
  }, [wavesurfer, duration])

  return (
    <div className="transport-bar">
      <div className="transport-buttons">
        <button
          className="transport-btn"
          onClick={handleSkipStart}
          disabled={!clip}
          title={t('wave.start')}
        >
          ⏮
        </button>
        <button
          className="transport-btn play-btn"
          onClick={handlePlayPause}
          disabled={!clip}
          title={isPlaying ? t('wave.pause') : t('wave.play')}
        >
          {isPlaying ? '⏸' : '▶'}
        </button>
        <button
          className="transport-btn"
          onClick={handleStop}
          disabled={!clip}
          title={t('wave.stop')}
        >
          ⏹
        </button>
        <button
          className="transport-btn"
          onClick={handleSkipEnd}
          disabled={!clip}
          title={t('wave.end')}
        >
          ⏭
        </button>
      </div>
      <div className="transport-time">
        <span className="time-current">{formatDuration(currentTime)}</span>
        <span className="time-separator">/</span>
        <span className="time-total">{formatDuration(duration)}</span>
      </div>
    </div>
  )
}
