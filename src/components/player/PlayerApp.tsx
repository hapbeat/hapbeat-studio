import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useI18n } from '@/i18n/I18nProvider'
import { usePageVisible } from '@/hooks/usePageVisible'
import { useHelperConnection } from '@/hooks/useHelperConnection'
import { isPlayerUiMode, playerApi, PLAYER_HAPTICS_OFF, PLAYER_UI_MODES, type PlayerHelperStatus, type PlayerProject, type PlayerRecentProject, type PlayerUiMode } from '@/config/playerShell'
import { useDeviceStore } from '@/stores/deviceStore'
import { useSceneStore } from '@/stores/sceneStore'
import { useSceneSettings } from '@/stores/sceneSettings'
import { OVERALL_GAIN_MAX, useScenePlayback } from '@/stores/scenePlayback'
import { openAppProject } from '@/utils/appProject'
import { playerChipDevices, resolvePlaybackTargets } from '@/utils/playbackDevices'
import { pageVisible, perfTrack } from '@/utils/perfRegistry'
import { idleHidesControls, playerPlaysAllDevices, pressOnlyShowsControls } from '@/utils/playerUi'
import { isTypingTarget } from '@/utils/playbackShortcut'
import { clockText } from '@/utils/sceneData'
import { SceneRuntime } from '@/components/scene/sceneRuntime'
import { useSceneRuntimeHelper } from '@/components/scene/useSceneRuntimeHelper'
import './PlayerApp.css'

/** The controls and the cursor hide this long after the pointer last moved (the UI mode says when they may). */
const HIDE_AFTER_MS = 2500
/** Notices about the connection wait this long after launch, so they do not flash during a normal start-up. */
const NOTICE_DELAY_MS = 6000
const ARROW_SEEK_SEC = 5
/** The hint naming a new UI mode stays this long. */
const HINT_MS = 3000
/** This page's UI mode, kept per PC (the app's data); a viewer setting, not the project's. */
const UI_MODE_KEY = 'hapbeat.player.uiMode'
const UI_MODE_LABEL = { auto: 'player.ui.auto', show: 'player.ui.show', hide: 'player.ui.hide' } as const
const UI_MODE_HINT = { auto: 'player.ui.hint.auto', show: 'player.ui.hint.show', hide: 'player.ui.hint.hide' } as const

