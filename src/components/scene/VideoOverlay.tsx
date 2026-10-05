import { useEffect, useRef, useState } from 'react'
import { useI18n } from '@/i18n/I18nProvider'
import './VideoOverlay.css'

/**
 * Playback controls laid over the bottom edge of a video (like a web video player):
 * ⏸/▶, a thin seek bar with a tick at the cue mark, the time from the event start
 * (the mark = 0 s, two decimals) and ⓘ with the usage notes as its title. Always
 * shown (the position stays visible); it takes no layout space.
 */
export function VideoOverlay({ video, mark, marks, range, playing, onToggle, onSeek, info, target }: {
  /** The video element (read every frame for the bar and the time). */
  video: HTMLVideoElement | null
  /** Video time of the cue mark (seconds); null = no mark (time shown as the video time). */
  mark: number | null
  /** Ticks on the bar (video times; `target` false = grey; `name` in the tooltip); default: `mark`. */
  marks?: readonly { t: number; target?: boolean; name?: string }[]
  /** The cue being rated: a small badge top left, always shown. */
  target?: string | null
  /** The stretch the bar spans (video times); default: the whole video. */
  range?: readonly [number, number] | null
  /** Shows ⏸ (else ▶). */
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
      const [from, to] = range ?? [0, d]
      if (video && fill.current) fill.current.style.width = to > from ? `${Math.max(0, Math.min(100, (video.currentTime - from) / (to - from) * 100))}%` : '0%'
      if (video && time.current) time.current.textContent = `${(mark === null ? video.currentTime : video.currentTime - mark).toFixed(2)} s`
      frame = requestAnimationFrame(draw)
    }
    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [video, mark, duration, range?.[0], range?.[1]])
  const [from, to] = range ?? [0, duration]
  const ticks = marks ?? (mark === null ? [] : [{ t: mark, target: true }])
  const dragging = useRef(false)
  const seekAt = (event: React.PointerEvent<HTMLDivElement>) => {
    const r = event.currentTarget.getBoundingClientRect()
    if (to > from && r.width > 0) onSeek(from + Math.max(0, Math.min(1, (event.clientX - r.left) / r.width)) * (to - from))
  }
  const label = t(playing ? 'scene.overlay.pause' : 'scene.overlay.play')
  return <>{target && <span className="target-cue-badge video-overlay-target" title={t('editor.scene.targetHint')}>{t('editor.scene.rating', { name: target })}</span>}
  <div className="video-overlay" onClick={e => e.stopPropagation()}>
    <button type="button" className="video-overlay-btn" aria-label={label} title={label} onClick={onToggle}>{playing ? '⏸' : '▶'}</button>
    <div className="video-overlay-bar" role="slider" aria-label={t('scene.overlay.seek')} aria-valuemin={0} aria-valuemax={duration} tabIndex={-1}
      onPointerDown={e => { dragging.current = true; e.currentTarget.setPointerCapture(e.pointerId); seekAt(e) }}
      onPointerMove={e => { if (dragging.current) seekAt(e) }}
      onPointerUp={e => { dragging.current = false; if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId) }}
      onPointerCancel={() => { dragging.current = false }}>
      <div className="video-overlay-track"><div className="video-overlay-fill" ref={fill} /></div>
      {to > from && ticks.filter(x => x.t >= from && x.t <= to).map(x => <div key={x.t} className={`video-overlay-mark ${x.target === false ? 'other' : ''}`} title={`${x.name ?? ''} ${(mark === null ? x.t : x.t - mark).toFixed(2)} s`.trim()} style={{ left: `${(x.t - from) / (to - from) * 100}%` }} />)}
    </div>
    <span className="video-overlay-time" ref={time} />
    <span className="video-overlay-info" title={info} aria-label={info}>ⓘ</span>
  </div></>
}
