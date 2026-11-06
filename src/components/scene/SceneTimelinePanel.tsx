import { useEffect, useRef } from 'react'
import { usePageVisible } from '@/hooks/usePageVisible'
import { perfTrack } from '@/utils/perfRegistry'
import { useI18n } from '@/i18n/I18nProvider'
import { useSceneStore } from '@/stores/sceneStore'
import { useSceneSettings } from '@/stores/sceneSettings'
import { drawnEvents, familyColor, frameAt, isTick, type SceneItem, type VisibleEvent } from '@/utils/sceneData'
import { WHEEL_ZOOM_RATE, wheelPixels, zoomAtTime } from '@/utils/waveformView'
import { effectiveEvent, resolveEventName } from '@/utils/cueEvents'
import { useScene } from './sceneContext'
import { SPEEDS } from './sceneRuntime'
import { SceneOutputToggles } from './SceneOutputToggles'
import { loopCueRuns } from '@/utils/loopStretch'
import { useMomentPlace } from './SceneCuePanels'
import { kitGainsFor, type CueTable, type KitClipGains } from '@/utils/sceneCueTable'
import { effectiveOutput, useScenePlayback } from '@/stores/scenePlayback'
import { mapLevel } from '@/utils/levelMap'
import { laneY, layerLanes, layerScaleMax, outputCurves, outputScaleMax, sideLevel, type Lane, type OutputCurve } from '@/utils/sceneTimelineLevels'
import { spanWindow, stepView, timelineClick, type TimelineView } from '@/utils/sceneTimelineView'
import { firingBar, occurrenceKeys, recordingFiringGains, recordingFiringStrength, type FiringGains, type FiringStrength } from '@/utils/sceneFiringGain'
import { kindColor } from '@/utils/kindColors'
import { useSceneStrength } from '@/stores/sceneStrength'
import { barDragRatio, recordedIndexMap, recordedName, selectableFirings, strengthStep } from '@/utils/sceneStrength'
import { dragAxes, firingNumber, firingNumbers, isEmitted, numbersInRange, repeatRange, repeatRangeText, snapDt, tableHasSfx, visibleLanes } from '@/utils/sceneTimelineEdit'
import { useSceneTimelineRange } from '@/stores/sceneTimelineRange'
import type { SceneEvent } from '@/utils/sceneData'
import { SceneLockToggles } from './SceneFiringPanel'

/**
 * A drawn marker; `gain`: what its bar shows in its lane (sound: the gain it plays at; haptics: the app gain,
 * DEC-102 r3; null: a loop cue / tick, drawn as before). Haptic one-shots: `strength` and the recorded firing `index`
 * (viewer-data events[i]; null for an emitted firing, which cannot be selected).
 */
type Hit = { x: number; half: number; y0: number; y1: number; name: string; t: number; lane: Lane; gain: number | null; strength: FiringStrength | null; index: number | null; emitted: boolean }
/** A drawn band of the selected loop cue: its lane's height and x range (CSS px). */
type Band = { x0: number; x1: number; y0: number; y1: number }
const MAX_ZOOM = 2000
/** The selected loop cue's input (recorded level) line and legend swatch: dashed; its output: solid. */
const INPUT_DASH = [5, 3]
/** Cap of a haptic bar whose sent value (material × app) is above 1: the device gets it clipped. */
const CLIPPED_CAP = '#ff4d4d'
/** Outline of a selected haptic bar (the strength panel's selection). */
const SELECTED = '#7cc4ff'
/** A press moves this far (CSS px) before it is a drag (a bar's strength, a range of firings). */
const DRAG_PX = 3
/** A haptic one-shot bar's width (CSS px; selected or picked: wider), centred on its time. */
const BAR_W = 7, BAR_W_SELECTED = 9
/** The 1 px line at a haptic bar's exact time (darker than the bar). */
const EXACT_LINE = 'rgba(0,0,0,.6)'
/** Alt + wheel notches this close (ms) are one strength change (one undo step). */
const WHEEL_BURST_MS = 400
/** Firings not of the shown moment (or not the selected cue) are dimmed to this, never less (they stay readable). */
const DIMMED = 0.6
/** The repeat range's band and edge lines (distinct from the view, the selection and the lanes). */
const REPEAT_FILL = 'rgba(61,214,208,.10)', REPEAT_EDGE = 'rgba(61,214,208,.75)'