const blurActive = () => { (document.activeElement as HTMLElement | null)?.blur?.() }
/** An Electron IPC rejection says which call failed before the reason; the reason alone is shown. */
const ipcReason = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
/** Windows paths: the same folder whatever the letter case. */
const samePath = (a: string | undefined, b: string | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase()

function readUiMode(): PlayerUiMode {
  try {
    const value = localStorage.getItem(UI_MODE_KEY)
    return isPlayerUiMode(value) ? value : 'auto'
  } catch {
    return 'auto'
  }
}
function storeUiMode(mode: PlayerUiMode) {
  try { localStorage.setItem(UI_MODE_KEY, mode) } catch { /* not kept: the next start is auto */ }
}

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
 * The whole window of the player app (`?shell=player`): the project folder chosen in the app (the one Studio's Scene tab
 * opens), played by the Scene tab's engine (SceneRuntime) with the same helper wiring (useSceneRuntimeHelper). What
 * Studio saves into that folder plays at once: the app says when the folder changed and the store reads it again
 * (checkDisk), besides its own 2-second checks. No authoring: nothing here edits the project. Each route plays on the
 * Hapbeats at its position (a neck and a wrist each get their own, as in the game); only when no Hapbeat is at a position
 * the table uses does every one play every route (allDevices, playerPlaysAllDevices). It stays paused until the user presses play.
 * The controls show as the UI mode says (top right, U key, the app's menu; PlayerUiMode), and the folder button
 * switches between the folders opened before (the app's list).
 */
export function PlayerApp() {
  const { t } = useI18n()
  const runtime = useMemo(() => new SceneRuntime(), [])
  const root = useRef<HTMLDivElement>(null)
  const stage = useRef<HTMLDivElement>(null)

  // The project folder: the one the app plays now, then whichever the user chooses (here or the app's menu).
  const [project, setProject] = useState<PlayerProject | null>(null)
  /** Whether the app has said which folder it plays (until then, no "choose a folder" screen flashes). */
  const [projectKnown, setProjectKnown] = useState(false)
  const [chooseError, setChooseError] = useState<string | null>(null)
  const openProject = useCallback((next: PlayerProject) => {
    setProject(next)
    setChooseError(null)
    void openAppProject(next.name).then(handle => useSceneStore.getState().openAppProject(handle)).catch(error => {
      useSceneStore.getState().note({ id: 'scene.open.failed', params: { error: error instanceof Error ? error.message : String(error) }, error: true })
    })
  }, [])
  useEffect(() => {
    useSceneSettings.getState().update({ pcSound: true, loop: true, sendHaptics: !PLAYER_HAPTICS_OFF })
    useScenePlayback.getState().update({ output: 'clip' })
    const api = playerApi()
    if (!api) { setProjectKnown(true); return }
    const offSwitched = api.project.onSwitched(openProject)
    // Studio saved into the folder: read again now what changed (the cue table, the Kit, the recording, WAVs).
    const offChanged = api.project.onChanged(() => { void useSceneStore.getState().checkDisk() })
    void api.project.current().then(current => { setProjectKnown(true); if (current) openProject(current) }, () => setProjectKnown(true))
    return () => { offSwitched(); offChanged() }
  }, [openProject])
  // The folders opened before: the folder button's menu (null = closed) and the "choose a folder" screen.
  const [folderMenu, setFolderMenu] = useState<PlayerRecentProject[] | null>(null)
  const [recent, setRecent] = useState<PlayerRecentProject[]>([])
  const chooseProject = useCallback(() => {
    setChooseError(null)
    setFolderMenu(null)
    // The app opens the project on its "switched" message (onSwitched), the same as after a choice from its menu.
    playerApi()?.project.choose().catch(error => setChooseError(ipcReason(error)))
  }, [])

  const readRecent = useCallback(async () => {
    const list = playerApi()?.project.recent
    return list ? await list().catch(() => []) : []
  }, [])
  const toggleFolderMenu = useCallback(() => {
    if (folderMenu) { setFolderMenu(null); return }
    // An app without the list (apiVersion 2) goes straight to the folder dialog.
    if (!playerApi()?.project.recent) { chooseProject(); return }
    void readRecent().then(setFolderMenu)
  }, [folderMenu, chooseProject, readRecent])
  const openRecent = useCallback((entry: PlayerRecentProject) => {
    setFolderMenu(null)
    setChooseError(null)
    const open = playerApi()?.project.open
    if (!open) return
    // Played already: nothing to switch.
    if (samePath(entry.path, projectRef.current?.path)) return
    open(entry.path).catch(error => setChooseError(ipcReason(error)))
  }, [])
  const projectRef = useRef(project)
  projectRef.current = project
  useEffect(() => {
    if (projectKnown && !project) void readRecent().then(setRecent)
  }, [projectKnown, project, readRecent])
  // The menu closes on a press outside it (or Escape, in the keys below).
  useEffect(() => {
    if (!folderMenu) return
    const close = (e: PointerEvent) => { if (!(e.target as Element | null)?.closest?.('.player-top')) setFolderMenu(null) }
    document.addEventListener('pointerdown', close, true)
    return () => document.removeEventListener('pointerdown', close, true)
  }, [folderMenu])

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
  const { helperVersion, devices } = useHelperConnection()
  const kitSelectedIps = useDeviceStore(s => s.kitSelectedIps)
  const table = useSceneStore(s => s.table)
  // By position when a Hapbeat is at one the table uses, else every Hapbeat plays every route (playerPlaysAllDevices).
  useEffect(() => {
    const all = playerPlaysAllDevices(table, resolvePlaybackTargets(devices, kitSelectedIps).map(d => d.address))
    if (useScenePlayback.getState().allDevices !== all) useScenePlayback.getState().update({ allDevices: all })
  }, [table, devices, kitSelectedIps])
  const { status: helperStatus, restart: restartHelper } = usePlayerHelperStatus()

  const ready = useSceneStore(s => s.items.length > 0 && !s.busy)
  const busy = useSceneStore(s => s.busy)
  const chapters = useSceneStore(s => s.data?.chapters)
  const chapter = useSceneStore(s => s.chapter)
  const notice = useSceneStore(s => s.notice)
  /** The title of the project open (viewer-lib.json): the folder button names the demo by it. */
  const projectTitle = useSceneStore(s => s.lib?.title.trim() || null)
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

  // Fullscreen: in the app, its window's (the app's menu and F11 change it too); in a browser, the page's.
  const [fullscreen, setFullscreen] = useState(false)
  const fullscreenRef = useRef(false)
  fullscreenRef.current = fullscreen
  useEffect(() => {
    const win = playerApi()?.window
    if (win) {
      void win.isFullscreen().then(setFullscreen, () => {})
      return win.onFullscreen(setFullscreen)
    }
    const sync = () => setFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', sync)
    return () => document.removeEventListener('fullscreenchange', sync)
  }, [])
  const toggleFullscreen = useCallback(() => {
    const win = playerApi()?.window
    if (win) { void win.setFullscreen(!fullscreenRef.current).then(setFullscreen, () => {}); return }
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
    else void root.current?.requestFullscreen().catch(() => {})
  }, [])

  // The UI mode (button, U key, the app's menu) and the hint naming a new one.
  const [uiMode, setUiModeState] = useState<PlayerUiMode>(readUiMode)
  const uiModeRef = useRef(uiMode)
  uiModeRef.current = uiMode
  const [hint, setHint] = useState<PlayerUiMode | null>(null)
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const setUiMode = useCallback((mode: PlayerUiMode) => {
    setUiModeState(mode)
    storeUiMode(mode)
    playerApi()?.ui?.modeChanged(mode)
    setHint(mode)
    if (hintTimer.current) clearTimeout(hintTimer.current)
    hintTimer.current = setTimeout(() => setHint(null), HINT_MS)
  }, [])
  const cycleUiMode = useCallback(() => {
    setUiMode(PLAYER_UI_MODES[(PLAYER_UI_MODES.indexOf(uiModeRef.current) + 1) % PLAYER_UI_MODES.length])
  }, [setUiMode])
  useEffect(() => {
    const ui = playerApi()?.ui
    if (!ui) return
    // The app's menu marks the mode this page starts with.
    ui.modeChanged(uiModeRef.current)
    return ui.onMode(mode => { if (isPlayerUiMode(mode)) setUiMode(mode) })
  }, [setUiMode])
  useEffect(() => () => { if (hintTimer.current) clearTimeout(hintTimer.current) }, [])

  // After a while without the pointer moving or pressing (or a key) the cursor hides, and the controls too where the
  // mode lets them (idleHidesControls): not while a mouse rests over the controls.
  const [idle, setIdle] = useState(false)
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** A mouse is over the bar or the top row (touch pointers have no hover and never set it). */
  const hovered = useRef(false)
  const wake = useCallback(() => {
    setIdle(false)
    if (idleTimer.current) clearTimeout(idleTimer.current)
    const hides = idleHidesControls(uiModeRef.current, { playing: !runtime.video.paused, fullscreen: fullscreenRef.current, hovered: hovered.current })
    idleTimer.current = hides ? setTimeout(() => setIdle(true), HIDE_AFTER_MS) : null
  }, [runtime])
  /**
   * Hover is read from each pointer move's target, not from enter / leave on the bar: React's leave comes from pointerout,
   * which Chromium does not send when the pointer leaves the time text it redraws each frame (the controls then never hid).
   */
  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const over = e.pointerType === 'mouse' && !!(e.target as Element | null)?.closest?.('.player-bar, .player-top')
    if (over !== hovered.current) { hovered.current = over; wake() }
    else if (e.movementX || e.movementY) wake()
  }, [wake])
  // The mouse leaving the window leaves the controls too (no move inside it says so).
  useEffect(() => {
    const el = root.current
    if (!el) return
    const leave = (e: PointerEvent) => { if (e.pointerType === 'mouse' && hovered.current) { hovered.current = false; wake() } }
    el.addEventListener('pointerleave', leave)
    return () => el.removeEventListener('pointerleave', leave)
  }, [wake])
  /** The press now going on only shows the controls: its click must not play or pause (wake renders before the click). */
  const pressWakesOnly = useRef(false)
  useEffect(() => {
    wake()
    return () => { if (idleTimer.current) clearTimeout(idleTimer.current) }
  }, [playing, fullscreen, uiMode, wake])
  // An open folder menu keeps everything shown.
  const uiHidden = !folderMenu && (uiMode === 'hide' || (uiMode === 'auto' && idle))
  const cursorHidden = !folderMenu && idle && uiMode !== 'show'

  // Keys. No App here to forward Space. Capture: before a focused control can take the key.
  useEffect(() => {
    const keydown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing || isTypingTarget(e.target)) return
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key, video = runtime.video
      if (key === 'Escape') {
        // The folder menu first, then the app window's fullscreen (a browser leaves its own fullscreen by itself).
        if (folderMenuOpen.current) setFolderMenu(null)
        else if (fullscreenRef.current && playerApi()?.window) toggleFullscreen()
        else return
      }
      else if (key === 'ArrowLeft' || key === 'ArrowRight') runtime.seek(video.currentTime + (key === 'ArrowRight' ? ARROW_SEEK_SEC : -ARROW_SEEK_SEC))
      else if (key === 'u') { if (!e.repeat) cycleUiMode() }
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
  }, [runtime, togglePlay, toggleFullscreen, toggleHaptics, toggleLoop, playChapter, wake, cycleUiMode])
  const folderMenuOpen = useRef(false)
  folderMenuOpen.current = !!folderMenu

  const [settled, setSettled] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(true), NOTICE_DELAY_MS)
    return () => clearTimeout(timer)
  }, [])

  const helperDown = helperStatus?.state === 'crashed' || helperStatus?.state === 'missing'
  // The app found something on the helper's port and left it alone (another helper), yet the page cannot reach it.
  const portBusy = settled && !isConnected && helperStatus?.state === 'external'
  // Before the cue table is read (no project yet, or still reading it), the Hapbeats the helper found.
  const chipDevices = playerChipDevices(!!table, targetDevices, devices, kitSelectedIps)
  const chip = !isConnected ? t(helperDown ? 'player.status.helperStopped' : portBusy ? 'player.status.helperUnreachable' : 'player.status.helperStarting')
    : chipDevices.length ? t('player.status.devices', { count: chipDevices.length }) : t('player.status.noDevice')
  const chipTitle = chipDevices.map(d => d.name || d.ipAddress).join(', ') || undefined
  const oldHelper = !!helperVersion && Number.parseInt(helperVersion, 10) < 1
  const hapticsOn = sendHaptics && !PLAYER_HAPTICS_OFF

  const recentItem = (entry: PlayerRecentProject) => {
    const current = samePath(entry.path, project?.path)
    return <button key={entry.path} type="button" role="menuitem" className="player-menu-item" disabled={!entry.ok} aria-current={current || undefined}
      title={entry.path} onClick={e => { e.currentTarget.blur(); openRecent(entry) }}>
      <span className="player-menu-title">{entry.title ?? entry.name}{current && <span className="player-menu-mark">{t('player.project.playing')}</span>}</span>
      <span className="player-menu-path">{entry.ok ? entry.path : `${t('player.project.missing')}: ${entry.path}`}</span>
    </button>
  }

  return <div className="player" ref={root} data-ui-hidden={uiHidden || undefined} data-cursor-hidden={cursorHidden || undefined}
    onPointerDown={() => {
      if (useSceneStore.getState().items.length) runtime.audio()
      // Every press is activity; one while auto has hidden the controls only brings them back.
      pressWakesOnly.current = pressOnlyShowsControls(uiMode, uiHidden)
      wake()
    }}
    onClickCapture={e => { if (pressWakesOnly.current) { pressWakesOnly.current = false; e.stopPropagation() } }}
    onPointerMove={onPointerMove}>
    <div className="player-stage" ref={stage} onClick={togglePlay} />
    {!started && ready && <button type="button" className="player-bigplay" aria-label={t('player.play')} title={t('player.play')}
      onClick={e => { e.currentTarget.blur(); togglePlay() }}>▶</button>}
    {projectKnown && !project && <div className="player-empty">
      <p>{t(playerApi() ? 'player.project.empty' : 'player.project.noApp')}</p>
      {recent.some(r => r.ok) && <div className="player-menu player-empty-list" role="menu" aria-label={t('player.project.recent')}>
        <div className="player-menu-head">{t('player.project.recent')}</div>
        {recent.filter(r => r.ok).map(recentItem)}
      </div>}
      {!!playerApi() && <button type="button" className="player-btn player-choose" onClick={e => { e.currentTarget.blur(); chooseProject() }}>{t('player.project.choose')}</button>}
    </div>}
    {project && <div className="player-top" onClick={blurActive}>
      <div className="player-folder-wrap">
        <button type="button" className="player-btn player-folder" aria-haspopup="menu" aria-expanded={!!folderMenu} title={`${project.path}\n${t('player.project.change')}`}
          onClick={e => { e.currentTarget.blur(); toggleFolderMenu() }}>{t('player.project.folder', { name: (!busy && projectTitle) || project.name })}</button>
        {folderMenu && <div className="player-menu player-folder-menu" role="menu">
          {folderMenu.length > 0 && <div className="player-menu-head">{t('player.project.recent')}</div>}
          {folderMenu.map(recentItem)}
          <button type="button" role="menuitem" className="player-menu-item player-menu-other" onClick={e => { e.currentTarget.blur(); chooseProject() }}>{t('player.project.other')}</button>
        </div>}
      </div>
      <button type="button" className="player-btn player-ui-mode" title={t('player.ui.title')} onClick={e => { e.currentTarget.blur(); cycleUiMode() }}>
        {t('player.ui.button', { mode: t(UI_MODE_LABEL[uiMode]) })}</button>
    </div>}
    {hint && <div className="player-hint" role="status">{t(UI_MODE_HINT[hint])}</div>}
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
      {chooseError && <div className="player-notice error">{t('player.project.invalid', { error: chooseError })}</div>}
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
