import { useEffect, useRef, useState } from 'react'
import { useI18n } from '@/i18n/I18nProvider'
import { useSceneStore } from '@/stores/sceneStore'
import { useScene } from './sceneContext'
import { useSceneProjectActions } from './useSceneProjectActions'
import { VideoOverlay } from './VideoOverlay'

/** The clip / replay video (the runtime's element, moved in here) with the time-to-cue badge, or the "open a project" start screen. */
export function SceneVideoPanel() {
  const { t } = useI18n()
  const { runtime } = useScene()
  const stage = useRef<HTMLDivElement>(null)
  const badge = useRef<HTMLDivElement>(null)
  const hasItems = useSceneStore(s => s.items.length > 0)
  const empty = useSceneStore(s => s.empty)
  const { open, reopen, rememberedName, busy } = useSceneProjectActions()
  // Overlay: ⏸/▶ follows the runtime's video; the bar's mark is the clip's cue (the full recording has none).
  const [playing, setPlaying] = useState(false)
  useEffect(() => {
    const v = runtime.video, sync = () => setPlaying(!v.paused)
    v.addEventListener('play', sync); v.addEventListener('pause', sync); sync()
    return () => { v.removeEventListener('play', sync); v.removeEventListener('pause', sync) }
  }, [runtime])
  const mark = useSceneStore(s => { const it = s.items[s.cur]; return it?.kind === 'clip' ? it.event : null })

  useEffect(() => {
    const host = stage.current
    if (!host) return
    host.appendChild(runtime.video)
    let frame = 0
    const draw = () => {
      const s = useSceneStore.getState(), it = s.items[s.cur], el = badge.current, v = runtime.video
      if (el && it) {
        const time = v.currentTime
        if (it.kind === 'clip') {
          const d = time - it.event
          el.textContent = `${it.name} ${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(2)} s`
          el.classList.toggle('scene-badge-hit', Math.abs(d) < 0.07)
        } else {
          const ticks = s.lib?.ticks ?? []
          const prev = s.data?.full.events.filter(x => !ticks.includes(x.name) && x.t <= time).pop()
          el.textContent = prev ? `${prev.name} +${(time - prev.t).toFixed(2)} s` : `${time.toFixed(2)} s`
          el.classList.remove('scene-badge-hit')
        }
      }
      frame = requestAnimationFrame(draw)
    }
    frame = requestAnimationFrame(draw)
    return () => { cancelAnimationFrame(frame); if (runtime.video.parentElement === host) host.removeChild(runtime.video) }
  }, [runtime])

  return <div className="scene-stage" ref={stage} onClick={() => { if (!hasItems) return; runtime.audio(); runtime.togglePlay() }}>
    <div className="scene-badge" ref={badge} hidden={!hasItems} />
    {hasItems && <VideoOverlay video={runtime.video} mark={mark} playing={playing} info={t('scene.keys')}
      onToggle={() => { runtime.audio(); runtime.togglePlay() }} onSeek={time => runtime.seek(time)} />}
    {!hasItems && <div className="scene-empty" onClick={e => e.stopPropagation()}>
      <div className="scene-empty-message">{empty ? t(empty.id, empty.params) : t('scene.empty.intro')}</div>
      <div className="scene-empty-actions">
        <button type="button" className="toolbar-btn primary" disabled={busy} onClick={() => void open()}>{t('scene.open')}</button>
        {rememberedName && <button type="button" className="toolbar-btn" disabled={busy} onClick={() => void reopen()}>{t('scene.reopenNamed', { name: rememberedName })}</button>}
      </div>
    </div>}
  </div>
}
