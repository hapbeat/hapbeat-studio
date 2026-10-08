import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react'
import WaveSurfer from 'wavesurfer.js'
import RegionsPlugin from 'wavesurfer.js/dist/plugins/regions.esm.js'
import { useWaveformStore } from '@/stores/waveformStore'
import { useStartMarker } from '@/utils/editorStartMarker'
import { encodeWavBlob } from '@/utils/wavIO'
import { timeAtPixel, WHEEL_ZOOM_RATE, wheelPixels, zoomAtTime } from '@/utils/waveformView'
import { renderSampleWaveform } from '@/utils/editorWaveform'
import type { SampleRate } from '@/types/waveform'
import { useI18n } from '@/i18n/I18nProvider'
import { WaveformThumbnail } from './WaveformThumbnail'
import { useEditorSettings } from '@/stores/editorSettings'
import type { EditorBufferPlayer } from '@/utils/editorBufferPlayer'
import { scenePause } from '@/utils/editorSceneSync'
import { useEditor } from './editorContext'
import { laneColumns, lanePxPerSec, laneX, type SoundLane } from '@/utils/soundLane'
import { useSceneSettings } from '@/stores/sceneSettings'
import { NumberField } from '@/components/scene/SceneCuePanels'
import type { LoopStretch } from '@/utils/loopStretch'
import { foldTime, unfoldTime, type FoldView } from '@/utils/shownLayout'
import { kindColor } from '@/utils/kindColors'
import { HapticIcon, SoundIcon } from '@/components/common/KindIcon'

type OverviewMode = 'left' | 'right' | 'move' | 'seek'

/**
 * `viewKey` identifies what is shown (defaults to the clip id); a new key re-fits the zoom.
 * Mouse playback: a click plays from there (a click while playing stops), a drag selects a
 * range, a double click plays from the start. `transport` sits right under the waveform.
 * `scale` multiplies the drawing only (a material's intensity): a change redraws, nothing is decoded or rendered.
 * `placements`: the copies of a material placed at its event's firings; each gets a start line and an alternating tint.
 * `loop`: a loop cue's material looped over its layer's active segments: each segment gets a start and an end line, and
 * the recorded level is drawn as a line over the haptic (bottom = 0, top = 1).
 * `fold`: the played stretch folded onto the drawn material file (「発生に合わせて並べる」 off): the playhead shows the material
 * time playing now (hidden in a gap between firings / segments), and a click / seek at material time t goes to the first firing + t.
 * `soundLane`: the PC sounds of a haptic audition, drawn in a fixed-height lane above the haptic on the same time axis
 * (same zoom, scroll and playhead); null = the haptic alone.
 */
