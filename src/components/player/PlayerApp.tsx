import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useI18n } from '@/i18n/I18nProvider'
import { usePageVisible } from '@/hooks/usePageVisible'
import { useHelperConnection } from '@/hooks/useHelperConnection'
import { playerApi, PLAYER_HAPTICS_OFF, type PlayerHelperStatus } from '@/config/playerShell'
import { useSceneStore } from '@/stores/sceneStore'
import { useSceneSettings } from '@/stores/sceneSettings'
import { OVERALL_GAIN_MAX, useScenePlayback } from '@/stores/scenePlayback'
import { openBundledProject } from '@/utils/bundledProject'
import { pageVisible, perfTrack } from '@/utils/perfRegistry'
import { isTypingTarget } from '@/utils/playbackShortcut'
import { clockText } from '@/utils/sceneData'
import { SceneRuntime } from '@/components/scene/sceneRuntime'
import { useSceneRuntimeHelper } from '@/components/scene/useSceneRuntimeHelper'
import './PlayerApp.css'

/** While playing, the bar and the cursor hide this long after the pointer last moved. */
const HIDE_AFTER_MS = 2500
/** Notices about the connection wait this long after launch, so they do not flash during a normal start-up. */
const NOTICE_DELAY_MS = 6000
const ARROW_SEEK_SEC = 5

const blurActive = () => { (document.activeElement as HTMLElement | null)?.blur?.() }

/** The bundled helper's state from the app (null in a browser), and its restart. */
function usePlayerHelperStatus(): { status: PlayerHelperStatus | null; restart: () => void } {
  const [status, setStatus] = useState<PlayerHelperStatus | null>(null)
  useEffect(() => {
    const helper = playerApi()?.helper
    if (!helper) return
    void helper.status().then(setStatus, () => {})
    return helper.onStatus(setStatus)
  }, [])
  const restart = useCallback(() => { void playerApi()?.helper.restart().then(setStatus, () => {}) }, [])
  return { status, restart }
}

