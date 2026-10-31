import { useEffect, useRef } from 'react'
import { usePageVisible } from '@/hooks/usePageVisible'
import { perfTrack } from '@/utils/perfRegistry'
import { useI18n } from '@/i18n/I18nProvider'
import { useSceneStore } from '@/stores/sceneStore'
import { useSceneSettings } from '@/stores/sceneSettings'
import { familyColor, frameAt, isTick } from '@/utils/sceneData'
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
import { firingBar, occurrenceKeys, recordingFiringGains, recordingFiringStrength, type FiringGains, type FiringStrength } from '@/utils/sceneFiringGain'
import { kindColor } from '@/utils/kindColors'
import { useSceneStrength } from '@/stores/sceneStrength'
import { recordedIndexMap, recordedName } from '@/utils/sceneStrength'
import type { SceneEvent } from '@/utils/sceneData'

/**
 * A drawn marker; `gain`: what its bar shows in its lane (sound: the gain it plays at; haptics: the software multiplier,
 * DEC-102 r3; null: a loop cue / tick, drawn as before). Haptic one-shots: `strength` and the recorded firing `index`
 * (viewer-data events[i]; null for an emitted firing, which cannot be selected).
 */
type Hit = { x: number; y0: number; y1: number; name: string; t: number; lane: Lane; gain: number | null; strength: FiringStrength | null; index: number | null }
/** A drawn band of the selected loop cue: its lane's height and x range (CSS px). */
type Band = { x0: number; x1: number; y0: number; y1: number }
const MAX_ZOOM = 2000
/** The selected loop cue's input (recorded level) line and legend swatch: dashed; its output: solid. */
const INPUT_DASH = [5, 3]
/** Cap of a haptic bar whose sent value (material × software) is above 1: the device gets it clipped. */
const CLIPPED_CAP = '#ff4d4d'
/** Outline of a selected haptic bar (the strength panel's selection). */
const SELECTED = '#7cc4ff'
/** A press moves this far (CSS px) before it is a drag (a bar's strength, a range of firings). */
const DRAG_PX = 3

/**
 * Timeline: two lanes, sound (upper) and haptics (lower), as in the editor, each with its continuous-layer levels
 * scaled inside it (a selected loop cue: also its output, levelMap applied); a cue shows in each lane it uses (a selected loop cue: its whole active
 * span, as long as its layer's recorded level is above 0, as bands in those lanes); a one-shot firing's marker is as tall
 * as the gain it plays at in that lane (sound) or its software multiplier (haptics: lane top = ×1, the material as
 * authored; the tooltip splits software / material / sent; a cap marks above ×1, red when the sent value is clipped).
 * A click seeks (timelineClick); Ctrl (Cmd) + click a marker to edit that cue (the moments list marks it too), a band to
 * play that span in the full replay (SceneRuntime.playSpan; within the span already playing: seek). A firing is
 * reassigned from the moments list. Haptic one-shots are also the strength panel's selection (sceneStrength): a click
 * selects that firing (Shift / Ctrl: toggles it), a drag over an empty part of the haptic lane selects every firing in
 * that time range, and with per-firing editing on a vertical drag on a bar scales every selected firing's gain.
 * While a loop cue's span plays, the timeline shows only that span with its lead-in / post-roll, and a moment shows its
 * stretch of the full replay (sceneTimelineView).
 * Ctrl + wheel zooms around the pointer, wheel / Shift + wheel pans (like the editor's waveform), also while playing.
 * Read-outs and output toggles above it.
 */