export function WaveformDisplay({ original, bufferOverride, player, viewKey, transport, scale = 1, placements = [], loop = null, fold = null, soundLane = null }: { original: boolean; bufferOverride?: AudioBuffer; player: EditorBufferPlayer; viewKey?: string; transport?: ReactNode; scale?: number; placements?: readonly { start: number; end: number }[]; loop?: Pick<LoopStretch, 'segments' | 'envelope'> | null; fold?: FoldView | null; soundLane?: SoundLane | null }) {
  const { t } = useI18n()
  const { playAt, stopPlayback, isPlaybackActive, playFromStart, soundShown } = useEditor()
  const height = useEditorSettings(s => s.height)
  const surface = useRef<HTMLDivElement>(null)
  const resize = useRef<{y: number; height: number} | null>(null)
  const container = useRef<HTMLDivElement>(null)
  const ws = useRef<WaveSurfer | null>(null)
  const regions = useRef<RegionsPlugin | null>(null)
  const drag = useRef<{ anchor: number; x: number; moved: boolean; time: number; wasPlaying: boolean } | null>(null)
  const anchor = useRef(0)
  const [ready, setReady] = useState(false)
  const drawScale = useRef(scale)
  /** Overview frame drag: resize from either edge, move from inside, seek outside. */
  const overviewDrag = useRef<{ mode: OverviewMode; x: number; view: { start: number; end: number } } | null>(null)
  const [overviewHover, setOverviewHover] = useState<OverviewMode>('seek')
  const [time, setTime] = useState(0)
  const [viewport, setViewport] = useState({start: 0, end: 0})
  const clip = useWaveformStore(s => s.clip)
  const zoom = useWaveformStore(s => s.zoom)
  const selection = useWaveformStore(s => s.selectedRegion)
  const marker = useStartMarker(s => s.start)
  const processing = useWaveformStore(s => s.isProcessing)
  const buffer = bufferOverride ?? (original ? clip?.originalBuffer : clip?.buffer)
  const loadedClip = useRef<string>()
  const viewId = viewKey ?? clip?.id
  const duration = buffer?.duration ?? 0
  /** Playback time of drawn time `t` (the drawn time playing at a playback time: foldTime, null in a gap). */
  const toPlay = (t: number) => fold ? unfoldTime(fold, t) : t
  const [inGap, setInGap] = useState(false)
  useEffect(() => {
    if (!container.current) return
    const plugin = RegionsPlugin.create()
    regions.current = plugin
    const instance = WaveSurfer.create({ container: container.current, height: 180, waveColor: kindColor('haptic'), progressColor: kindColor('haptic'), cursorColor: '#fff', normalize: false, interact: false, hideScrollbar: true, renderFunction: (channels, ctx) => renderSampleWaveform(channels, ctx, drawScale.current), plugins: [plugin] })
    instance.setMuted(true); ws.current = instance
    const removeScroll = instance.on('scroll', (start, end) => setViewport({start, end}))
    const removeTime = instance.on('timeupdate', setTime)
    return () => { removeScroll(); removeTime(); instance.destroy(); ws.current = null; regions.current = null }
  }, [])
  // A sound shown draws in the sound colour, a haptic in the haptic one.
  useEffect(() => { const color = kindColor(soundShown ? 'sound' : 'haptic'); ws.current?.setOptions({ waveColor: color, progressColor: color }) }, [soundShown])
  useEffect(() => {
    const instance = ws.current
    if (!instance) return
    let cancelled = false
    const sameClip = loadedClip.current === viewId
    const scroll = instance.getScroll() / Math.max(1, useWaveformStore.getState().zoom)
    instance.pause(); setReady(false); anchor.current = 0
    useStartMarker.getState().set(null)
    regions.current?.clearRegions()
    if (!buffer) { instance.empty(); return }
    void (async () => {
      const blob = await encodeWavBlob(buffer, buffer.sampleRate as SampleRate)
      if (cancelled) return
      await instance.loadBlob(blob, Array.from({ length: buffer.numberOfChannels }, (_, ch) => buffer.getChannelData(ch)), buffer.duration)
      if (!cancelled) {
        if (!sameClip) useWaveformStore.getState().setZoom(Math.max(1, ((container.current?.clientWidth ?? 800) - 4) / buffer.duration))
        loadedClip.current = viewId
        instance.zoom(useWaveformStore.getState().zoom); instance.setScrollTime(sameClip ? scroll : 0)
        setViewport({start: sameClip ? scroll : 0, end: buffer.duration}); setReady(true)
      }
    })().catch(error => { if (!cancelled) useWaveformStore.getState().setError(error) })
    return () => { cancelled = true; instance.pause() }
  }, [buffer, viewId])
  useEffect(() => {
    const plugin = regions.current
    if (!plugin || !ready) return
    if (!selection) plugin.clearRegions()
    else {
      const region = plugin.getRegions()[0]
      if (region) region.setOptions({ start: selection.start, end: selection.end })
      else plugin.addRegion({ start: selection.start, end: selection.end, drag: false, resize: false, color: 'rgba(34,211,238,.26)' })
    }
  }, [selection, original, ready])
  useEffect(() => {
    if (!ready || !ws.current || !container.current) return
    ws.current.zoom(zoom)
    const start = ws.current.getScroll() / zoom
    setViewport({start, end: Math.min(duration, start + container.current.clientWidth / zoom)})
  }, [ready, zoom, duration, player])
  useEffect(() => { ws.current?.setOptions({height}) }, [height])
  // Redraw from the loaded data (WaveSurfer re-renders on setOptions; barHeight itself is unused by the custom renderFunction).
  useEffect(() => { if (drawScale.current === scale) return; drawScale.current = scale; if (ready) ws.current?.setOptions({barHeight: scale}) }, [scale, ready])
  useEffect(() => {
    if (!ready) return
    const update = (playTime: number) => {
      const time = fold ? foldTime(fold, playTime) : playTime
      setInGap(time === null)
      if (time !== null) { ws.current?.setTime(Math.min(duration, time)); setTime(Math.min(duration, time)) }
    }
    update(player.getCurrentTime())
    return player.on('timeupdate', update)
  }, [player, ready, duration, fold])
  useEffect(() => {
    const element = surface.current
    if (!element || !ready) return
    const wheel = (event: WheelEvent) => {
      if ((!event.ctrlKey && !event.shiftKey) || !element.contains(element.ownerDocument.activeElement)) return
      event.preventDefault(); event.stopPropagation()
      const instance = ws.current
      if (!instance) return
      const bounds = element.getBoundingClientRect()
      const delta = wheelPixels(event, bounds.width)
      if (event.ctrlKey) {
        const x = Math.max(0, Math.min(bounds.width, event.clientX - bounds.left))
        const time = (instance.getScroll() + x) / Math.max(zoom, bounds.width / duration)
        const next = Math.min(200000, Math.max(bounds.width / duration, zoom * Math.exp(-delta * WHEEL_ZOOM_RATE)))
        useWaveformStore.getState().setZoom(next); instance.zoom(next)
        instance.setScrollTime(zoomAtTime(time, x, next, bounds.width, duration))
      } else {
        const next = Math.max(0, Math.min(duration, instance.getCurrentTime() + delta / Math.max(zoom, bounds.width / duration)))
        player.setTime(toPlay(next))
        instance.setScrollTime(Math.max(0, next - bounds.width / zoom / 2))
      }
    }
    element.addEventListener('wheel', wheel, {passive: false})
    return () => element.removeEventListener('wheel', wheel)
  }, [ready, zoom, duration, player])
  const fitRange = (start: number, end: number) => {
    if (!container.current || !ws.current || end <= start) return
    const nextZoom = Math.min(200000, Math.max(1, (container.current.clientWidth - 4) / (end - start)))
    useWaveformStore.getState().setZoom(nextZoom)
    ws.current.zoom(nextZoom)
    ws.current.setScrollTime(start)
    requestAnimationFrame(() => ws.current?.setScrollTime(start))
    setViewport({start, end})
  }
  const pointerTime = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    // WaveSurfer stretches short clips to fill the available viewport.
    const scale = Math.max(zoom, bounds.width / Math.max(.000001, duration))
    return timeAtPixel(event.clientX - bounds.left, bounds.width, ws.current?.getScroll() ?? 0, scale, duration)
  }
  const selectAt = (a: number, b: number) => useWaveformStore.getState().setSelectedRegion({start: Math.min(a,b), end: Math.max(a,b)}, original, duration)
  const selectAll = () => {
    if (!ready || processing || !duration) return
    drag.current = null; anchor.current = 0
    selectAt(0, duration)
    fitRange(0, duration)
    player.setTime(toPlay(0))
  }
  const moveOverview = (event: PointerEvent<HTMLDivElement>) => {
    if (!ready) return
    const bounds = event.currentTarget.getBoundingClientRect()
    const next = Math.max(0, Math.min(duration, (event.clientX - bounds.left) / bounds.width * duration))
    player.setTime(toPlay(next))
    ws.current?.setScrollTime(Math.max(0, next - (viewport.end - viewport.start) / 2))
  }
  /** Which part of the overview frame is under the pointer (edges within 6 px resize the visible range). */
  const overviewModeAt = (event: PointerEvent<HTMLDivElement>): OverviewMode => {
    if (!duration) return 'seek'
    const bounds = event.currentTarget.getBoundingClientRect()
    const x = event.clientX - bounds.left
    const left = viewport.start / duration * bounds.width, right = Math.min(viewport.end, duration) / duration * bounds.width
    if (Math.abs(x - left) <= 6) return 'left'
    if (Math.abs(x - right) <= 6) return 'right'
    return x > left && x < right ? 'move' : 'seek'
  }
  return <div className="waveform-display" style={{ display: clip ? 'block' : 'none' }}>
    <div className={`editor-selection-status ${selection ? 'has-selection' : ''}`}>
      <strong>{selection ? t('editor.rangeSelected') : t('editor.noRangeSelected')}</strong>
      <span>{selection ? `${selection.start.toFixed(3)}–${selection.end.toFixed(3)} s · ${(selection.end - selection.start).toFixed(3)} s` : t('editor.selectionHint')}</span>
    </div>
    <div ref={surface} className="editor-wave-surface" tabIndex={0} aria-label={t('editor.wheelHint')} title={t('editor.wheelHint')}
      onKeyDown={event => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
          event.preventDefault(); event.stopPropagation(); selectAll()
        }
      }}>
      {soundLane && ready && duration > 0 && <SoundLaneView lane={soundLane} viewStart={viewport.start} zoom={zoom} duration={duration} time={time} />}
      <div ref={container} className={`waveform-container ${inGap ? 'playhead-gap' : ''}`} />
      {soundLane && ready && <span className="editor-lane-label haptic" aria-hidden="true" style={{ top: SOUND_LANE_HEIGHT }}><HapticIcon size={14} decorative />{t('editor.lane.haptic')}</span>}
      {placements.length > 0 && ready && duration > 0 && (() => {
        // One firing each: a line where it starts and a tint over its length, alternating so copies never read as one long file.
        const width = surface.current?.clientWidth ?? 0, px = Math.max(zoom, width / duration)
        return <div className="editor-placements" aria-hidden="true">{placements.map((p, i) => {
          const left = (p.start - viewport.start) * px, right = (Math.min(duration, p.end) - viewport.start) * px
          return right < 0 || left > width ? null : <div key={i} className={`editor-placement ${i % 2 ? 'odd' : ''}`} style={{ left, width: Math.max(1, right - left) }} />
        })}</div>
      })()}
      {loop && ready && duration > 0 && (() => {
        // A loop cue: where each active segment starts and stops (not per firing), and the recorded level as a line.
        const width = surface.current?.clientWidth ?? 0, px = Math.max(zoom, width / duration), top = soundLane ? SOUND_LANE_HEIGHT : 0
        const x = (t: number) => (t - viewport.start) * px
        return <div className="editor-loop" aria-hidden="true">
          {loop.segments.map((p, i) => {
            const left = x(p.start), right = x(Math.min(duration, p.end))
            return right < 0 || left > width ? null : <div key={i} className="editor-loop-segment" style={{ left, width: Math.max(1, right - left) }} />
          })}
          <svg className="editor-loop-envelope" style={{ top, height }} width={width} height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
            <polyline points={loop.envelope.map(p => `${x(p.t).toFixed(1)},${(height * (1 - Math.max(0, Math.min(1, p.gain)))).toFixed(1)}`).join(' ')} />
          </svg>
        </div>
      })()}
      {marker !== null && !selection && ready && duration > 0 && (() => {
        const width = surface.current?.clientWidth ?? 0
        const at = fold ? foldTime(fold, marker) : marker
        if (at === null) return null
        const x = (at - viewport.start) * Math.max(zoom, width / duration)
        return x >= 0 && x <= width ? <div className="editor-start-marker" aria-hidden="true" style={{ left: x }} /> : null
      })()}
      <div className="editor-wave-pointer" role="group" aria-label={t('editor.selectionHint')}
        onDoubleClick={event => { event.preventDefault(); if (ready && !processing) playFromStart() }}
        onPointerDown={event => {
          if (!ready || processing || event.button !== 0) return
          surface.current?.focus({preventScroll: true})
          event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId)
          const next = pointerTime(event)
          // While playing, a click stops (on pointer up); the playhead is not moved by the press.
          const wasPlaying = isPlaybackActive()
          if (!wasPlaying) player.setTime(toPlay(next))
          if (event.shiftKey) { selectAt(anchor.current, next); return }
          let base = next
          if (selection && Math.abs(next - selection.start) * zoom < 8) base = selection.end
          else if (selection && Math.abs(next - selection.end) * zoom < 8) base = selection.start
          anchor.current = base
          drag.current = {anchor: base, x: event.clientX, moved: false, time: next, wasPlaying}
        }}
        onPointerMove={event => {
          const state = drag.current
          if (!state) return
          if (Math.abs(event.clientX - state.x) > 3) state.moved = true
          if (state.moved) selectAt(state.anchor, pointerTime(event))
        }}
        onPointerUp={event => {
          const state = drag.current
          if (state) {
            // A plain click plays from there (the start marker moves there) or, while playing, stops; a drag made a range.
            // While the Scene video is paused a click only seeks (done on pointer down; the video follows).
            if (!state.moved && !scenePause()?.paused()) { if (state.wasPlaying) stopPlayback(); else playAt(toPlay(state.time)) }
          }
          drag.current = null
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
        }} onPointerCancel={() => {drag.current = null}} />
    </div>
    {transport}
    <div className="editor-wave-resize" role="separator" aria-label={t('editor.resizeWave')} aria-orientation="horizontal" aria-valuenow={height} aria-valuemin={100} aria-valuemax={700} tabIndex={0}
      onPointerDown={event => {event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); resize.current = {y: event.clientY, height}}}
      onPointerMove={event => {if (resize.current) useEditorSettings.getState().update({height: Math.max(100, Math.min(700, resize.current.height + event.clientY - resize.current.y))})}}
      onPointerUp={event => {resize.current = null; if(event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)}} onPointerCancel={() => {resize.current = null}}
      onKeyDown={event => {if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {event.preventDefault(); useEditorSettings.getState().update({height: Math.max(100, Math.min(700, height + (event.key === 'ArrowDown' ? 20 : -20)))})}}} />
    <div className="editor-wheel-hint">{t('editor.wheelHint')}</div>
    <div className="waveform-controls">
      <button className="toolbar-btn" disabled={!buffer || !ready} onClick={() => fitRange(0,duration)}>{t('editor.fit')}</button>
      <span>{duration.toFixed(3)} s · {buffer?.sampleRate} Hz</span>
    </div>
    <div className={`editor-overview ${soundShown ? 'sound' : 'haptic'} hover-${overviewDrag.current?.mode ?? overviewHover}`} title={t('editor.overviewHint')}
      onPointerDown={event => {
        if (!ready || event.button !== 0) return
        event.currentTarget.setPointerCapture(event.pointerId)
        const mode = overviewModeAt(event)
        overviewDrag.current = { mode, x: event.clientX, view: viewport }
        if (mode === 'seek') moveOverview(event)
      }}
      onPointerMove={event => {
        const state = overviewDrag.current
        if (!state) { setOverviewHover(overviewModeAt(event)); return }
        const bounds = event.currentTarget.getBoundingClientRect()
        const at = Math.max(0, Math.min(duration, (event.clientX - bounds.left) / bounds.width * duration))
        const minSpan = Math.max(duration / 2000, (container.current?.clientWidth ?? 800) / 200000)
        if (state.mode === 'left') fitRange(Math.max(0, Math.min(at, state.view.end - minSpan)), state.view.end)
        else if (state.mode === 'right') fitRange(state.view.start, Math.min(duration, Math.max(at, state.view.start + minSpan)))
        else if (state.mode === 'move') {
          const span = state.view.end - state.view.start
          const start = Math.max(0, Math.min(duration - span, state.view.start + (event.clientX - state.x) / bounds.width * duration))
          ws.current?.setScrollTime(start); setViewport({ start, end: start + span })
        } else moveOverview(event)
      }}
      onPointerUp={event => { overviewDrag.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId) }}
      onPointerCancel={() => { overviewDrag.current = null }}>
      {buffer && <WaveformThumbnail buffer={buffer} />}
      <div className="editor-viewport" aria-hidden="true" style={{left: `${duration ? viewport.start/duration*100 : 0}%`, width: `${duration ? Math.min(100,(viewport.end-viewport.start)/duration*100) : 100}%`}} />
      <div className="editor-overview-playhead" style={{left: `${duration ? time/duration*100 : 0}%`, visibility: inGap ? 'hidden' : undefined}} />
    </div>
    <div className="editor-seek-row">
      <label>{t('editor.seek')}<input type="range" min={0} max={duration || 1} step={.001} value={time} disabled={!ready} onChange={event => player.setTime(toPlay(Number(event.target.value)))} /></label>
      <span>{t('editor.visibleRange')} {viewport.start.toFixed(3)}–{viewport.end.toFixed(3)} s</span>
    </div>
  </div>
}

