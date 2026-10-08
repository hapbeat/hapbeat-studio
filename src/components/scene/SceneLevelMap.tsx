import { useEffect, useMemo, useState } from 'react'
import { useI18n, type MessageId } from '@/i18n/I18nProvider'
import { useSceneStore } from '@/stores/sceneStore'
import { offsetOf, type SceneLayer } from '@/utils/sceneData'
import type { CueTable } from '@/utils/sceneCueTable'
import { setLevelMap } from '@/utils/cueEvents'
import { loopSoundLevel } from '@/utils/sceneLoopSounds'
import { LEVEL_MAP_CURVES, LEVEL_MAP_GAIN_RANGE, LEVEL_MAP_MAX_POINTS, mapLevel, withLevelCurve, withOutputAt, withoutLevelPoint, type LevelMap, type LevelMapCurve } from '@/utils/levelMap'
import { NumberField, useAtLabel } from './SceneCuePanels'
import { useScene } from './sceneContext'

type Edit = (change: (tb: CueTable) => CueTable | null) => boolean

/** How often the playhead level is read (ms). */
const LEVEL_POLL_MS = 100

/** The layer's recorded level (the louder hand) at the playhead, read every LEVEL_POLL_MS while mounted. */
function usePlayheadLevel(layer: SceneLayer): number {
  const { runtime } = useScene()
  const [level, setLevel] = useState(0)
  useEffect(() => {
    const read = () => {
      const s = useSceneStore.getState(), it = s.items[s.cur], data = s.data
      const x = it && data ? loopSoundLevel(data.full.levels, data.fps, layer, runtime.video.currentTime + offsetOf(it)).gain : 0
      setLevel(Math.round(x * 1000) / 1000)
    }
    read()
    const timer = setInterval(read, LEVEL_POLL_MS)
    return () => clearInterval(timer)
  }, [runtime, layer])
  return level
}

/**
 * Level → output of a loop cue (levelMap, DEC-090): a mapping, not tied to time — playing / seeking only picks the
 * level the user feels now. Shows the current level and the recording's max, and per sound / route the mapping as the
 * main graph (the current level moving along it), 「今の強さ … のときの出力 [ ]」 (Enter / 「点を置く」 puts the point at
 * the current level), then the interpolation and the points, compact. Without points the output is the level.
 */
export function LevelMaps({ table, layer, cue, edit }: { table: CueTable; layer: SceneLayer; cue: string; edit: Edit }) {
  const { t } = useI18n()
  const atLabel = useAtLabel()
  const data = useSceneStore(s => s.data)
  const level = usePlayheadLevel(layer)
  // Once per recording, not on every playhead poll.
  const max = useMemo(() => data ? data.full.levels.reduce((m, row) => Math.max(m, row[layer.gain[0]], row[layer.gain[1]]), 0) : 0, [data, layer])
  const entry = table.cues[cue]
  return <div className="scene-sec scene-levelmap">
    <h3 title={`${t('scene.levelMap.hint')}\nlevelMap`}>{t('scene.levelMap.heading')}</h3>
    <div className="scene-row scene-levelmap-levels">
      <span>{t('scene.levelMap.now')} <b className="scene-levelmap-num">{level.toFixed(3)}</b></span>
      <span className="scene-dim">{t('scene.levelMap.max')} <b className="scene-levelmap-num">{max.toFixed(3)}</b></span>
    </div>
    <div className="scene-dim scene-levelmap-note">{t('scene.levelMap.same')}</div>
    {entry?.sfx && <LevelMapEditor label={t('scene.levelMap.sound')} map={entry.sfx.levelMap} level={level} max={max}
      onChange={m => edit(tb => setLevelMap(tb, cue, 'sfx', m))} />}
    {(entry?.haptics ?? []).map((r, i) => <LevelMapEditor key={i} label={atLabel(r.at)} map={r.levelMap} level={level} max={max}
      onChange={m => edit(tb => setLevelMap(tb, cue, i, m))} />)}
  </div>
}