export function SceneTimelinePanel() {
  const { t } = useI18n()
  const { runtime } = useScene()
  const hasChapters = useSceneStore(s => !!s.data?.chapters.length)
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
  /** Each firing's gains (sceneFiringGain; again when the table or the recording changes, so an edit shows at once). */
  const gains = useRef<{ table: CueTable | null; events: unknown; map: Map<string, FiringGains>; strength: Map<string, FiringStrength | null> }>({ table: null, events: null, map: new Map(), strength: new Map() })
  /** Recorded firing index by firingKey (again only for another recording or a gain edit). */
  const indices = useRef<{ events: readonly SceneEvent[] | null; map: Map<string, number> }>({ events: null, map: new Map() })
  /** The haptic lane's bar range as drawn (CSS px): top = ×1, bottom = 0. */
  const hapticLane = useRef<[number, number]>([0, 0])
  /** A range being dragged over the haptic lane (replay seconds), drawn as a box. */
  const rubber = useRef<{ t0: number; t1: number } | null>(null)

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
      // The visible stretch: a moment's stretch, a playing loop cue span's window (in the full replay), else the whole replay until zoomed.
      const shownSpan = it.kind === 'clip' ? spanWindow([it.start, it.end], dur) : s.span ? spanWindow(runtime.partAB, dur) : null
      const vw = view.current, key = `${s.cur}:${it.file}${shownSpan ? `:${shownSpan[0]}-${shownSpan[1]}` : ''}`
      stepView(vw, key, shownSpan, w, dur, MAX_ZOOM, !v.paused, v.currentTime)
      const span = w / vw.zoom
      const X = (time: number) => (time - vw.start) * vw.zoom, top = 6, base = h - 16, mid = Math.round((top + base) / 2)
      // Lane tints (sound blue above, haptics orange below); the part playing: a neutral wash (not a lane colour).
      const soundColor = kindColor('sound'), hapticColor = kindColor('haptic')
      ctx.fillStyle = kindColor('sound', 'soft'); ctx.globalAlpha = 0.5; ctx.fillRect(0, top, w, mid - top)
      ctx.fillStyle = kindColor('haptic', 'soft'); ctx.fillRect(0, mid + 1, w, base - mid - 1); ctx.globalAlpha = 1
      if (runtime.part && runtime.partAB) { ctx.fillStyle = 'rgba(255,255,255,.07)'; ctx.fillRect(X(runtime.partAB[0]), 0, X(runtime.partAB[1]) - X(runtime.partAB[0]), h) }
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
      const lanes: [number, number, (name: string) => boolean, (name: string) => string, Lane][] = [
        [top, mid, name => !!effective(name)?.sfx, () => soundColor, 'sound'],
        [mid + 1, base, name => { const e = effective(name); return !!e && (e.haptics.length > 0 || lib.loop_cues.includes(e.ref.cue)) }, name => familyColor(lib, name), 'haptics'],
      ]
      const gc = gains.current
      if (gc.table !== table || gc.events !== data.full.events) {
        gc.table = table; gc.events = data.full.events
        gc.map = table ? recordingFiringGains(table, data.full.events) : new Map()
        gc.strength = table ? recordingFiringStrength(table, data.full.events) : new Map()
      }
      const ix = indices.current, recorded = s.recorded?.full.events ?? null
      if (ix.events !== recorded) { ix.events = recorded; ix.map = recorded ? recordedIndexMap(recorded) : new Map() }
      const st = useSceneStrength.getState()
      hapticLane.current = [mid + 3, base]
      // Each shown firing's key (strength / gains) and its recorded firing's key (index), one per firing even at one time.
      const shownKeys = occurrenceKeys(events), recordedKeys = occurrenceKeys(events, recordedName)
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
      for (const [y0, y1, has, color, lane] of lanes) {
        let labelX = -1e9
        for (let k = 0; k < events.length; k++) {
          const ev = events[k]
          if (!has(ev.name)) continue
          const x = X(ev.t), picked = !!sel && sel.name === ev.name && sel.t != null && Math.abs(ev.t - sel.t) < 0.02
          if (x < -10 || x > w + 10) continue
          const tick = isTick(ticks, ev.name) && !picked, key = shownKeys[k]
          // Haptics: the software multiplier (a drag on the selection shows its ratio live); sound: the gain it plays at.
          const strength = lane === 'haptics' && !tick ? gc.strength.get(key) ?? null : null
          const index = strength ? ix.map.get(recordedKeys[k]) ?? null : null
          const chosen = index !== null && st.selected.has(index)
          const gain = tick ? null : lane === 'haptics' ? strength && strength.software * (chosen && st.dragRatio !== null ? st.dragRatio : 1) : gc.map.get(key)?.sound ?? null
          found.push({ x, y0, y1, name: ev.name, t: ev.t, lane, gain, strength, index })
          ctx.fillStyle = color(ev.name)
          ctx.globalAlpha = picked || chosen ? 1 : sel && sel.t != null ? 0.35 : it.kind === 'clip' && !ev.own ? 0.5 : 1
          if (tick) { ctx.fillRect(x, y1 - 6, 1, 6); continue }
          // A one-shot firing's bar: its gain × the lane height (1 at the lane top; above: clamped, with a cap — red when
          // the sent value is clipped; 0: dotted).
          const bw = picked || chosen ? 3 : 2
          if (gain === null) ctx.fillRect(x - 1, y0 + 2, bw, y1 - y0 - 2)
          else {
            const bar = firingBar(gain, y0 + 2, y1)
            if (bar.stub) for (let k = 1; k <= 7; k += 3) ctx.fillRect(x - 1, y1 - k, bw, 1)
            else ctx.fillRect(x - 1, bar.top, bw, y1 - bar.top)
            if (bar.over) { if (strength && strength.material * gain > 1) ctx.fillStyle = CLIPPED_CAP; ctx.fillRect(x - 3, bar.top, bw + 4, 2) }
            if (chosen) { ctx.strokeStyle = SELECTED; ctx.lineWidth = 1; ctx.strokeRect(x - 3.5, bar.top - 1.5, bw + 5, y1 - bar.top + 1.5) }
            ctx.fillStyle = color(ev.name)
          }
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
      ctx.fillStyle = soundColor; ctx.fillText(tr('scene.lane.sound'), 3, top + 24)
      ctx.fillStyle = hapticColor; ctx.fillText(tr('scene.lane.haptics'), 3, mid + 24)
      // The haptic lane's top is ×1 (the material as authored): a faint line and its label.
      ctx.fillStyle = 'rgba(255,255,255,.12)'; ctx.fillRect(0, mid + 3, w, 1)
      ctx.fillStyle = '#8b929b'; ctx.fillText('×1', 3, mid + 13)
      // A range being selected over the haptic lane.
      const rb = rubber.current
      if (rb) {
        const rx = Math.min(X(rb.t0), X(rb.t1)), rw = Math.abs(X(rb.t1) - X(rb.t0)), ry = mid + 1
        ctx.fillStyle = 'rgba(124,196,255,.12)'; ctx.fillRect(rx, ry, rw, base - ry)
        ctx.strokeStyle = SELECTED; ctx.lineWidth = 1; ctx.strokeRect(rx + 0.5, ry + 0.5, rw, base - ry - 1)
      }
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
  /**
   * Over a one-shot marker the tooltip is its gain: sound 「音声 0.50」, haptics its groups (「ソフトの倍率 ×0.20｜素材の基準
   * 0.80｜送る値 0.16」); elsewhere the hint. A haptic firing under the pointer is the strength panel's hovered one.
   */
  const onMouseMove = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const { hit } = hitAt(event)
    const text = hit?.strength ? t('scene.strength.tip', { software: hit.strength.software.toFixed(2), material: hit.strength.material.toFixed(2), sent: hit.strength.sent.toFixed(2) })
      : hit && hit.gain !== null ? `${t(hit.lane === 'sound' ? 'scene.lane.sound' : 'scene.lane.haptics')} ${hit.gain.toFixed(2)}` : t('scene.timeline.hint')
    if (event.currentTarget.title !== text) event.currentTarget.title = text
    useSceneStrength.getState().setHover(hit?.index ?? null)
  }
  /** Follows a press on the window until it is released (the callbacks get the distance from the press, CSS px). */
  const track = (event: React.MouseEvent, move: (dx: number, dy: number) => void, up: (dx: number, dy: number) => void) => {
    const x0 = event.clientX, y0 = event.clientY
    const onMove = (e: MouseEvent) => move(e.clientX - x0, e.clientY - y0)
    const onUp = (e: MouseEvent) => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); up(e.clientX - x0, e.clientY - y0) }
    window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp)
  }
  /**
   * A press on a haptic one-shot bar: Shift / Ctrl (Cmd) toggles it in the selection, a plain press selects it (one
   * already selected keeps the others until the release, so a drag moves them all). With per-firing editing on, a
   * vertical drag scales every selected firing's gain by the ratio the pressed bar's height follows (one undo step on
   * release). Returns whether the press is used up (Shift: selection only; Ctrl / a plain press go on as before).
   */
  const pressBar = (event: React.MouseEvent<HTMLCanvasElement>, hit: Hit & { index: number }): boolean => {
    const st = useSceneStrength.getState(), was = st.selected.has(hit.index)
    if (event.shiftKey || event.ctrlKey || event.metaKey) { st.select([hit.index], 'toggle'); return event.shiftKey }
    if (!was) st.select([hit.index], 'replace')
    const [laneTop, laneBottom] = hapticLane.current, H = laneBottom - laneTop, gain = hit.gain ?? 0
    // Drawn height (an over-cap bar is drawn at the lane top) and that height's value.
    const shown = Math.min(1, gain), h0 = shown * H
    const editing = useSceneSettings.getState().editFirings
    let dragging = false, ratio = 1
    track(event, (_, dy) => {
      if (!editing) return
      if (!dragging && Math.abs(dy) > DRAG_PX) dragging = true
      if (!dragging) return
      // The pressed bar's top follows the pointer (`v`: the value at the pointer, lane top = 1): below the lane top it
      // becomes v; above it (drawn clamped) the gain scales by v. A bar too short to scale from goes ×2 per 40 px.
      // Floored so the gains stay above 0 (scaleFiringGain keeps them ≥ 0.001) and a later ratio can raise them again.
      const v = (h0 - dy) / H
      ratio = h0 > 2 ? Math.max(0.001, v <= shown ? v / gain : v / shown) : 2 ** (-dy / 40)
      useSceneStrength.getState().setDragRatio(ratio)
    }, () => {
      const after = useSceneStrength.getState()
      if (dragging) { after.setDragRatio(null); after.scaleSelected(ratio) }
      else if (was) after.select([hit.index], 'replace')
    })
    return false
  }
  /** A press on an empty part of the haptic lane: a drag selects the firings in its time range (Shift / Ctrl: adds them), a click seeks as before. */
  const pressLane = (event: React.MouseEvent<HTMLCanvasElement>, time: number) => {
    const r = event.currentTarget.getBoundingClientRect(), x0 = event.clientX - r.left
    const add = event.shiftKey || event.ctrlKey || event.metaKey
    // The pixel → time mapping of the press, kept for the whole drag (the view may scroll while playing).
    const start = view.current.start, zoom = view.current.zoom
    const timeAt = (dx: number) => start + Math.max(0, Math.min(r.width, x0 + dx)) / zoom
    track(event, dx => { rubber.current = Math.abs(dx) > DRAG_PX ? { t0: time, t1: timeAt(dx) } : null }, dx => {
      rubber.current = null
      if (Math.abs(dx) <= DRAG_PX) { runtime.seek(time); return }
      useSceneStrength.getState().select(firingsBetween(time, timeAt(dx)), add ? 'add' : 'replace')
    })
  }
  /** Recorded indices of the haptic one-shot firings (not ticks) between two replay times, from the recording itself. */
  const firingsBetween = (a: number, b: number): number[] => {
    const s = useSceneStore.getState(), events = s.data?.full.events ?? [], ticks = s.lib?.ticks ?? [], lo = Math.min(a, b), hi = Math.max(a, b)
    const strength = s.table ? recordingFiringStrength(s.table, events) : new Map<string, FiringStrength | null>()
    const indexOf = s.recorded ? recordedIndexMap(s.recorded.full.events) : new Map<string, number>()
    const shownKeys = occurrenceKeys(events), recordedKeys = occurrenceKeys(events, recordedName)
    return events.flatMap((ev, k) => {
      const i = ev.t >= lo && ev.t <= hi && !isTick(ticks, ev.name) && strength.get(shownKeys[k]) ? indexOf.get(recordedKeys[k]) : undefined
      return i === undefined ? [] : [i]
    })
  }
  const onMouseDown = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (!useSceneStore.getState().items.length || event.button !== 0) return
    const { x, hit } = hitAt(event), time = view.current.start + x / view.current.zoom
    const y = event.clientY - event.currentTarget.getBoundingClientRect().top, mod = event.ctrlKey || event.metaKey
    if (hit?.lane === 'haptics' && hit.index !== null) { if (pressBar(event, hit as Hit & { index: number })) return }
    else if (!hit && y >= hapticLane.current[0] - 2 && y <= hapticLane.current[1] && !(mod && bandRunAt(event, time))) { pressLane(event, time); return }
    const click = timelineClick(mod, hit ?? null, bandRunAt(event, time), time)
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
    const s = useSceneStore.getState()
    if (!s.items[s.cur] || !s.data || !s.lib || !s.sel) return null
    const run = loopCueRuns(s.data.full.levels, s.data.fps, s.lib, s.sel.name).find(([a, b]) => time >= a && time <= b)
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
    <canvas className="scene-timeline-canvas" ref={canvas} tabIndex={0} title={t('scene.timeline.hint')} onMouseDown={onMouseDown} onMouseMove={onMouseMove}
      onMouseLeave={() => useSceneStrength.getState().setHover(null)} />
    <div className="scene-help">{t('scene.keys')}{hasChapters ? t('scene.keys.chapters') : ''}</div>
  </div>
}

