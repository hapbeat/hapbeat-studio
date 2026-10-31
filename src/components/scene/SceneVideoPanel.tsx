import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePageVisible } from '@/hooks/usePageVisible'
import { perfTrack } from '@/utils/perfRegistry'
import { useI18n } from '@/i18n/I18nProvider'
import { useSceneStore } from '@/stores/sceneStore'
import { useScene } from './sceneContext'
import { useSceneProjectActions } from './useSceneProjectActions'
import { VideoOverlay } from './VideoOverlay'
import { SceneOutputChip } from './SceneOutputToggles'
import type { FiredShot } from './sceneRuntime'
import { clockText, isTick, itemEvents } from '@/utils/sceneData'

/** In the presentation view, the bar and the cursor hide after this long without pointer movement. */
const PRESENT_IDLE_MS = 2500

/**
 * The replay video (the runtime's element, moved in here) with the time-to-cue badge, or the "open a project" start
 * screen. ⛶ shows it as a presentation for demos: this panel in fullscreen, the video contained on black, with
 * ScenePresentBar instead of the authoring overlay (Esc leaves, the keys keep working).
 */
export function SceneVideoPanel() {
  const { t } = useI18n()
  const { runtime } = useScene()
  const stage = useRef<HTMLDivElement>(null)
  const badge = useRef<HTMLDivElement>(null)
  const hasItems = useSceneStore(s => s.items.length > 0)
  const empty = useSceneStore(s => s.empty)
  const hasChapters = useSceneStore(s => !!s.data?.chapters.length)
  const { open, reopen, rememberedName, busy } = useSceneProjectActions()
  const [presenting, setPresenting] = useState(false)
  useEffect(() => {
    const doc = stage.current?.ownerDocument ?? document
    const sync = () => setPresenting(!!stage.current && doc.fullscreenElement === stage.current)
    doc.addEventListener('fullscreenchange', sync)
    return () => doc.removeEventListener('fullscreenchange', sync)
  }, [])
  const [idle, setIdle] = useState(false)
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** The pointer rests on the bar: it stays shown (a click there must reach its buttons, not the video). */
  const overBar = useRef(false)
  const wake = useCallback(() => {
    setIdle(false)
    if (idleTimer.current) clearTimeout(idleTimer.current)
    idleTimer.current = overBar.current ? null : setTimeout(() => setIdle(true), PRESENT_IDLE_MS)
  }, [])
  const hoverBar = useCallback((on: boolean) => { overBar.current = on; wake() }, [wake])
  useEffect(() => {
    if (presenting) wake(); else setIdle(false)
    return () => { if (idleTimer.current) clearTimeout(idleTimer.current); idleTimer.current = null }
  }, [presenting, wake])
  // Overlay: ⏸/▶ follows the runtime's video; the bar spans a moment's stretch with its cue as the mark, or the chapter playing (the full recording: all, no mark).
  const [playing, setPlaying] = useState(false)
  useEffect(() => {
    const v = runtime.video, sync = () => setPlaying(!v.paused)
    v.addEventListener('play', sync); v.addEventListener('pause', sync); sync()
    return () => { v.removeEventListener('play', sync); v.removeEventListener('pause', sync) }
  }, [runtime])
  const mark = useSceneStore(s => { const it = s.items[s.cur]; return it?.kind === 'clip' ? it.event : null })
  // A chapter playing in the full replay is its range too (a seek out of it ends the chapter, SceneRuntime.seek).
  const rangeStart = useSceneStore(s => { const it = s.items[s.cur]; return it?.kind === 'clip' ? it.start : s.chapter === null ? null : s.data?.chapters[s.chapter]?.start ?? null })
  const rangeEnd = useSceneStore(s => { const it = s.items[s.cur]; return it?.kind === 'clip' ? it.end : s.chapter === null ? null : s.data?.chapters[s.chapter]?.end ?? null })
  const range = useMemo((): [number, number] | null => rangeStart !== null && rangeEnd !== null ? [rangeStart, rangeEnd] : null, [rangeStart, rangeEnd])
  // What each firing plays, shown over the video while it sounds (the latest few; a seek back drops the later ones).
  const [fired, setFired] = useState<FiredShot[]>([])
  useEffect(() => runtime.onFired(f => setFired(list => [...list.filter(x => x.at <= f.at && f.at - x.at < 10), f].slice(-12))), [runtime])
  useEffect(() => { setFired([]) }, [mark])
  // Every firing of the shown moment / full replay is a pin from the start (the recording's plan, not what has played);
  // what a firing played is added to its pin once it fires (the overlay's "name: material").
  const items = useSceneStore(s => s.items), cur = useSceneStore(s => s.cur), data = useSceneStore(s => s.data), ticks = useSceneStore(s => s.lib?.ticks)
  const planned = useMemo(() => { const it = items[cur]; return it && data ? itemEvents(it, data.full.events).filter(e => !isTick(ticks ?? [], e.name)) : [] }, [items, cur, data, ticks])
  const marks = planned.map(e => {
    const f = fired.find(x => Math.abs(x.at - e.t) < 0.05 && x.name === (e.name.split(':')[1] ?? e.name))
    return { t: e.t, target: mark !== null && Math.abs(e.t - mark) < 0.05, name: e.name, ...(f ? { material: f.materials.join(' + '), durSec: Math.max(0.3, f.durSec) } : {}) }
  })

  useEffect(() => {
    const host = stage.current
    if (!host) return
    host.appendChild(runtime.video)
    return () => { if (runtime.video.parentElement === host) host.removeChild(runtime.video) }
  }, [runtime])
  // The badge is drawn only while the Scene tab is shown and the page visible.
  const { active } = useScene()
  const visible = usePageVisible()
  const live = active && visible
  useEffect(() => {
    if (!live) return
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
          const prev = s.data?.full.events.filter(x => !isTick(ticks, x.name) && x.t <= time).pop()
          el.textContent = prev ? `${prev.name} +${(time - prev.t).toFixed(2)} s` : `${time.toFixed(2)} s`
          el.classList.remove('scene-badge-hit')
        }
      }
      frame = requestAnimationFrame(draw)
    }
    frame = requestAnimationFrame(draw)
    perfTrack('rafLoops', 1)
    return () => { cancelAnimationFrame(frame); perfTrack('rafLoops', -1) }
  }, [runtime, live])

  const toggle = () => { runtime.audio(); runtime.togglePlay() }
  return <div className={`scene-stage ${presenting ? 'presenting' : ''} ${presenting && idle ? 'idle' : ''}`} ref={stage}
    onPointerMove={() => { if (presenting) wake() }} onPointerDown={() => { if (presenting) wake() }} onClick={() => { if (hasItems) toggle() }}>
    <div className="scene-badge" ref={badge} hidden={!hasItems} />
    {hasItems && !presenting && <button type="button" className="scene-present-btn" title={t('scene.present.enter')} aria-label={t('scene.present.enter')}
      onClick={e => { e.stopPropagation(); e.currentTarget.blur(); void stage.current?.requestFullscreen().catch(() => {}) }}>⛶</button>}
    {hasItems && presenting && <ScenePresentBar playing={playing} onToggle={toggle} onHover={hoverBar} onExit={() => void stage.current?.ownerDocument.exitFullscreen().catch(() => {})} />}
    {hasItems && !presenting && <VideoOverlay video={runtime.video} mark={mark} marks={marks} range={range} playing={playing} info={t('scene.keys') + (hasChapters ? t('scene.keys.chapters') : '')}
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

/**
 * The presentation view's bar (an overlay at the bottom: hiding it moves nothing): ▶/⏸, the project's chapters (the one
 * playing marked) and where the haptics go (SceneOutputChip).
 */
function ScenePresentBar({ playing, onToggle, onHover, onExit }: { playing: boolean; onToggle: () => void; onHover: (over: boolean) => void; onExit: () => void }) {
  const { t } = useI18n()
  const { runtime } = useScene()
  const chapters = useSceneStore(s => s.data?.chapters)
  const chapter = useSceneStore(s => s.chapter)
  const label = t(playing ? 'scene.overlay.pause' : 'scene.overlay.play')
  return <div className="scene-present-bar" onClick={e => e.stopPropagation()} onPointerEnter={() => onHover(true)} onPointerLeave={() => onHover(false)}>
    <button type="button" className="scene-present-play" aria-label={label} title={label} onClick={e => { e.currentTarget.blur(); onToggle() }}>{playing ? '⏸' : '▶'}</button>
    <span className="scene-present-chapters">
      {(chapters ?? []).map((c, i) => <button key={i} type="button" className={i === chapter ? 'on' : ''} aria-pressed={i === chapter}
        title={`${i < 9 ? `${i + 1}: ` : ''}${c.label} ${clockText(c.start)}–${clockText(c.end)}`}
        onClick={e => { e.currentTarget.blur(); runtime.audio(); runtime.playChapter(i) }}>{c.label}</button>)}
    </span>
    <SceneOutputChip className="scene-present-chip" />
    <button type="button" className="scene-present-exit" title={t('scene.present.exit')} aria-label={t('scene.present.exit')} onClick={e => { e.currentTarget.blur(); onExit() }}>✕</button>
  </div>
}
