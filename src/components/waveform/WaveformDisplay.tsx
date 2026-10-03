import { useEffect, useRef, useState, type PointerEvent } from 'react'
import WaveSurfer from 'wavesurfer.js'
import RegionsPlugin from 'wavesurfer.js/dist/plugins/regions.esm.js'
import { useWaveformStore } from '@/stores/waveformStore'
import { encodeWavBlob } from '@/utils/wavIO'
import { timeAtPixel, zoomAtTime } from '@/utils/waveformView'
import { renderSampleWaveform } from '@/utils/editorWaveform'
import type { SampleRate } from '@/types/waveform'
import { useI18n } from '@/i18n/I18nProvider'
import { WaveformThumbnail } from './WaveformThumbnail'
import { useEditorSettings } from '@/stores/editorSettings'
import type { EditorBufferPlayer } from '@/utils/editorBufferPlayer'

type OverviewMode = 'left' | 'right' | 'move' | 'seek'

/** `viewKey` identifies what is shown (defaults to the clip id); a new key re-fits the zoom. */
export function WaveformDisplay({ original, bufferOverride, player, viewKey }: { original: boolean; bufferOverride?: AudioBuffer; player: EditorBufferPlayer; viewKey?: string }) {
  const { t } = useI18n()
  const height = useEditorSettings(s => s.height)
  const surface = useRef<HTMLDivElement>(null)
  const resize = useRef<{y: number; height: number} | null>(null)
  const container = useRef<HTMLDivElement>(null)
  const ws = useRef<WaveSurfer | null>(null)
  const regions = useRef<RegionsPlugin | null>(null)
  const drag = useRef<{ anchor: number; x: number; moved: boolean } | null>(null)
  const anchor = useRef(0)
  const [ready, setReady] = useState(false)
  /** Overview frame drag: resize from either edge, move from inside, seek outside. */
  const overviewDrag = useRef<{ mode: OverviewMode; x: number; view: { start: number; end: number } } | null>(null)
  const [overviewHover, setOverviewHover] = useState<OverviewMode>('seek')
  const [time, setTime] = useState(0)
  const [viewport, setViewport] = useState({start: 0, end: 0})
  const clip = useWaveformStore(s => s.clip)
  const zoom = useWaveformStore(s => s.zoom)
  const selection = useWaveformStore(s => s.selectedRegion)
  const processing = useWaveformStore(s => s.isProcessing)
  const buffer = bufferOverride ?? (original ? clip?.originalBuffer : clip?.buffer)
  const loadedClip = useRef<string>()
  const viewId = viewKey ?? clip?.id
  const duration = buffer?.duration ?? 0
  useEffect(() => {
    if (!container.current) return
    const plugin = RegionsPlugin.create()
    regions.current = plugin
    const instance = WaveSurfer.create({ container: container.current, height: 180, waveColor: '#9a88d2', progressColor: '#9a88d2', cursorColor: '#fff', normalize: false, interact: false, hideScrollbar: true, renderFunction: renderSampleWaveform, plugins: [plugin] })
    instance.setMuted(true); ws.current = instance
    const removeScroll = instance.on('scroll', (start, end) => setViewport({start, end}))
    const removeTime = instance.on('timeupdate', setTime)
    return () => { removeScroll(); removeTime(); instance.destroy(); ws.current = null; regions.current = null }
  }, [])
  useEffect(() => {
    const instance = ws.current
    if (!instance) return
    let cancelled = false
    const sameClip = loadedClip.current === viewId
    const scroll = instance.getScroll() / Math.max(1, useWaveformStore.getState().zoom)
    instance.pause(); setReady(false); anchor.current = 0
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
  useEffect(() => {
    if (!ready) return
    const update = (time: number) => {ws.current?.setTime(Math.min(duration, time)); setTime(Math.min(duration, time))}
    update(player.getCurrentTime())
    return player.on('timeupdate', update)
  }, [player, ready, duration])
  useEffect(() => {
    const element = surface.current
    if (!element || !ready) return
    const wheel = (event: WheelEvent) => {
      if ((!event.ctrlKey && !event.shiftKey) || !element.contains(element.ownerDocument.activeElement)) return
      event.preventDefault(); event.stopPropagation()
      const instance = ws.current
      if (!instance) return
      const bounds = element.getBoundingClientRect()
      const delta = (event.deltaY || event.deltaX) * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? bounds.width : 1)
      if (event.ctrlKey) {
        const x = Math.max(0, Math.min(bounds.width, event.clientX - bounds.left))
        const time = (instance.getScroll() + x) / Math.max(zoom, bounds.width / duration)
        const next = Math.min(200000, Math.max(bounds.width / duration, zoom * Math.exp(-delta * .003)))
        useWaveformStore.getState().setZoom(next); instance.zoom(next)
        instance.setScrollTime(zoomAtTime(time, x, next, bounds.width, duration))
      } else {
        const next = Math.max(0, Math.min(duration, instance.getCurrentTime() + delta / Math.max(zoom, bounds.width / duration)))
        player.setTime(next)
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
    player.setTime(0)
  }
  const moveOverview = (event: PointerEvent<HTMLDivElement>) => {
    if (!ready) return
    const bounds = event.currentTarget.getBoundingClientRect()
    const next = Math.max(0, Math.min(duration, (event.clientX - bounds.left) / bounds.width * duration))
    player.setTime(next)
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
      <div ref={container} className="waveform-container" />
      <div className="editor-wave-pointer" role="group" aria-label={t('editor.selectionHint')}
        onDoubleClick={event => {event.preventDefault(); selectAll()}}
        onPointerDown={event => {
          if (!ready || processing || event.button !== 0) return
          surface.current?.focus({preventScroll: true})
          event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId)
          const next = pointerTime(event)
          player.setTime(next)
          if (event.shiftKey) { selectAt(anchor.current, next); return }
          let base = next
          if (selection && Math.abs(next - selection.start) * zoom < 8) base = selection.end
          else if (selection && Math.abs(next - selection.end) * zoom < 8) base = selection.start
          anchor.current = base
          drag.current = {anchor: base, x: event.clientX, moved: false}
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
            if (!state.moved) useWaveformStore.getState().setSelectedRegion(null)
          }
          drag.current = null
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
        }} onPointerCancel={() => {drag.current = null}} />
    </div>
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
    <div className={`editor-overview hover-${overviewDrag.current?.mode ?? overviewHover}`} title={t('editor.overviewHint')}
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
      <div className="editor-overview-playhead" style={{left: `${duration ? time/duration*100 : 0}%`}} />
    </div>
    <div className="editor-seek-row">
      <label>{t('editor.seek')}<input type="range" min={0} max={duration || 1} step={.001} value={time} disabled={!ready} onChange={event => player.setTime(Number(event.target.value))} /></label>
      <span>{t('editor.visibleRange')} {viewport.start.toFixed(3)}–{viewport.end.toFixed(3)} s</span>
    </div>
  </div>
}
