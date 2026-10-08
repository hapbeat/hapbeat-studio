import { useEffect, useRef } from 'react'
import { usePageVisible } from '@/hooks/usePageVisible'
import { perfTrack } from '@/utils/perfRegistry'
import { useI18n } from '@/i18n/I18nProvider'
import { useSceneStore } from '@/stores/sceneStore'
import { useSceneSettings } from '@/stores/sceneSettings'
import { familyColor, frameAt, offsetOf } from '@/utils/sceneData'
import { WHEEL_ZOOM_RATE, wheelPixels, zoomAtTime } from '@/utils/waveformView'
import { effectiveEvent, resolveEventName } from '@/utils/cueEvents'
import { useScene } from './sceneContext'
import { SPEEDS } from './sceneRuntime'
import { SceneOutputToggles } from './SceneOutputToggles'
import { loopCueRuns } from '@/utils/loopStretch'
import { useMomentPlace } from './SceneCuePanels'
import type { CueTable } from '@/utils/sceneCueTable'
import { mapLevel } from '@/utils/levelMap'
import { laneY, layerLanes, layerScaleMax, outputCurves, outputScaleMax, sideLevel, type Lane, type OutputCurve } from '@/utils/sceneTimelineLevels'
import { spanWindow, stepView, timelineClick, type TimelineView } from '@/utils/sceneTimelineView'

const SOUND_COLOR = '#36c5c0'
type Hit = { x: number; y0: number; y1: number; name: string; t: number }
/** A drawn band of the selected loop cue: its lane's height and x range (CSS px). */
type Band = { x0: number; x1: number; y0: number; y1: number }
const MAX_ZOOM = 2000
/** The selected loop cue's input (recorded level) line and legend swatch: dashed; its output: solid. */
const INPUT_DASH = [5, 3]

/**
 * Timeline: two lanes, sound (upper) and haptics (lower), as in the editor, each with its continuous-layer levels
 * scaled inside it (a selected loop cue: also its output, levelMap applied); a cue shows in each lane it uses (a selected loop cue: its whole active
 * span, as long as its layer's recorded level is above 0, as bands in those lanes). A click seeks (timelineClick);
 * Ctrl (Cmd) + click a marker to edit that cue (the moments list marks it too), a band to play that span in the full
 * replay (SceneRuntime.playSpan; within the span already playing: seek). A firing is reassigned from the moments list.
 * While a loop cue's span plays, the timeline shows only that span with its lead-in / post-roll (sceneTimelineView).
 * Ctrl + wheel zooms around the pointer, wheel / Shift + wheel pans (like the editor's waveform), also while playing.
 * Read-outs and output toggles above it.
 */
