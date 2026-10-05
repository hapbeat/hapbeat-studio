import { useEffect, useRef } from 'react'
import { usePageVisible } from '@/hooks/usePageVisible'
import { perfTrack } from '@/utils/perfRegistry'
import { useI18n } from '@/i18n/I18nProvider'
import { useSceneStore } from '@/stores/sceneStore'
import { useSceneSettings } from '@/stores/sceneSettings'
import { familyColor, frameAt } from '@/utils/sceneData'
import { effectiveEvent, resolveEventName } from '@/utils/cueEvents'
import { useScene } from './sceneContext'
import { SPEEDS } from './sceneRuntime'
import { SceneOutputToggles } from './SceneOutputToggles'
import { useMomentPlace } from './SceneCuePanels'

const SOUND_COLOR = '#36c5c0'
type Hit = { x: number; y0: number; y1: number; name: string; t: number }

/**
 * Timeline: continuous-layer levels behind two lanes, haptics (upper) and
 * sound (lower); a cue shows in each lane it uses. Click a marker to edit
 * that cue, elsewhere to seek. Read-outs and output toggles above it.
 */
export function SceneTimelinePanel() {
  const { t } = useI18n()
  const { runtime } = useScene()
  const canvas = useRef<HTMLCanvasElement>(null)
  const hits = useRef<Hit[]>([])
  const title = useRef<HTMLSpanElement>(null)
  const note = useRef<HTMLSpanElement>(null)
  const levels = useRef<HTMLSpanElement>(null)
  const state = useRef<HTMLSpanElement>(null)
  const tRef = useRef(t); tRef.current = t
  const placeOf = useMomentPlace()
  const placeRef = useRef(placeOf); placeRef.current = placeOf

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
      if (!it || !lib || !data) { hits.current = []; return }
      const fps = data.fps, layers = lib.layers, ticks = lib.ticks, sel = s.sel, table = s.table
      const series = layers.flatMap(l => l.gain.map((i, k) => ({ i, color: l.colors[k] })))
      const dur = v.duration || it.levels.length / fps || 1
      const X = (time: number) => time / dur * w, top = 6, base = h - 16, mid = Math.round((top + base) / 2)
      if (runtime.part && runtime.partAB) { ctx.fillStyle = 'rgba(78,161,255,.13)'; ctx.fillRect(X(runtime.partAB[0]), 0, X(runtime.partAB[1]) - X(runtime.partAB[0]), h) }
      ctx.fillStyle = '#1a1d21'; ctx.fillRect(0, mid, w, 1)
      ctx.font = '10px Segoe UI, sans-serif'
      // Seconds grid (a clip counts from its cue).
      ctx.fillStyle = '#5c636c'
      const step = dur > 20 ? 5 : 1
      for (let sec = 0; sec <= dur; sec += step) { ctx.fillRect(X(sec), base, 1, 4); ctx.fillText(it.kind === 'clip' ? (sec - it.event).toFixed(0) + 's' : sec + 's', X(sec) + 2, h - 3) }
      // Continuous layer levels.
      const L = it.levels
      let peak = 1
      for (const r of L) for (const x of series) peak = Math.max(peak, r[x.i])
      const selLayer = sel ? layers.find(l => l.cue === sel.name) : undefined
      for (const x of series) {
        if (!L.some(r => r[x.i] > 0)) continue
        const mine = !!selLayer && selLayer.gain.includes(x.i)
        ctx.globalAlpha = selLayer ? (mine ? 1 : 0.3) : 0.7
        ctx.strokeStyle = x.color; ctx.lineWidth = mine ? 2.5 : 1.5; ctx.beginPath()
        L.forEach((r, n) => { const px = X(n / fps), py = base - r[x.i] / peak * (base - top); if (n) ctx.lineTo(px, py); else ctx.moveTo(px, py) })
        ctx.stroke()
      }
      ctx.globalAlpha = 1
      let lx = w - 8 // legend of the level lines, right-aligned
      for (const l of [...layers].reverse()) for (let k = l.gain.length - 1; k >= 0; k--) {
        if (!L.some(r => r[l.gain[k]] > 0)) continue
        const text = tr('scene.timeline.level', { cue: l.cue, side: k ? 'R' : 'L' }), tw = ctx.measureText(text).width
        lx -= tw; ctx.fillStyle = '#8b929b'; ctx.fillText(text, lx, top + 10)
        lx -= 16; ctx.fillStyle = l.colors[k]; ctx.fillRect(lx, top + 6, 12, 2); lx -= 12
      }
      // Cue markers per lane: the selected cue bright and framed, the clip's moment normal, the rest dimmed.
      const events = runtime.events()
      // `cue:variant` names resolve like the game (variant fields, else the cue's).
      const effective = (name: string) => { const r = table ? resolveEventName(table, name) : null; return r && table ? effectiveEvent(table, r.ref) : null }
      const lanes: [number, number, (name: string) => boolean, (name: string) => string][] = [
        [top, mid, name => { const e = effective(name); return !!e && (e.haptics.length > 0 || lib.loop_cues.includes(e.ref.cue)) }, name => familyColor(lib, name)],
        [mid + 1, base, name => !!effective(name)?.sfx, () => SOUND_COLOR],
      ]
      const found: Hit[] = []
      for (const [y0, y1, has, color] of lanes) {
        let labelX = -1e9
        for (const ev of events) {
          if (!has(ev.name)) continue
          const x = X(ev.t), picked = !!sel && sel.name === ev.name && sel.t != null && Math.abs(ev.t - sel.t) < 0.02
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
      ctx.fillStyle = '#5c636c'; ctx.fillText(tr('scene.lane.haptics'), 3, top + 24); ctx.fillText(tr('scene.lane.sound'), 3, mid + 24)
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

  const onMouseDown = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (!useSceneStore.getState().items.length) return
    const r = event.currentTarget.getBoundingClientRect(), x = event.clientX - r.left, y = event.clientY - r.top
    const hit = hits.current.filter(m => y >= m.y0 && y <= m.y1 && Math.abs(m.x - x) <= 5).sort((a, b) => Math.abs(a.x - x) - Math.abs(b.x - x))[0]
    if (hit) { useSceneStore.getState().selectCue(hit.name, hit.t); runtime.video.pause(); runtime.seek(hit.t - useSceneSettings.getState().leadSec); return }
    runtime.seek(x / r.width * (runtime.video.duration || 0))
  }

  return <div className="scene-timeline">
    <div className="scene-info">
      <span className="scene-info-title" ref={title} />
      <span className="scene-info-dim" ref={note} />
      <span className="scene-info-dim scene-info-levels" ref={levels} />
      <span className="scene-info-state" ref={state} />
      <SceneOutputToggles />
    </div>
    <canvas className="scene-timeline-canvas" ref={canvas} onMouseDown={onMouseDown} />
    <div className="scene-help">{t('scene.keys')}</div>
  </div>
}