/** One sound's / route's levelMap: the graph, the output at the current level (edit + Enter or 「点を置く」 sets the point), interpolation and points. */
function LevelMapEditor({ label, map, level, max, onChange }: { label: string; map: LevelMap | undefined; level: number; max: number; onChange: (map: LevelMap | undefined) => void }) {
  const { t } = useI18n()
  const now = Math.round(mapLevel(map, level) * 100) / 100
  /** The output in the field (follows the current level until edited). */
  const [shown, setShown] = useState(now)
  useEffect(() => setShown(now), [now])
  const full = !!map && map.points.length >= LEVEL_MAP_MAX_POINTS && !map.points.some(p => p[0] === level)
  const off = !(level > 0) || full
  const place = (output: number) => { const next = withOutputAt(map, level, output); if (next) onChange(next) }
  return <div className="scene-levelmap-item">
    <div className="scene-levelmap-label" title={label}>{label}</div>
    <LevelMapGraph map={map} level={level} max={max} />
    <div className="scene-row scene-levelmap-set" title={t('scene.levelMap.output.hint')}>
      <span>{t('scene.levelMap.here', { level: level.toFixed(3) })}</span>
      <NumberField value={now} min={LEVEL_MAP_GAIN_RANGE[0]} max={LEVEL_MAP_GAIN_RANGE[1]} step={0.05} disabled={off} label={t('scene.levelMap.output')}
        onCommit={x => { const v = Math.max(LEVEL_MAP_GAIN_RANGE[0], Math.min(LEVEL_MAP_GAIN_RANGE[1], x)); setShown(v); place(v) }} />
      <button type="button" className="scene-icon-btn" disabled={off} title={t('scene.levelMap.place.hint')}
        onClick={ev => { ev.currentTarget.blur(); place(shown) }}>{t('scene.levelMap.place')}</button>
    </div>
    <div className="scene-dim scene-levelmap-note">{full ? t('scene.levelMap.full', { max: LEVEL_MAP_MAX_POINTS }) : !(level > 0) ? t('scene.levelMap.noLevel') : ' '}</div>
    <div className="scene-row scene-levelmap-more">
      <label className="scene-row" title={`${t('scene.levelMap.curve.hint')}\ncurve`}><span className="scene-dim">{t('scene.levelMap.curve')}</span>
        <select value={map?.curve ?? 'linear'} disabled={!map} onChange={ev => { const c = ev.target.value as LevelMapCurve; ev.target.blur(); if (map) onChange(withLevelCurve(map, c)) }}>
          {LEVEL_MAP_CURVES.map(c => <option key={c} value={c}>{t(`scene.levelMap.curve.${c}` as MessageId)}</option>)}
        </select></label>
      {!map ? <span className="scene-dim">{t('scene.levelMap.none')}</span>
        : <ul className="scene-levelmap-points">{map.points.map(([l, g], i) => <li key={l}>
          <span className="scene-levelmap-num">{l.toFixed(3)} → {g.toFixed(2)}</span>
          <button type="button" className="scene-icon-btn" title={t('scene.levelMap.remove', { level: l })} aria-label={t('scene.levelMap.remove', { level: l })}
            onClick={() => onChange(withoutLevelPoint(map, i))}>✕</button>
        </li>)}</ul>}
    </div>
  </div>
}

const GW = 260, GH = 120, PL = 30, PR = 6, PT = 6, PB = 18
/**
 * The mapping as the main graph (fixed size): level 0 .. the recording's max (or the last point, if beyond) left to
 * right, output bottom to top (0 .. the largest of 1 and the points); the curve, the points (hover or click: their
 * level and output) and the current level as a line with a dot on the curve, following the playhead.
 */
function LevelMapGraph({ map, level, max }: { map: LevelMap | undefined; level: number; max: number }) {
  const { t } = useI18n()
  const [picked, setPicked] = useState<number | null>(null)
  const xMax = Math.max(max, map?.points[map.points.length - 1]?.[0] ?? 0, level) * 1.05 || 1
  const yMax = Math.max(1, ...(map ? map.points.map(p => p[1]) : [xMax]))
  const X = (l: number) => PL + l / xMax * (GW - PL - PR), Y = (g: number) => GH - PB - g / yMax * (GH - PT - PB)
  const line = Array.from({ length: 97 }, (_, i) => { const l = i / 96 * xMax; return `${X(l).toFixed(1)},${Y(mapLevel(map, l)).toFixed(1)}` }).join(' ')
  const pointText = (l: number, g: number) => t('scene.levelMap.point', { level: l.toFixed(3), output: g.toFixed(2) })
  const p = picked !== null ? map?.points[picked] : undefined
  return <div className="scene-levelmap-graphbox">
    <svg className="scene-curve scene-levelmap-graph" width={GW} height={GH} viewBox={`0 0 ${GW} ${GH}`}>
      <rect x={PL} y={PT} width={GW - PL - PR} height={GH - PT - PB} fill="none" stroke="currentColor" strokeOpacity={0.2} />
      <text x={PL - 3} y={PT + 8} textAnchor="end" fontSize={9} fill="currentColor" fillOpacity={0.6}>{yMax.toFixed(1)}</text>
      <text x={PL - 3} y={GH - PB} textAnchor="end" fontSize={9} fill="currentColor" fillOpacity={0.6}>0</text>
      <text x={PL - 3} y={(PT + GH - PB) / 2 + 3} textAnchor="end" fontSize={9} fill="currentColor" fillOpacity={0.6}>{t('scene.levelMap.output')}</text>
      <text x={GW - PR} y={GH - 5} textAnchor="end" fontSize={9} fill="currentColor" fillOpacity={0.6}>{xMax.toFixed(2)}</text>
      <text x={(PL + GW - PR) / 2} y={GH - 5} textAnchor="middle" fontSize={9} fill="currentColor" fillOpacity={0.6}>{t('scene.levelMap.level')}</text>
      <polyline points={line} fill="none" stroke="currentColor" strokeWidth={1.5} />
      {level > 0 && <>
        <line x1={X(level)} x2={X(level)} y1={PT} y2={GH - PB} stroke="#fff" strokeOpacity={0.5} />
        <circle cx={X(level)} cy={Y(mapLevel(map, level))} r={4} fill="#fff" />
      </>}
      {map?.points.map(([l, g], i) => <circle key={l} cx={X(l)} cy={Y(g)} r={picked === i ? 5 : 3.5} fill="currentColor" className="scene-levelmap-dot"
        onClick={() => setPicked(picked === i ? null : i)}><title>{pointText(l, g)}</title></circle>)}
    </svg>
    <div className="scene-dim scene-levelmap-picked">{p ? pointText(p[0], p[1]) : ' '}</div>
  </div>
}