export function SceneTimelinePanel() {
  const { t } = useI18n()
  const { runtime } = useScene()
  const canvas = useRef<HTMLCanvasElement>(null)
  const hits = useRef<Hit[]>([])
  const bands = useRef<Band[]>([])
  const title = useRef<HTMLSpanElement>(null)
  const note = useRef<HTMLSpanElement>(null)
  const levels = useRef<HTMLSpanElement>(null)
  const state = useRef<HTMLSpanElement>(null)
  const tRef = useRef(t); tRef.current = t
  const placeOf = useMomentPlace()
  const placeRef = useRef(placeOf); placeRef.current = placeOf
  const view = useRef<TimelineView>({ key: '', start: 0, zoom: 1, fit: true, span: false })
  /** The selected loop cue's active runs over the shown moment's levels (computed again only when either changes). */
  const runs = useRef<{ levels: number[][] | null; name: string; runs: [number, number][] }>({ levels: null, name: '', runs: [] })
  /** Each layer's scale top over the recording (computed again only for another recording). */
  const scales = useRef<{ levels: number[][] | null; max: number[] }>({ levels: null, max: [] })
  /** The selected loop cue's output curves (levelMap applied) and their scale top (again only when the recording, table or cue changes). */
  const outputs = useRef<{ levels: number[][] | null; table: CueTable | null; cue: string; curves: OutputCurve[]; max: number }>({ levels: null, table: null, cue: '', curves: [], max: 1 })

  // Drawn only while the Scene tab is shown and the page visible.
  const { active } = useScene()
  const visible = usePageVisible()
  const live = active && visible
  useEffect(() => {
    if (!live) return
    let frame = 0
    const draw = () => {
      frame = requestAnimationFrame(draw)
      const cv = canvas.current
      if (!cv) return
      const s = useSceneStore.getState(), it = s.items[s.cur], lib = s.lib, data = s.data, v = runtime.video, tr = tRef.current
      const ctx = cv.getContext('2d'), dpr = devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight
      if (!ctx) return
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr) }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      if (!it || !lib || !data) { hits.current = []; bands.current = []; return }
      const fps = data.fps, layers = lib.layers, ticks = lib.ticks, sel = s.sel, table = s.table
      const dur = v.duration || it.levels.length / fps || 1
      // The visible stretch: a playing loop cue span's window (in the full replay), else the whole moment until zoomed.
      const shownSpan = it.kind === 'full' && s.span ? spanWindow(runtime.partAB, dur) : null
      const vw = view.current, key = `${s.cur}:${it.file}${shownSpan ? `:${shownSpan[0]}-${shownSpan[1]}` : ''}`
      stepView(vw, key, shownSpan, w, dur, MAX_ZOOM, !v.paused, v.currentTime)
      const span = w / vw.zoom
      const X = (time: number) => (time - vw.start) * vw.zoom, top = 6, base = h - 16, mid = Math.round((top + base) / 2)
      if (runtime.part && runtime.partAB) { ctx.fillStyle = 'rgba(78,161,255,.13)'; ctx.fillRect(X(runtime.partAB[0]), 0, X(runtime.partAB[1]) - X(runtime.partAB[0]), h) }
      ctx.fillStyle = '#1a1d21'; ctx.fillRect(0, mid, w, 1)
      ctx.font = '10px Segoe UI, sans-serif'
      // Seconds grid (a clip counts from its cue).
      ctx.fillStyle = '#5c636c'
      const step = span > 60 ? 10 : span > 20 ? 5 : span > 4 ? 1 : 0.5
      for (let sec = Math.ceil(vw.start / step) * step; sec <= vw.start + span; sec += step) { ctx.fillRect(X(sec), base, 1, 4); ctx.fillText(it.kind === 'clip' ? (sec - it.event).toFixed(step < 1 ? 1 : 0) + 's' : sec.toFixed(step < 1 ? 1 : 0) + 's', X(sec) + 2, h - 3) }
      // Continuous layer levels, each in its own lane (0 at the lane bottom, the layer's scale top at the lane top):
      // haptics for a loop cue with haptics routes, sound for one with a sound. The selected loop cue: its output
      // (levelMap applied) and its recorded level on one scale. Drawn after the bands and markers (below).
      const L = it.levels, full = data.full.levels
      const sc = scales.current
      if (sc.levels !== full) { sc.levels = full; sc.max = layers.map(l => layerScaleMax(full, l)) }
      const selCue = sel ? sel.name.split(':')[0] : '', selLayer = selCue ? layers.find(l => l.cue === selCue) : undefined
      const oc = outputs.current
      if (oc.levels !== full || oc.table !== table || oc.cue !== (selLayer?.cue ?? '')) {
        oc.levels = full; oc.table = table; oc.cue = selLayer?.cue ?? ''
        oc.curves = selLayer ? outputCurves(table, selLayer.cue) : []
        oc.max = selLayer ? outputScaleMax(full, selLayer, oc.curves) : 1
      }
      const laneBox = (lane: Lane): [number, number] => lane === 'sound' ? [top + 3, mid - 1] : [mid + 4, base - 1]
      const path = (value: (n: number) => number, max: number, y0: number, y1: number) => {
        ctx.beginPath()
        for (let n = 0; n < L.length; n++) { const px = X(n / fps), py = laneY(value(n), max, y0, y1); if (n) ctx.lineTo(px, py); else ctx.moveTo(px, py) }
        ctx.stroke()
      }
      // Cue markers per lane: the selected cue bright and framed, the clip's moment normal, the rest dimmed.
      const events = runtime.events()
      // `cue:variant` names resolve like the game (variant fields, else the cue's).
      const effective = (name: string) => { const r = table ? resolveEventName(table, name) : null; return r && table ? effectiveEvent(table, r.ref) : null }
      // Sound above, haptics below (as in the editor).
      const lanes: [number, number, (name: string) => boolean, (name: string) => string][] = [
        [top, mid, name => !!effective(name)?.sfx, () => SOUND_COLOR],
        [mid + 1, base, name => { const e = effective(name); return !!e && (e.haptics.length > 0 || lib.loop_cues.includes(e.ref.cue)) }, name => familyColor(lib, name)],
      ]
      // A selected loop cue: bands over its layer's active runs (the recorded firings are only the layer's starts).
      const rc = runs.current
      if (rc.levels !== L || rc.name !== (sel?.name ?? '')) { rc.levels = L; rc.name = sel?.name ?? ''; rc.runs = sel ? loopCueRuns(L, fps, lib, sel.name) : [] }
      const drawnBands: Band[] = []
      if (rc.runs.length && sel) for (const [y0, y1, has, color] of lanes) {
        if (!has(sel.name)) continue
        ctx.fillStyle = color(sel.name)
        for (const [a, b] of rc.runs) {
          const x0 = Math.max(-1, X(a)), x1 = Math.min(w + 1, X(b))
          if (x1 <= x0) continue
          drawnBands.push({ x0, x1, y0, y1 })
          ctx.globalAlpha = 0.22; ctx.fillRect(x0, y0 + 2, x1 - x0, y1 - y0 - 2)
          ctx.globalAlpha = 0.45; ctx.fillRect(x0, y0 + 2, x1 - x0, 1)
        }
      }
      bands.current = drawnBands
      ctx.globalAlpha = 1
      const found: Hit[] = []
      for (const [y0, y1, has, color] of lanes) {
        let labelX = -1e9
        for (const ev of events) {
          if (!has(ev.name)) continue
          const x = X(ev.t), picked = !!sel && sel.name === ev.name && sel.t != null && Math.abs(ev.t - sel.t) < 0.02
          if (x < -10 || x > w + 10) continue
          found.push({ x, y0, y1, name: ev.name, t: ev.t })
          ctx.fillStyle = color(ev.name)
          ctx.globalAlpha = picked ? 1 : sel && sel.t != null ? 0.35 : it.kind === 'clip' && !ev.own ? 0.5 : 1
          if (ticks.includes(ev.name) && !picked) { ctx.fillRect(x, y1 - 6, 1, 6); continue }
          ctx.fillRect(x - 1, y0 + 2, picked ? 3 : 2, y1 - y0 - 2)
          if (picked) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.strokeRect(x - 3.5, y0 + 0.5, 7, y1 - y0) }
          if (x - labelX > 40 || picked) { ctx.fillText(ev.name, x + 5, y0 + 12); labelX = x }
        }
      }
      hits.current = found
      ctx.globalAlpha = 1
      // Level lines on top of the bands and markers (a band's edge never hides them). The selected loop cue: its input
      // (the recorded level) dashed, its output (levelMap applied) solid and thicker, same colours.
      layers.forEach((l, li) => {
        const mine = l === selLayer, max = mine ? oc.max : sc.max[li]
        for (const lane of layerLanes(table, l.cue)) {
          const [y0, y1] = laneBox(lane)
          l.gain.forEach((col, k) => {
            if (!L.some(r => r[col] > 0)) return
            ctx.globalAlpha = selLayer ? (mine ? 0.85 : 0.3) : 0.7
            ctx.strokeStyle = l.colors[k]; ctx.lineWidth = mine ? 2 : 1.5
            if (mine) ctx.setLineDash(INPUT_DASH)
            path(n => L[n][col], max, y0, y1)
            ctx.setLineDash([])
          })
          if (!mine) continue
          ctx.globalAlpha = 1; ctx.lineWidth = 3
          for (const c of oc.curves) if (c.lane === lane) { ctx.strokeStyle = l.colors[Math.max(0, c.side)]; path(n => mapLevel(c.map, sideLevel(L[n], l, c.side)), max, y0, y1) }
        }
      })
      ctx.globalAlpha = 1
      // Legend of the level lines (with each layer's scale top), right-aligned; the selected cue's swatches are styled
      // like its lines: 「--- 入力」, 「— 出力」.
      const swatch = (x: number, color: string, width: number, dash: number[]) => {
        ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash)
        ctx.beginPath(); ctx.moveTo(x, top + 6.5); ctx.lineTo(x + 12, top + 6.5); ctx.stroke(); ctx.setLineDash([])
      }
      let lx = w - 8
      for (const l of [...layers].reverse()) {
        const mine = l === selLayer, max = mine ? oc.max : sc.max[layers.indexOf(l)]
        if (mine && oc.curves.length) {
          const text = tr('scene.timeline.output', { cue: l.cue }), tw = ctx.measureText(text).width
          lx -= tw; ctx.fillStyle = '#8b929b'; ctx.fillText(text, lx, top + 10)
          lx -= 16; swatch(lx, l.colors[0], 3, []); lx -= 12
        }
        for (let k = l.gain.length - 1; k >= 0; k--) {
          if (!L.some(r => r[l.gain[k]] > 0)) continue
          const text = tr('scene.timeline.level', { cue: l.cue, side: k ? 'R' : 'L', max: max.toFixed(2) }), tw = ctx.measureText(text).width
          lx -= tw; ctx.fillStyle = '#8b929b'; ctx.fillText(text, lx, top + 10)
          lx -= 16; swatch(lx, l.colors[k], 2, mine ? INPUT_DASH : []); lx -= 12
        }
      }
      ctx.fillStyle = '#5c636c'; ctx.fillText(tr('scene.lane.sound'), 3, top + 24); ctx.fillText(tr('scene.lane.haptics'), 3, mid + 24)
      // Playhead.
      ctx.fillStyle = '#fff'; ctx.fillRect(X(v.currentTime) - 0.5, 0, 1.5, h)
      // Read-outs.
      const time = v.currentTime, f = L[frameAt(it, fps, time)]
      if (title.current) title.current.textContent = it.kind === 'full' ? tr('scene.full') : [it.names.join(' + '), placeRef.current(useSceneStore.getState().table, it.names, it.hand).text].filter(Boolean).join(' · ')
      if (note.current) note.current.textContent = it.kind === 'full' ? tr('scene.cueCount', { count: data.full.events.length }) : `${it.note}  ${tr('scene.replayAt', { seconds: it.at.toFixed(1) })}`
      if (levels.current) levels.current.textContent = f ? layers.filter(l => l.gain.some(i => f[i] > 0)).map(l => `${l.cue} L ${f[l.gain[0]].toFixed(2)} R ${f[l.gain[1]].toFixed(2)}`
        + (l.rate ? ` (rate ${f[l.rate[0]].toFixed(2)} / ${f[l.rate[1]].toFixed(2)})` : '')).join('　') : ''
      if (state.current) state.current.textContent = `${SPEEDS[runtime.speedIndex]}x　loop ${runtime.part ? '±0.5s' : useSceneSettings.getState().loop ? 'on' : 'off'}　${Math.floor(time * fps)}f`
    }
    frame = requestAnimationFrame(draw)
    perfTrack('rafLoops', 1)
    return () => { cancelAnimationFrame(frame); perfTrack('rafLoops', -1) }
  }, [runtime, live])

  const hitAt = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const r = event.currentTarget.getBoundingClientRect(), x = event.clientX - r.left, y = event.clientY - r.top
    return { x, hit: hits.current.filter(m => y >= m.y0 && y <= m.y1 && Math.abs(m.x - x) <= 5).sort((a, b) => Math.abs(a.x - x) - Math.abs(b.x - x))[0] }
  }
  const onMouseDown = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (!useSceneStore.getState().items.length || event.button !== 0) return
    const { x, hit } = hitAt(event), time = view.current.start + x / view.current.zoom
    const click = timelineClick(event.ctrlKey || event.metaKey, hit ?? null, bandRunAt(event, time), time)
    if (click.kind === 'select') { useSceneStore.getState().selectCue(click.name, click.t); runtime.video.pause(); runtime.seek(click.t - useSceneSettings.getState().leadSec); return }
    if (click.kind === 'span') { runtime.audio(); const lead = useSceneSettings.getState().leadSec; runtime.playSpan(click.run, lead, lead); return }
    runtime.seek(click.t)
  }
  /**
   * The selected loop cue's active span (full replay seconds) under a click at video time `time` on one of its bands,
   * unless it is the span already playing (a click in it seeks).
   */
  const bandRunAt = (event: React.MouseEvent<HTMLCanvasElement>, time: number): [number, number] | null => {
    const r = event.currentTarget.getBoundingClientRect(), x = event.clientX - r.left, y = event.clientY - r.top
    if (!bands.current.some(b => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1)) return null
    const s = useSceneStore.getState(), it = s.items[s.cur]
    if (!it || !s.data || !s.lib || !s.sel) return null
    const replay = time + offsetOf(it)
    const run = loopCueRuns(s.data.full.levels, s.data.fps, s.lib, s.sel.name).find(([a, b]) => replay >= a && replay <= b)
    return run && !(s.span && s.span[0] === run[0] && s.span[1] === run[1]) ? run : null
  }
  // Ctrl + wheel zooms around the pointer; wheel / Shift + wheel pans (the editor waveform's handling).
  useEffect(() => {
    const cv = canvas.current
    if (!cv) return
    const wheel = (event: WheelEvent) => {
      const r = cv.getBoundingClientRect(), vw = view.current, dur = runtime.video.duration || 1, fit = r.width / dur
      const delta = wheelPixels(event, r.width)
      event.preventDefault(); event.stopPropagation()
      if (event.ctrlKey) {
        const x = Math.max(0, Math.min(r.width, event.clientX - r.left)), time = vw.start + x / vw.zoom
        const next = Math.min(MAX_ZOOM, Math.max(fit, vw.zoom * Math.exp(-delta * WHEEL_ZOOM_RATE)))
        vw.start = zoomAtTime(time, x, next, r.width, dur); vw.zoom = next; vw.fit = next <= fit; vw.span = false
      } else { vw.start = Math.max(0, Math.min(Math.max(0, dur - r.width / vw.zoom), vw.start + delta / vw.zoom)); vw.span = false }
    }
    cv.addEventListener('wheel', wheel, { passive: false })
    return () => cv.removeEventListener('wheel', wheel)
  }, [runtime])

  return <div className="scene-timeline">
    <div className="scene-info">
      <span className="scene-info-title" ref={title} />
      <span className="scene-info-dim" ref={note} />
      <span className="scene-info-dim scene-info-levels" ref={levels} />
      <span className="scene-info-state" ref={state} />
      <SceneOutputToggles />
    </div>
    <canvas className="scene-timeline-canvas" ref={canvas} tabIndex={0} title={t('scene.timeline.hint')} onMouseDown={onMouseDown} />
    <div className="scene-help">{t('scene.keys')}</div>
  </div>
}