/** The seek bar with position and duration: drawn per animation frame through refs, no React render per frame. */
function PlayerSeek({ runtime }: { runtime: SceneRuntime }) {
  const { t } = useI18n()
  const bar = useRef<HTMLDivElement>(null)
  const fill = useRef<HTMLDivElement>(null)
  const time = useRef<HTMLSpanElement>(null)
  const dragging = useRef(false)
  useEffect(() => {
    const video = runtime.video
    let frame = 0
    const draw = () => {
      const d = Number.isFinite(video.duration) ? video.duration : 0
      if (fill.current) fill.current.style.width = d > 0 ? `${Math.max(0, Math.min(100, video.currentTime / d * 100))}%` : '0%'
      if (time.current) time.current.textContent = `${clockText(video.currentTime)} / ${clockText(d)}`
      bar.current?.setAttribute('aria-valuemax', String(d))
      bar.current?.setAttribute('aria-valuenow', String(video.currentTime))
    }
    // Animated only while the video plays (and the page is visible); otherwise redrawn on the video's events.
    const loop = () => { draw(); frame = requestAnimationFrame(loop) }
    const start = () => { if (!frame && !video.paused && pageVisible()) { perfTrack('rafLoops', 1); frame = requestAnimationFrame(loop) } }
    const stop = () => { if (frame) { cancelAnimationFrame(frame); frame = 0; perfTrack('rafLoops', -1) } draw() }
    const onVisibility = () => { if (pageVisible()) start(); else stop() }
    const events = ['play', 'playing'] as const, still = ['pause', 'seeked', 'timeupdate', 'loadedmetadata', 'durationchange', 'ended'] as const
    for (const e of events) video.addEventListener(e, start)
    for (const e of still) video.addEventListener(e, e === 'pause' || e === 'ended' ? stop : draw)
    document.addEventListener('visibilitychange', onVisibility)
    draw(); start()
    return () => {
      stop()
      for (const e of events) video.removeEventListener(e, start)
      for (const e of still) video.removeEventListener(e, e === 'pause' || e === 'ended' ? stop : draw)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [runtime])
  const seekAt = (event: React.PointerEvent<HTMLDivElement>) => {
    const r = event.currentTarget.getBoundingClientRect(), d = runtime.video.duration
    if (Number.isFinite(d) && d > 0 && r.width > 0) runtime.seek(Math.max(0, Math.min(1, (event.clientX - r.left) / r.width)) * d)
  }
  return <div className="player-seek-row">
    <div className="player-seek" ref={bar} role="slider" aria-label={t('player.seek')} aria-valuemin={0} tabIndex={-1}
      onPointerDown={e => { dragging.current = true; e.currentTarget.setPointerCapture(e.pointerId); seekAt(e) }}
      onPointerMove={e => { if (dragging.current) seekAt(e) }}
      onPointerUp={e => { dragging.current = false; if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId) }}
      onPointerCancel={() => { dragging.current = false }}>
      <div className="player-seek-track"><div className="player-seek-fill" ref={fill} /></div>
    </div>
    <span className="player-time" ref={time} />
  </div>
}

/**
 * The whole window of the player app (`?shell=player`): the project the app bundles, played by the Scene tab's engine
 * (SceneRuntime) with the same helper wiring (useSceneRuntimeHelper). No authoring: nothing here edits the project,
 * and every connected Hapbeat plays every route, whatever its position (allDevices). It stays paused until the user presses play.
 */
export function PlayerApp() {
  const { t } = useI18n()
  const runtime = useMemo(() => new SceneRuntime(), [])
  const root = useRef<HTMLDivElement>(null)
  const stage = useRef<HTMLDivElement>(null)

  const opening = useRef(false)
  useEffect(() => {
    useSceneSettings.getState().update({ pcSound: true, loop: true, sendHaptics: !PLAYER_HAPTICS_OFF })
    useScenePlayback.getState().update({ output: 'clip', allDevices: true })
    if (opening.current) return
    opening.current = true
    void openBundledProject().then(handle => useSceneStore.getState().openBundled(handle)).catch(error => {
      useSceneStore.getState().note({ id: 'scene.open.failed', params: { error: error instanceof Error ? error.message : String(error) }, error: true })
    })
  }, [])

  useEffect(() => () => runtime.dispose(), [runtime])
  // The runtime (10 ms tick, video) runs only while the page is visible. The app keeps its page visible (so the timing
  // holds behind other windows) and says when the window is minimized instead: playback pauses then.
  const visible = usePageVisible()
  useEffect(() => {
    if (visible) runtime.start()
    else { runtime.video.pause(); runtime.stop() }
  }, [visible, runtime])
  useEffect(() => playerApi()?.onMinimize(() => runtime.video.pause()), [runtime])
  useEffect(() => {
    const video = runtime.video
    stage.current?.appendChild(video)
    return () => video.remove()
  }, [runtime])

  const { isConnected, targetDevices } = useSceneRuntimeHelper(runtime)
  const { helperVersion } = useHelperConnection()
  const { status: helperStatus, restart: restartHelper } = usePlayerHelperStatus()

  const ready = useSceneStore(s => s.items.length > 0 && !s.busy)
  const busy = useSceneStore(s => s.busy)
  const table = useSceneStore(s => s.table)
  const chapters = useSceneStore(s => s.data?.chapters)
  const chapter = useSceneStore(s => s.chapter)
  const notice = useSceneStore(s => s.notice)
  const loop = useSceneSettings(s => s.loop)
  const pcSound = useSceneSettings(s => s.pcSound)
  const sendHaptics = useSceneSettings(s => s.sendHaptics)
  const videoVolume = useScenePlayback(s => s.videoVolume)
  const overallGain = useScenePlayback(s => s.overallGain)

  const [playing, setPlaying] = useState(false)
  const [started, setStarted] = useState(false)
  useEffect(() => {
    const video = runtime.video
    const sync = () => setPlaying(!video.paused && !video.ended)
    const onPlay = () => { setStarted(true); sync() }
    video.addEventListener('play', onPlay); video.addEventListener('pause', sync); video.addEventListener('ended', sync)
    return () => { video.removeEventListener('play', onPlay); video.removeEventListener('pause', sync); video.removeEventListener('ended', sync) }
  }, [runtime])

  const togglePlay = useCallback(() => {
    if (!useSceneStore.getState().items.length) return
    runtime.audio()
    runtime.togglePlay()
  }, [runtime])
  const toggleLoop = useCallback(() => { useSceneSettings.getState().update({ loop: !useSceneSettings.getState().loop }); runtime.applyLoop() }, [runtime])
  const toggleHaptics = useCallback(() => { if (!PLAYER_HAPTICS_OFF) useSceneSettings.getState().update({ sendHaptics: !useSceneSettings.getState().sendHaptics }) }, [])
  const playChapter = useCallback((index: number) => { runtime.audio(); runtime.playChapter(index) }, [runtime])

  const [fullscreen, setFullscreen] = useState(false)
  useEffect(() => {
    const sync = () => setFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', sync)
    return () => document.removeEventListener('fullscreenchange', sync)
  }, [])
  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
    else void root.current?.requestFullscreen().catch(() => {})
  }, [])

  // The bar and the cursor hide while playing, after a while without the pointer moving (or a key); while paused the bar stays.
  const [idle, setIdle] = useState(false)
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const wake = useCallback(() => {
    setIdle(false)
    if (idleTimer.current) clearTimeout(idleTimer.current)
    idleTimer.current = runtime.video.paused ? null : setTimeout(() => setIdle(true), HIDE_AFTER_MS)
  }, [runtime])
  useEffect(() => {
    wake()
    return () => { if (idleTimer.current) clearTimeout(idleTimer.current) }
  }, [playing, wake])

  // Keys. No App here to forward Space. Capture: before a focused control can take the key.
  useEffect(() => {
    const keydown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing || isTypingTarget(e.target)) return
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key, video = runtime.video
      if (key === 'ArrowLeft' || key === 'ArrowRight') runtime.seek(video.currentTime + (key === 'ArrowRight' ? ARROW_SEEK_SEC : -ARROW_SEEK_SEC))
      else if (key === ' ') { if (!e.repeat) togglePlay() }
      else if (key === 'f') { if (!e.repeat) toggleFullscreen() }
      else if (key === 'm') { if (!e.repeat) useSceneSettings.getState().update({ pcSound: !useSceneSettings.getState().pcSound }) }
      else if (key === 'h') { if (!e.repeat) toggleHaptics() }
      else if (key === 'l') { if (!e.repeat) toggleLoop() }
      else if (/^[1-9]$/.test(key) && Number(key) <= (useSceneStore.getState().data?.chapters.length ?? 0)) { if (!e.repeat) playChapter(Number(key) - 1) }
      else return
      e.preventDefault()
      wake()
    }
    window.addEventListener('keydown', keydown, true)
    return () => window.removeEventListener('keydown', keydown, true)
  }, [runtime, togglePlay, toggleFullscreen, toggleHaptics, toggleLoop, playChapter, wake])

  const [settled, setSettled] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(true), NOTICE_DELAY_MS)
    return () => clearTimeout(timer)
  }, [])

  const helperDown = helperStatus?.state === 'crashed' || helperStatus?.state === 'missing'
  // The app found something on the helper's port and left it alone (another helper), yet the page cannot reach it.
  const portBusy = settled && !isConnected && helperStatus?.state === 'external'
  const chip = !isConnected ? t(helperDown ? 'player.status.helperStopped' : portBusy ? 'player.status.helperUnreachable' : 'player.status.helperStarting')
    : targetDevices.length ? t('player.status.devices', { count: targetDevices.length }) : t('player.status.noDevice')
  const chipTitle = targetDevices.map(d => d.name || d.ipAddress).join(', ') || undefined
  const oldHelper = !!helperVersion && Number.parseInt(helperVersion, 10) < 1
  const hapticsOn = sendHaptics && !PLAYER_HAPTICS_OFF

  return <div className="player" ref={root} data-idle={idle || undefined}
    onPointerDown={() => { if (useSceneStore.getState().items.length) runtime.audio() }}
    onPointerMove={e => { if (e.movementX || e.movementY) wake() }}>
    <div className="player-stage" ref={stage} onClick={togglePlay} />
    {!started && ready && <button type="button" className="player-bigplay" aria-label={t('player.play')} title={t('player.play')}
      onClick={e => { e.currentTarget.blur(); togglePlay() }}>▶</button>}
    {busy && <div className="player-loading">{t('player.loading')}</div>}
    <div className="player-notices" role="status">
      {settled && helperDown && <div className="player-notice error">
        <span>{t('player.notice.helperFailed', { error: helperStatus?.error ?? helperStatus?.state })}</span>
        <button type="button" className="player-btn" onClick={e => { e.currentTarget.blur(); restartHelper() }}>{t('player.restart')}</button>
      </div>}
      {portBusy && <div className="player-notice error">{t('player.notice.portBusy', { port: helperStatus?.port ?? 7703 })}</div>}
      {settled && isConnected && oldHelper && <div className="player-notice error">{t('player.notice.oldHelper', { version: helperVersion })}</div>}
      {settled && isConnected && !!table && !targetDevices.length && <div className="player-notice">{t('player.notice.noDevice')}</div>}
      {notice?.error && <div className="player-notice error">{t(notice.id, notice.params)}</div>}
    </div>
    <div className="player-bar" onClick={blurActive} onPointerUp={blurActive}>
      <PlayerSeek runtime={runtime} />
      <div className="player-controls">
        <button type="button" className="player-btn player-play" onClick={togglePlay}>{t(playing ? 'player.pause' : 'player.play')}</button>
        <div className="player-chapters" role="group" aria-label={t('player.chapters')}>
          {chapters?.map((c, i) => <button type="button" key={`${c.start}:${c.label}`} className="player-btn player-chapter" title={`${clockText(c.start)} – ${clockText(c.end)} ${c.label}`}
            aria-pressed={chapter === i} onClick={() => playChapter(i)}>{c.label}</button>)}
        </div>
        <button type="button" className="player-btn" aria-pressed={loop} onClick={toggleLoop}>{t('player.loop')}</button>
        <label className="player-slider" data-off={pcSound ? undefined : true}>
          <span>{t('player.volume')}</span>
          <input type="range" min={0} max={1} step={0.01} value={videoVolume} onChange={e => useScenePlayback.getState().update({ videoVolume: Number(e.target.value) })} />
        </label>
        <label className="player-slider">
          <span>{t('player.strength')}</span>
          <input type="range" min={0} max={OVERALL_GAIN_MAX} step={0.01} value={overallGain} onChange={e => useScenePlayback.getState().update({ overallGain: Number(e.target.value) })} />
          <span className="player-percent">{Math.round(overallGain * 100)}%</span>
        </label>
        <button type="button" className="player-btn" aria-pressed={hapticsOn} disabled={PLAYER_HAPTICS_OFF} onClick={toggleHaptics}>{t('player.haptics')}</button>
        <span className="player-chip" title={chipTitle}>{chip}</span>
        <button type="button" className="player-btn" aria-pressed={fullscreen} onClick={toggleFullscreen}>{t('player.fullscreen')}</button>
      </div>
    </div>
  </div>
}