/** Height (px) of the sound lane: fixed, so the haptic below never moves with what the lane shows. */
const SOUND_LANE_HEIGHT = 84

/**
 * The PC sound above the haptic: min / max per pixel of the lane's samples at the haptic lane's scroll and zoom, the
 * playhead across it, a mark where the haptic lead puts the sound's 0, and the lead (scene hapticLeadMs) to edit.
 */
function SoundLaneView({ lane, viewStart, zoom, duration, time }: { lane: SoundLane; viewStart: number; zoom: number; duration: number; time: number }) {
  const { t } = useI18n()
  const box = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [width, setWidth] = useState(0)
  const setting = useSceneSettings(s => s.hapticLeadMs)
  useEffect(() => {
    const element = box.current
    if (!element) return
    const observer = new ResizeObserver(() => setWidth(element.clientWidth))
    observer.observe(element); setWidth(element.clientWidth)
    return () => observer.disconnect()
  }, [])
  const px = lanePxPerSec(zoom, width, duration)
  useEffect(() => {
    const c = canvas.current, ctx = c?.getContext('2d')
    if (!c || !ctx || !width) return
    const ratio = window.devicePixelRatio || 1, height = c.clientHeight
    c.width = Math.round(width * ratio); c.height = Math.round(height * ratio)
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0); ctx.clearRect(0, 0, width, height)
    const mid = height / 2
    ctx.fillStyle = kindColor('sound')
    laneColumns(lane.data, lane.rate, viewStart, px, Math.ceil(width)).forEach(([lo, hi], x) => {
      const top = mid - Math.min(1, hi) * mid, bottom = mid - Math.max(-1, lo) * mid
      ctx.fillRect(x, top, 1, Math.max(1, bottom - top))
    })
  }, [lane, viewStart, px, width])
  const head = laneX(time, viewStart, px), mark = laneX(lane.leadMs / 1000, viewStart, px)
  const signed = (ms: number) => `${ms > 0 ? '+' : ms < 0 ? '−' : '±'}${Math.abs(Math.round(ms))}`
  return <div className="editor-sound-lane" style={{ height: SOUND_LANE_HEIGHT }}>
    <div className="editor-lane-header">
      <span className="editor-lane-label sound"><SoundIcon size={14} decorative />{t('editor.lane.sound')}</span>
      <label className="editor-lane-lead" title={t('editor.lane.leadHint')}>{t('editor.lane.lead')}
        <NumberField value={setting} step={5} min={-200} max={400} label={t('editor.lane.lead')} onCommit={x => useSceneSettings.getState().update({ hapticLeadMs: Math.max(-200, Math.min(400, x)) })} /> ms</label>
      {/* Fixed width: switching applied / not applied never moves the header. */}
      <span className="editor-lane-status" role="status">{lane.leadMs || setting === 0 ? t('editor.lane.applied', { ms: signed(lane.leadMs) }) : t('editor.lane.notApplied')}</span>
    </div>
    <div ref={box} className="editor-lane-wave">
      <canvas ref={canvas} />
      {lane.leadMs !== 0 && mark >= 0 && mark <= width && <div className="editor-lane-lead-mark" style={{ left: mark }} title={t('editor.lane.applied', { ms: signed(lane.leadMs) })} />}
      {head >= 0 && head <= width && <div className="editor-lane-playhead" style={{ left: head }} />}
    </div>
  </div>
}
