import { useEffect, useRef, useState } from 'react'
import { useI18n } from '@/i18n/I18nProvider'
import './VideoOverlay.css'

/**
 * Playback controls laid over the bottom edge of a video (like a web video player):
 * ⏸/▶, a thin seek bar with a tick at the cue mark, the time from the event start
 * (the mark = 0 s, two decimals) and ⓘ with the usage notes as its title. Shown
 * while hovered or while the video is paused / stopped; hidden during playback once
 * the pointer leaves. The overlay takes no layout space.
 */
export function VideoOverlay({ video, mark, playing, onToggle, onSeek, info }: {
  /** The video element (read every frame for the bar and the time). */
  video: HTMLVideoElement | null
  /** Video time of the cue mark (seconds); null = no mark (time shown as the video time). */
  mark: number | null
  /** Shows ⏸ (else ▶). The overlay stays visible while this is false. */
  playing: boolean
  onToggle: () => void
  /** Seek to this video time (seconds). */
  onSeek: (videoTime: number) => void
  /** Usage notes (title of ⓘ). */
  info: string
}) {
  const { t } = useI18n()
  const fill = useRef<HTMLDivElement>(null)
  const time = useRef<HTMLSpanElement>(null)
  const [duration, setDuration] = useState(0)
  useEffect(() => {
    let frame = 0
    const draw = () => {
      const d = video && Number.isFinite(video.duration) ? video.duration : 0
      if (d !== duration) setDuration(d)
      if (video && fill.current) fill.current.style.width = d > 0 ? `${Math.min(100, video.currentTime / d * 100)}%` : '0%'
      if (video && time.current) time.current.textContent = `${(mark === null ? video.currentTime : video.currentTime - mark).toFixed(2)} s`
      frame = requestAnimationFrame(draw)
    }
    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [video, mark, duration])
  const dragging = useRef(false)
  const seekAt = (event: React.PointerEvent<HTMLDivElement>) => {
    const r = event.currentTarget.getBoundingClientRect()
    if (duration > 0 && r.width > 0) onSeek(Math.max(0, Math.min(1, (event.clientX - r.left) / r.width)) * duration)
  }
  const label = t(playing ? 'scene.overlay.pause' : 'scene.overlay.play')
  return <div className={`video-overlay ${playing ? '' : 'shown'}`} onClick={e => e.stopPropagation()}>
    <button type="button" className="video-overlay-btn" aria-label={label} title={label} onClick={onToggle}>{playing ? '⏸' : '▶'}</button>
    <div className="video-overlay-bar" role="slider" aria-label={t('scene.overlay.seek')} aria-valuemin={0} aria-valuemax={duration} tabIndex={-1}
      onPointerDown={e => { dragging.current = true; e.currentTarget.setPointerCapture(e.pointerId); seekAt(e) }}
      onPointerMove={e => { if (dragging.current) seekAt(e) }}
      onPointerUp={e => { dragging.current = false; if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId) }}
      onPointerCancel={() => { dragging.current = false }}>
      <div className="video-overlay-track"><div className="video-overlay-fill" ref={fill} /></div>
      {mark !== null && duration > 0 && <div className="video-overlay-mark" style={{ left: `${Math.min(100, mark / duration * 100)}%` }} />}
    </div>
    <span className="video-overlay-time" ref={time} />
    <span className="video-overlay-info" title={info} aria-label={info}>ⓘ</span>
  </div>
}