/**
 * Timeline: two lanes, sound (upper) and haptics (lower), as in the editor (the header's chips show either alone; the
 * sound lane only when the cue table has sound; one lane takes the whole height), each with its continuous-layer levels
 * scaled inside it (a selected loop cue: also its output, levelMap applied); a cue shows in each lane it uses (a selected loop cue: its whole active
 * span, as long as its layer's recorded level is above 0, as bands in those lanes); a one-shot firing's marker is as tall
 * as the gain it plays at in that lane (sound) or its app gain (haptics: lane top = ×1, the material as
 * authored; the tooltip splits app / material / sent; a cap marks above ×1, red when the sent value is clipped).
 * The seconds grid shows full-replay times. A click seeks (timelineClick); Ctrl (Cmd) + click a marker to edit that cue
 * (the moments list marks it too), a band to play that span in the full replay (SceneRuntime.playSpan; within the span
 * already playing: seek). A firing is reassigned from the moments list. Haptic one-shots (wide bars with a line at the
 * exact time, labelled with their firing number — the moments list's rows) are the firing selection (sceneStrength): a click selects that firing
 * (Shift / Ctrl: toggles it; one firing clicked is also the picked cue, and a paused video seeks to its time), a drag
 * over an empty part of the haptic lane selects every firing in that time range, and a drag on a selected bar changes
 * every selected firing (viewer-edits.json): vertical = strength, horizontal = time (frame-snapped), each unless locked
 * (studio-scene-ui.json lockTime / lockGain; Shift keeps only the larger axis). Alt + wheel: ±1 dB (Shift ±3 dB), one
 * undo step per burst (not while the gain is locked). The selected firings' gain and time are also edited in the 「発生」 panel (SceneFiringPanel).
 * Every firing of the full replay is drawn at any zoom (a moment's own firings normal, the rest dimmed to DIMMED);
 * emitted firings (cue table `emit`) are drawn hollow, not numbered and not in the list. What repeats (repeatRange: a
 * moment from its lead-in to its end, W's part or a loop cue span, a chapter) is a band with edge lines, named in the
 * header (「繰り返し 3.3–8.3 s」 / 「全編」). The drawn range and its first / last firing numbers go to
 * sceneTimelineRange for the moments list's bracket. A selected moment or a playing loop cue span first fills the view
 * (sceneTimelineView); zooming out shows the rest.
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
  const repeat = useRef<HTMLSpanElement>(null)
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
  const gains = useRef<{ table: CueTable | null; kit: KitClipGains | null; events: unknown; map: Map<string, FiringGains>; strength: Map<string, FiringStrength | null> }>({ table: null, kit: null, events: null, map: new Map(), strength: new Map() })
  /** Recorded firing index by firingKey (again only for another recording or a gain edit). */
  const indices = useRef<{ events: readonly SceneEvent[] | null; map: Map<string, number> }>({ events: null, map: new Map() })
  /** The haptic lane's bar range as drawn (CSS px): top = ×1, bottom = 0; null while the lane is hidden. */
  const hapticLane = useRef<[number, number] | null>(null)
  /** Whether the cue table has sound (again only for another table). */
  const sfx = useRef<{ table: CueTable | null; has: boolean }>({ table: null, has: false })
  /** Each shown firing's number (firingNumbers, aligned with data.full.events; again only when the firings change). */
  const numbers = useRef<{ events: unknown; nums: (number | null)[] }>({ events: null, nums: [] })
  /**
   * The drawn firings (drawnEvents: all of the full replay, aligned with data.full.events) with their keys (strength /
   * gains; recorded index) and bar labels (`<number> <name>`) and label widths: again only when the item, the firings
   * or the numbers change (not every frame).
   */
  const shown = useRef<{ item: SceneItem | null; all: unknown; nums: unknown; events: VisibleEvent[]; keys: string[]; recordedKeys: string[]; labels: string[]; widths: number[] }>(
    { item: null, all: null, nums: null, events: [], keys: [], recordedKeys: [], labels: [], widths: [] })
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
      if (!it || !lib || !data) { hits.current = []; bands.current = []; useSceneTimelineRange.getState().setRange(null); useSceneTimelineRange.getState().setRepeat(null); return }
      const fps = data.fps, layers = lib.layers, ticks = lib.ticks, sel = s.sel, table = s.table
      const dur = v.duration || it.levels.length / fps || 1
      // The visible stretch: a moment's stretch, a playing loop cue span's window (in the full replay), else the whole replay until zoomed.
      const shownSpan = it.kind === 'clip' ? spanWindow([it.start, it.end], dur) : s.span ? spanWindow(runtime.partAB, dur) : null
      const vw = view.current, key = `${s.cur}:${it.file}${shownSpan ? `:${shownSpan[0]}-${shownSpan[1]}` : ''}`
      stepView(vw, key, shownSpan, w, dur, MAX_ZOOM, !v.paused, v.currentTime)
      const span = w / vw.zoom
      // The drawn range and its firings' first / last numbers (the moments list's bracket and 「タイムライン: 04–08」).
      const nb = numbers.current
      if (nb.events !== data.full.events) { nb.events = data.full.events; nb.nums = firingNumbers(data.full.events) }
      useSceneTimelineRange.getState().setRange(vw.start, vw.start + span, numbersInRange(data.full.events, nb.nums, vw.start, vw.start + span))
      // What repeats: the band below and the header's 「繰り返し a–b s」.
      const chapter = s.chapter === null ? null : data.chapters[s.chapter] ?? null
      const rr = repeatRange(it, runtime.part ? runtime.partAB : null, useSceneSettings.getState().leadSec, chapter)
      useSceneTimelineRange.getState().setRepeat(rr)
      // The lanes shown (header chips; sound only when the table has any): both split the height, one takes it all.
      if (sfx.current.table !== table) sfx.current = { table, has: tableHasSfx(table) }
      const shownLanes = visibleLanes(useSceneSettings.getState().lanes, sfx.current.has)
      const X = (time: number) => (time - vw.start) * vw.zoom, top = 6, base = h - 16, mid = Math.round((top + base) / 2), both = shownLanes.sound && shownLanes.haptics
      const soundBox: [number, number] | null = shownLanes.sound ? [top, both ? mid : base] : null
      const hapticBox: [number, number] | null = shownLanes.haptics ? [both ? mid + 1 : top, base] : null
      // Lane tints (sound blue above, haptics orange below); the part playing: a neutral wash (not a lane colour).
      const soundColor = kindColor('sound'), hapticColor = kindColor('haptic')
      ctx.globalAlpha = 0.5
      if (soundBox) { ctx.fillStyle = kindColor('sound', 'soft'); ctx.fillRect(0, soundBox[0], w, soundBox[1] - soundBox[0]) }
      if (hapticBox) { ctx.fillStyle = kindColor('haptic', 'soft'); ctx.fillRect(0, hapticBox[0], w, hapticBox[1] - hapticBox[0]) }
      ctx.globalAlpha = 1
      if (rr) {
        const x0 = X(rr[0]), x1 = X(rr[1])
        ctx.fillStyle = REPEAT_FILL; ctx.fillRect(x0, 0, x1 - x0, base)
        ctx.fillStyle = REPEAT_EDGE; ctx.fillRect(Math.round(x0) - 0.5, 0, 1, base); ctx.fillRect(Math.round(x1) - 0.5, 0, 1, base)
      }
      if (both) { ctx.fillStyle = '#1a1d21'; ctx.fillRect(0, mid, w, 1) }
      ctx.font = '10px Segoe UI, sans-serif'
      // Seconds grid: full-replay times (a moment too).
      ctx.fillStyle = '#5c636c'
      const step = span > 60 ? 10 : span > 20 ? 5 : span > 4 ? 1 : 0.5
      for (let sec = Math.ceil(vw.start / step) * step; sec <= vw.start + span; sec += step) { ctx.fillRect(X(sec), base, 1, 4); ctx.fillText(sec.toFixed(step < 1 ? 1 : 0) + 's', X(sec) + 2, h - 3) }
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
      const laneBox = (lane: Lane): [number, number] | null => { const b = lane === 'sound' ? soundBox : hapticBox; return b && [b[0] + 3, b[1] - 1] }
      const path = (value: (n: number) => number, max: number, y0: number, y1: number) => {
        ctx.beginPath()
        for (let n = 0; n < L.length; n++) { const px = X(n / fps), py = laneY(value(n), max, y0, y1); if (n) ctx.lineTo(px, py); else ctx.moveTo(px, py) }
        ctx.stroke()
      }
      // `cue:variant` names resolve like the game (variant fields, else the cue's).
      const effective = (name: string) => { const r = table ? resolveEventName(table, name) : null; return r && table ? effectiveEvent(table, r.ref) : null }
      // Sound above, haptics below (as in the editor).
      const lanes: [number, number, (name: string) => boolean, (name: string) => string, Lane][] = []
      if (soundBox) lanes.push([soundBox[0], soundBox[1], name => !!effective(name)?.sfx, () => soundColor, 'sound'])
      if (hapticBox) lanes.push([hapticBox[0], hapticBox[1], name => { const e = effective(name); return !!e && (e.haptics.length > 0 || lib.loop_cues.includes(e.ref.cue)) }, name => familyColor(lib, name), 'haptics'])
      const gc = gains.current
      // The Kit's clip gains of the output playing now (contracts cue-table §9.1).
      const kit = kitGainsFor(s.projectKit?.clipGains, effectiveOutput(useScenePlayback.getState()))
      if (gc.table !== table || gc.kit !== kit || gc.events !== data.full.events) {
        gc.table = table; gc.kit = kit; gc.events = data.full.events
        gc.map = table ? recordingFiringGains(table, data.full.events, kit) : new Map()
        gc.strength = table ? recordingFiringStrength(table, data.full.events, kit) : new Map()
      }
      // The recorded firings at their edited times (recorded order): the shown firings' keys find their recorded index.
      const ix = indices.current, recorded = s.edited?.full.events ?? null
      if (ix.events !== recorded) { ix.events = recorded; ix.map = recorded ? recordedIndexMap(recorded) : new Map() }
      const st = useSceneStrength.getState()
      hapticLane.current = hapticBox && [hapticBox[0] + 2, hapticBox[1]]
      // Every firing of the full replay: each one's key (strength / gains), its recorded firing's key (index), one per
      // firing even at one time, and its label (the moments list's number and its name) with the label's width (the font is fixed).
      const sh = shown.current
      if (sh.item !== it || sh.all !== data.full.events || sh.nums !== nb.nums) {
        sh.item = it; sh.all = data.full.events; sh.nums = nb.nums
        sh.events = drawnEvents(it, data.full.events); sh.keys = occurrenceKeys(sh.events); sh.recordedKeys = occurrenceKeys(sh.events, recordedName)
        sh.labels = sh.events.map((ev, k) => { const num = nb.nums[k]; return num == null ? ev.name : `${firingNumber(num)} ${ev.name}` })
        sh.widths = sh.labels.map(label => ctx.measureText(label).width)
      }
      // Cue markers per lane: the selected cue bright and framed, the clip's moment normal, the rest dimmed.
      const events = sh.events, shownKeys = sh.keys, recordedKeys = sh.recordedKeys
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
        let labelEnd = -1e9
        for (let k = 0; k < events.length; k++) {
          const ev = events[k]
          if (!has(ev.name)) continue
          const picked = !!sel && sel.name === ev.name && sel.t != null && Math.abs(ev.t - sel.t) < 0.02
          const tick = isTick(ticks, ev.name) && !picked, key = shownKeys[k], emitted = isEmitted(ev)
          // Haptics: the app gain (a drag on the selection shows its ratio / time shift live); sound: the gain it plays at.
          const strength = lane === 'haptics' && !tick ? gc.strength.get(key) ?? null : null
          const index = strength ? ix.map.get(recordedKeys[k]) ?? null : null
          const chosen = index !== null && st.selected.has(index)
          const x = X(ev.t + (chosen && st.dragDt !== null ? st.dragDt : 0))
          if (x < -10 || x > w + 10) continue
          const gain = tick ? null : lane === 'haptics' ? strength && strength.app * (chosen && st.dragRatio !== null ? st.dragRatio : 1) : gc.map.get(key)?.sound ?? null
          // A haptic one-shot is a wide bar centred on its time; the rest stay thin.
          const wide = lane === 'haptics' && gain !== null, bw = wide ? (picked || chosen ? BAR_W_SELECTED : BAR_W) : picked || chosen ? 3 : 2, bx = wide ? x - bw / 2 : x - 1
          found.push({ x, half: wide ? bw / 2 + 0.5 : 0, y0, y1, name: ev.name, t: ev.t, lane, gain, strength, index, emitted })
          ctx.fillStyle = color(ev.name)
          ctx.globalAlpha = picked || chosen ? 1 : (sel && sel.t != null) || (it.kind === 'clip' && !ev.own) ? DIMMED : 1
          if (tick) { ctx.fillRect(x, y1 - 6, 1, 6); continue }
          // A one-shot firing's bar: its gain × the lane height (1 at the lane top; above: clamped, with a cap — red when
          // the sent value is clipped; 0: dotted); a haptic bar has a 1 px line at its exact time.
          // An emitted firing (cue table `emit`): hollow and dashed, the same height, never selected.
          if (emitted) {
            const top = gain === null ? y0 + 2 : firingBar(gain, y0 + 2, y1).top
            ctx.strokeStyle = color(ev.name); ctx.lineWidth = 1; ctx.setLineDash([2, 2]); ctx.strokeRect(bx + 0.5, top + 0.5, Math.max(1, bw - 1), y1 - top - 1); ctx.setLineDash([])
          } else if (gain === null) ctx.fillRect(bx, y0 + 2, bw, y1 - y0 - 2)
          else {
            const bar = firingBar(gain, y0 + 2, y1)
            if (bar.stub) for (let n = 1; n <= 7; n += 3) ctx.fillRect(bx, y1 - n, bw, 1)
            else ctx.fillRect(bx, bar.top, bw, y1 - bar.top)
            if (bar.over) { if (strength && strength.material * gain > 1) ctx.fillStyle = CLIPPED_CAP; ctx.fillRect(bx - 2, bar.top, bw + 4, 2) }
            if (wide && !bar.stub) { ctx.fillStyle = EXACT_LINE; ctx.fillRect(x - 0.5, bar.top, 1, y1 - bar.top) }
            if (chosen) { ctx.strokeStyle = SELECTED; ctx.lineWidth = 1; ctx.strokeRect(bx - 1.5, bar.top - 1.5, bw + 3, y1 - bar.top + 1.5) }
            ctx.fillStyle = color(ev.name)
          }
          if (picked) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.strokeRect(bx - 2.5, y0 + 0.5, bw + 5, y1 - y0) }
          // Its moment number and name (the moments list's numbering), unless it would overlap the last label.
          if (x + 5 > labelEnd + 4 || picked) { ctx.fillText(sh.labels[k], x + 5, y0 + 12); labelEnd = x + 5 + sh.widths[k] }
        }
      }
      hits.current = found
      ctx.globalAlpha = 1
      // Level lines on top of the bands and markers (a band's edge never hides them). The selected loop cue: its input
      // (the recorded level) dashed, its output (levelMap applied) solid and thicker, same colours.
      layers.forEach((l, li) => {
        const mine = l === selLayer, max = mine ? oc.max : sc.max[li]
        for (const lane of layerLanes(table, l.cue)) {
          const box = laneBox(lane)
          if (!box) continue
          const [y0, y1] = box
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
      if (soundBox) { ctx.fillStyle = soundColor; ctx.fillText(tr('scene.lane.sound'), 3, soundBox[0] + 24) }
      if (hapticBox) {
        ctx.fillStyle = hapticColor; ctx.fillText(tr('scene.lane.haptics'), 3, hapticBox[0] + 23)
        // The haptic lane's top is ×1 (the material as authored): a faint line and its label.
        ctx.fillStyle = 'rgba(255,255,255,.12)'; ctx.fillRect(0, hapticBox[0] + 2, w, 1)
        ctx.fillStyle = '#8b929b'; ctx.fillText('×1', 3, hapticBox[0] + 12)
      }
      // A range being selected over the haptic lane.
      const rb = rubber.current
      if (rb && hapticBox) {
        const rx = Math.min(X(rb.t0), X(rb.t1)), rw = Math.abs(X(rb.t1) - X(rb.t0)), ry = hapticBox[0]
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
      if (repeat.current) { const text = rr ? tr('scene.repeat.range', { range: repeatRangeText(rr) }) : tr('scene.repeat.full'); if (repeat.current.textContent !== text) repeat.current.textContent = text }
      if (state.current) state.current.textContent = `${SPEEDS[runtime.speedIndex]}x　loop ${runtime.part ? '±0.5s' : useSceneSettings.getState().loop ? 'on' : 'off'}　${Math.floor(time * fps)}f`
    }
    frame = requestAnimationFrame(draw)
    perfTrack('rafLoops', 1)
    return () => { cancelAnimationFrame(frame); perfTrack('rafLoops', -1) }
  }, [runtime, live])

  const hitAt = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const r = event.currentTarget.getBoundingClientRect(), x = event.clientX - r.left, y = event.clientY - r.top
    return { x, hit: hits.current.filter(m => y >= m.y0 && y <= m.y1 && Math.abs(m.x - x) <= Math.max(5, m.half)).sort((a, b) => Math.abs(a.x - x) - Math.abs(b.x - x))[0] }
  }
  /**
   * Over a one-shot marker the tooltip is its gain: sound 「音声 0.50」, haptics its groups (「ソフトの倍率 ×0.20｜素材の基準
   * 0.80｜送る値 0.16」); elsewhere the hint.
   */
  const onMouseMove = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const { hit } = hitAt(event)
    const text = hit?.emitted ? t('scene.timeline.emittedTip', { name: hit.name })
      : hit?.strength ? t('scene.strength.tip', { app: hit.strength.app.toFixed(2), material: hit.strength.material.toFixed(2), sent: hit.strength.sent.toFixed(2) })
      : hit && hit.gain !== null ? `${t(hit.lane === 'sound' ? 'scene.lane.sound' : 'scene.lane.haptics')} ${hit.gain.toFixed(2)}` : t('scene.timeline.hint')
    if (event.currentTarget.title !== text) event.currentTarget.title = text
  }
  /** Follows a press on the window until it is released (the callbacks get the distance from the press, CSS px). */
  const track = (event: React.MouseEvent, move: (dx: number, dy: number, e: MouseEvent) => void, up: (dx: number, dy: number) => void) => {
    const x0 = event.clientX, y0 = event.clientY
    const onMove = (e: MouseEvent) => move(e.clientX - x0, e.clientY - y0, e)
    const onUp = (e: MouseEvent) => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); up(e.clientX - x0, e.clientY - y0) }
    window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp)
  }
  /**
   * A press on a haptic one-shot bar: Shift / Ctrl (Cmd) toggles it in the selection, a plain press selects it (one
   * already selected keeps the others until the release, so a drag moves them all). A drag changes every selected
   * firing, live, one undo step per axis on release: vertical = strength (the ratio the pressed bar's height follows),
   * horizontal = time (the same shift for all, frame-snapped), each unless locked (Shift during the drag: the larger
   * axis only). Each axis starts only once the pointer moved past DRAG_PX along it, so a slip along a locked axis stays a
   * click. A click (no unlocked axis moved) leaves this firing alone selected, marks it as the picked cue (the moments
   * list shows its row; the timeline's window stays) and, while the video is paused, seeks to its exact time.
   * Returns whether the press is used up (Ctrl goes on as before: that cue in the Event panel).
   */
  const pressBar = (event: React.MouseEvent<HTMLCanvasElement>, hit: Hit & { index: number }): boolean => {
    const st = useSceneStrength.getState(), was = st.selected.has(hit.index)
    if (event.shiftKey || event.ctrlKey || event.metaKey) { st.select([hit.index], 'toggle'); return event.shiftKey }
    if (!was) st.select([hit.index], 'replace')
    const lane = hapticLane.current, H = lane ? lane[1] - lane[0] : 1, gain = hit.gain ?? 0
    // The pixel → time scale of the press, kept for the whole drag.
    const zoom = view.current.zoom, fps = useSceneStore.getState().data?.fps ?? 30
    let dragging = false, ratio: number | null = null, dt: number | null = null
    // Which unlocked axes the pointer has moved along past DRAG_PX (each from then on, for the rest of the drag).
    const moved = { time: false, gain: false }
    track(event, (dx, dy, e) => {
      const ui = useSceneSettings.getState(), locks = { time: ui.lockTime, gain: ui.lockGain }
      if (!locks.time && Math.abs(dx) > DRAG_PX) moved.time = true
      if (!locks.gain && Math.abs(dy) > DRAG_PX) moved.gain = true
      dragging = moved.time || moved.gain
      if (!dragging) return
      const axes = dragAxes(dx, dy, locks, e.shiftKey)
      // The pressed bar's drawn top follows the pointer (barDragRatio: 1 at the press point, never 0).
      ratio = axes.gain && moved.gain ? barDragRatio(gain, dy, H) : null
      dt = axes.time && moved.time ? snapDt(dx / zoom, fps) : null
      const now = useSceneStrength.getState()
      now.setDragRatio(ratio); now.setDragDt(dt)
    }, () => {
      const after = useSceneStrength.getState()
      if (dragging) {
        after.setDragRatio(null); after.setDragDt(null)
        if (ratio !== null && Math.abs(ratio - 1) > 1e-9) after.scaleSelected(ratio)
        if (dt) after.moveSelected(dt)
        return
      }
      if (was) after.select([hit.index], 'replace')
      useSceneStore.getState().selectCue(hit.name, hit.t)
      if (runtime.video.paused) runtime.seek(hit.t)
    })
    return true
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
  /** Recorded indices of the haptic one-shot firings between two replay times (the lane draws every firing). */
  const firingsBetween = (a: number, b: number): number[] => {
    const s = useSceneStore.getState()
    if (!s.table || !s.data || !s.edited) return []
    return selectableFirings(s.table, s.data.full.events, s.edited.full.events, s.lib?.ticks ?? [], a, b, null)
  }
  const onMouseDown = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (!useSceneStore.getState().items.length || event.button !== 0) return
    const { x, hit } = hitAt(event), time = view.current.start + x / view.current.zoom
    const y = event.clientY - event.currentTarget.getBoundingClientRect().top, mod = event.ctrlKey || event.metaKey
    const lane = hapticLane.current
    if (hit?.lane === 'haptics' && hit.index !== null) { if (pressBar(event, hit as Hit & { index: number })) return }
    else if (!hit && lane && y >= lane[0] - 2 && y <= lane[1] && !(mod && bandRunAt(event, time))) { pressLane(event, time); return }
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
  // Ctrl + wheel zooms around the pointer; wheel / Shift + wheel pans (the editor waveform's handling). Alt + wheel with
  // firings selected: their strength ±1 dB per notch (Shift ±3 dB), live through dragRatio, one undo step per burst.
  useEffect(() => {
    const cv = canvas.current
    if (!cv) return
    const burst = { ratio: 1, timer: undefined as ReturnType<typeof setTimeout> | undefined }
    const commit = () => {
      clearTimeout(burst.timer); burst.timer = undefined
      const ratio = burst.ratio, st = useSceneStrength.getState()
      burst.ratio = 1
      st.setDragRatio(null)
      if (ratio !== 1) st.scaleSelected(ratio)
    }
    const wheel = (event: WheelEvent) => {
      const r = cv.getBoundingClientRect(), vw = view.current, dur = runtime.video.duration || 1, fit = r.width / dur
      const delta = wheelPixels(event, r.width)
      event.preventDefault(); event.stopPropagation()
      if (event.altKey && useSceneStrength.getState().selected.size) {
        // 「ゲインをロック」: the gain stays (the notch is used up, nothing pans).
        if (useSceneSettings.getState().lockGain) return
        // Shift + wheel may come as a horizontal delta.
        const d = event.deltaY || event.deltaX
        if (!d) return
        burst.ratio *= strengthStep(event.shiftKey) ** (d < 0 ? 1 : -1)
        useSceneStrength.getState().setDragRatio(burst.ratio)
        clearTimeout(burst.timer); burst.timer = setTimeout(commit, WHEEL_BURST_MS)
        return
      }
      if (event.ctrlKey) {
        const x = Math.max(0, Math.min(r.width, event.clientX - r.left)), time = vw.start + x / vw.zoom
        const next = Math.min(MAX_ZOOM, Math.max(fit, vw.zoom * Math.exp(-delta * WHEEL_ZOOM_RATE)))
        vw.start = zoomAtTime(time, x, next, r.width, dur); vw.zoom = next; vw.fit = next <= fit; vw.span = false
      } else { vw.start = Math.max(0, Math.min(Math.max(0, dur - r.width / vw.zoom), vw.start + delta / vw.zoom)); vw.span = false }
    }
    cv.addEventListener('wheel', wheel, { passive: false })
    return () => { cv.removeEventListener('wheel', wheel); if (burst.timer !== undefined) commit() }
  }, [runtime])

  return <div className="scene-timeline">
    <div className="scene-info">
      <span className="scene-info-title" ref={title} />
      <span className="scene-info-dim" ref={note} />
      <span className="scene-info-dim scene-info-levels" ref={levels} />
      <span className="scene-info-repeat" ref={repeat} title={t('scene.repeat.hint')} />
      <span className="scene-info-state" ref={state} />
      <SceneLaneChips />
      <SceneLockToggles />
      <SceneOutputToggles />
    </div>
    <canvas className="scene-timeline-canvas" ref={canvas} tabIndex={0} title={t('scene.timeline.hint')} onMouseDown={onMouseDown} onMouseMove={onMouseMove} />
    <div className="scene-help">{t('scene.keys')}{hasChapters ? t('scene.keys.chapters') : ''}</div>
  </div>
}


/** 「音声」「触覚」 chips: which timeline lanes show (studio-scene-ui.json `lanes`; at least one; sound only when the cue table has sound). */
function SceneLaneChips() {
  const { t } = useI18n()
  const lanes = useSceneSettings(s => s.lanes)
  const hasSfx = useSceneStore(s => tableHasSfx(s.table))
  const shown = visibleLanes(lanes, hasSfx)
  const chip = (lane: 'sound' | 'haptics', label: string, title: string, disabled: boolean) =>
    <button type="button" className={`${lane} ${shown[lane] ? 'on' : ''}`} aria-pressed={shown[lane]} title={title} disabled={disabled}
      onClick={e => { e.currentTarget.blur(); useSceneSettings.getState().update({ lanes: { ...shown, [lane]: !shown[lane] } }) }}>{label}</button>
  return <span className="scene-seg scene-tl-seg" role="group" aria-label={t('scene.lanes.label')}>
    {chip('sound', t('scene.lane.sound'), hasSfx ? t('scene.lanes.soundHint') : t('scene.lanes.noSfx'), !hasSfx || (shown.sound && !shown.haptics))}
    {chip('haptics', t('scene.lane.haptics'), t('scene.lanes.hapticsHint'), shown.haptics && !shown.sound)}
  </span>
}
