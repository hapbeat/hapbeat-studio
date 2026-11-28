import { useEffect, useMemo, useState } from 'react'
import { useI18n, type MessageId } from '@/i18n/I18nProvider'
import { useSceneStore } from '@/stores/sceneStore'
import type { SceneLayer } from '@/utils/sceneData'
import type { CueTable } from '@/utils/sceneCueTable'
import { setLevelMap, setRouteMap } from '@/utils/cueEvents'
import { loopSoundLevel } from '@/utils/sceneLoopSounds'
import { LEVEL_MAP_CURVES, LEVEL_MAP_MAX_POINTS, MAP_DEFAULTS, MAP_KEYS, MAP_KINDS, MAP_RANGES, mapOutput, withLevelCurve, withLevelIntercept, withOutputAt, withoutLevelPoint, withPointEdited, type LevelMap, type LevelMapCurve, type MapKind } from '@/utils/levelMap'
import { NumberField, useAtLabel } from './SceneCuePanels'
import { useScene } from './sceneContext'

type Edit = (change: (tb: CueTable) => CueTable | null) => boolean

/** How often the playhead level is read (ms). */
const LEVEL_POLL_MS = 100

/** The loop input at the playhead: the layer's recorded level (the louder hand), read every LEVEL_POLL_MS while mounted. */
function usePlayheadLevel(layer: SceneLayer): number {
  const { runtime } = useScene()
  const [level, setLevel] = useState(0)
  useEffect(() => {
    const read = () => {
      const s = useSceneStore.getState(), data = s.data
      const x = s.items[s.cur] && data ? loopSoundLevel(data.full.levels, data.fps, layer, runtime.video.currentTime).gain : 0
      setLevel(Math.round(x * 1000) / 1000)
    }
    read()
    const timer = setInterval(read, LEVEL_POLL_MS)
    return () => clearInterval(timer)
  }, [runtime, layer])
  return level
}

/**
 * Input → output of a loop cue (levelMap, DEC-090 revised): a function, not tied to time — playing / seeking only picks
 * the input the user feels now (the recorded level the game gives the loop). Shows the current input and the
 * recording's max, and per sound / route the function as the main graph (the current input moving along it),
 * 「今の入力 … のときの出力 [ ] [点を置く]」 (Enter / 「点を置く」 puts the point at the current input), then the intercept,
 * the segment shape and the points, compact. Without points the output is the input.
 *
 * The output (DEC-113): 強さ (levelMap, the sound and every route; shown first), or — for advanced use — 左右比 (panMap)
 * and ピッチ (rateMap, the playback rate) of each haptic route; the sound has neither. Without points, a route's pan /
 * rate is its fixed value (the Haptics section). The selector is always there, so switching moves nothing above it.
 */
export function LevelMaps({ table, layer, cue, edit }: { table: CueTable; layer: SceneLayer; cue: string; edit: Edit }) {
  const { t } = useI18n()
  const atLabel = useAtLabel()
  const data = useSceneStore(s => s.data)
  const level = usePlayheadLevel(layer)
  const [kind, setKind] = useState<MapKind>('level')
  // Once per recording, not on every playhead poll.
  const max = useMemo(() => data ? data.full.levels.reduce((m, row) => Math.max(m, row[layer.gain[0]], row[layer.gain[1]]), 0) : 0, [data, layer])
  const entry = table.cues[cue]
  const kindButton = (k: MapKind) => <button key={k} type="button" className={kind === k ? 'on' : ''} aria-pressed={kind === k}
    title={t(`scene.levelMap.kind.${k}.hint` as MessageId)} onClick={ev => { ev.currentTarget.blur(); setKind(k) }}>{t(`scene.levelMap.kind.${k}` as MessageId)}</button>
  return <div className="scene-sec scene-levelmap">
    <h3 title={`${t('scene.levelMap.hint')}\nlevelMap / panMap / rateMap`}>{t('scene.levelMap.heading')}</h3>
    <div className="scene-row">
      <span className="scene-dim">{t('scene.levelMap.kind')}</span>
      <span className="scene-seg scene-levelmap-kind" role="group" aria-label={t('scene.levelMap.kind')}>{MAP_KINDS.map(kindButton)}</span>
    </div>
    <div className="scene-row scene-levelmap-levels">
      <span>{t('scene.levelMap.now')} <b className="scene-levelmap-num">{level.toFixed(3)}</b></span>
      <span className="scene-dim">{t('scene.levelMap.max')} <b className="scene-levelmap-num">{max.toFixed(3)}</b></span>
    </div>
    <div className="scene-dim scene-levelmap-note scene-levelmap-kindnote">{t(kind === 'level' ? 'scene.levelMap.same' : `scene.levelMap.kind.${kind}.note` as MessageId)}</div>
    {kind === 'level' && entry?.sfx && <LevelMapEditor kind="level" label={t('scene.levelMap.sound')} map={entry.sfx.levelMap} level={level} max={max}
      onChange={m => edit(tb => setLevelMap(tb, cue, 'sfx', m))} />}
    {kind !== 'level' && !(entry?.haptics ?? []).length && <div className="scene-dim">{t('scene.levelMap.kind.noRoute')}</div>}
    {(entry?.haptics ?? []).map((r, i) => kind === 'level'
      ? <LevelMapEditor key={`level:${i}`} kind="level" label={atLabel(r.at)} map={r.levelMap} level={level} max={max}
        onChange={m => edit(tb => setLevelMap(tb, cue, i, m))} />
      : <LevelMapEditor key={`${kind}:${i}`} kind={kind} label={atLabel(r.at)} map={r[MAP_KEYS[kind]]} fixed={r[kind]} level={level} max={max}
        onChange={m => edit(tb => {
          // The first point of a route with a fixed value starts the line at that value (the map replaces it).
          const fixed = r[kind], start = m && !r[MAP_KEYS[kind]] && typeof fixed === 'number' && m.intercept === undefined ? withLevelIntercept(m, fixed, kind) : m
          return setRouteMap(tb, cue, i, kind, start)
        })} />)}
  </div>
}

const STEPS: Record<MapKind, number> = { level: 0.05, pan: 0.05, rate: 0.05 }
const clampKind = (kind: MapKind, x: number) => Math.max(MAP_RANGES[kind][0], Math.min(MAP_RANGES[kind][1], x))

/**
 * One sound's / route's map of `kind`: the graph, the output at the current input (edit + Enter or 「点を置く」 sets the
 * point), intercept, segment shape and points. `fixed`: a route's pan / rate used without points.
 */
function LevelMapEditor({ kind, label, map, fixed, level, max, onChange }: { kind: MapKind; label: string; map: LevelMap | undefined; fixed?: number; level: number; max: number; onChange: (map: LevelMap | undefined) => void }) {
  const { t } = useI18n()
  const now = Math.round(mapOutput(kind, map, level, fixed) * 100) / 100
  /** The output in the field (follows the current level until edited). */
  const [shown, setShown] = useState(now)
  useEffect(() => setShown(now), [now])
  const [lo, hi] = MAP_RANGES[kind]
  const full = !!map && map.points.length >= LEVEL_MAP_MAX_POINTS && !map.points.some(p => p[0] === level)
  const off = !(level > 0) || full
  const place = (output: number) => { const next = withOutputAt(map, level, output, kind); if (next) onChange(next) }
  const fixedNow = mapOutput(kind, undefined, 0, fixed)
  return <div className="scene-levelmap-item">
    <div className="scene-levelmap-label" title={label}>{label}</div>
    <LevelMapGraph kind={kind} map={map} fixed={fixed} level={level} max={max} />
    <div className="scene-row scene-levelmap-set" title={t(kind === 'level' ? 'scene.levelMap.output.hint' : 'scene.levelMap.output.hintFixed')}>
      <span>{t('scene.levelMap.here', { level: level.toFixed(3) })}</span>
      <NumberField value={now} min={lo} max={hi} step={STEPS[kind]} disabled={off} label={t('scene.levelMap.output')}
        onCommit={x => { const v = clampKind(kind, x); setShown(v); place(v) }} />
      <button type="button" className="scene-icon-btn" disabled={off} title={t('scene.levelMap.place.hint')}
        onClick={ev => { ev.currentTarget.blur(); place(shown) }}>{t('scene.levelMap.place')}</button>
    </div>
    <div className="scene-dim scene-levelmap-note">{full ? t('scene.levelMap.full', { max: LEVEL_MAP_MAX_POINTS }) : !(level > 0) ? t('scene.levelMap.noLevel') : ' '}</div>
    <div className="scene-row scene-levelmap-more">
      <label className="scene-row scene-levelmap-intercept" title={`${t('scene.levelMap.intercept.hint')}\nintercept`}><span className="scene-dim">{t('scene.levelMap.intercept')}</span>
        <NumberField value={map?.intercept ?? MAP_DEFAULTS[kind]} min={lo} max={hi} step={STEPS[kind]} disabled={!map} label={t('scene.levelMap.intercept')}
          onCommit={x => { if (map) onChange(withLevelIntercept(map, x, kind)) }} /></label>
      <label className="scene-row" title={`${t('scene.levelMap.curve.hint')}\ncurve`}><span className="scene-dim">{t('scene.levelMap.curve')}</span>
        <select value={map?.curve ?? 'linear'} disabled={!map} onChange={ev => { const c = ev.target.value as LevelMapCurve; ev.target.blur(); if (map) onChange(withLevelCurve(map, c)) }}>
          {LEVEL_MAP_CURVES.map(c => <option key={c} value={c}>{t(`scene.levelMap.curve.${c}` as MessageId)}</option>)}
        </select></label>
      {!map && <span className="scene-dim">{kind === 'level' ? t('scene.levelMap.none') : t('scene.levelMap.noneFixed', { value: fixedNow.toFixed(2) })}</span>}
    </div>
    {map && <LevelMapPoints kind={kind} map={map} onChange={onChange} />}
  </div>
}

/**
 * The points as small cards, each with its input and output editable in place (Enter / leaving the field commits; the
 * points are sorted by input again) and a delete button. An input of 0 or less, or one another point has, is refused
 * with a message in a fixed-height line (the field goes back to the point's value).
 */
function LevelMapPoints({ kind, map, onChange }: { kind: MapKind; map: LevelMap; onChange: (map: LevelMap | undefined) => void }) {
  const { t } = useI18n()
  const [error, setError] = useState<string | null>(null)
  /** Bumped on a refused edit, so the cards show the points' values again. */
  const [revision, setRevision] = useState(0)
  const commit = (index: number, input: number, output: number) => {
    const next = withPointEdited(map, index, input, output, kind)
    if (next === 'input') { setError(t('scene.levelMap.point.badInput')); setRevision(r => r + 1); return }
    if (next === 'duplicate') { setError(t('scene.levelMap.point.duplicate', { level: input.toFixed(3) })); setRevision(r => r + 1); return }
    setError(null)
    onChange(next)
  }
  return <div className="scene-levelmap-pointbox">
    <ul className="scene-levelmap-points">{map.points.map(([l, g], i) => <li key={`${l}:${revision}`} className="scene-levelmap-point">
      <span className="scene-dim">{t('scene.levelMap.input')}</span>
      <NumberField value={l} min={0} max={1000} step={0.01} label={t('scene.levelMap.input')} onCommit={x => commit(i, x, g)} />
      <span className="scene-dim">{t('scene.levelMap.output')}</span>
      <NumberField value={g} min={MAP_RANGES[kind][0]} max={MAP_RANGES[kind][1]} step={STEPS[kind]} label={t('scene.levelMap.output')} onCommit={x => commit(i, l, x)} />
      <button type="button" className="scene-icon-btn" title={t('scene.levelMap.remove', { level: l })} aria-label={t('scene.levelMap.remove', { level: l })}
        onClick={() => { setError(null); onChange(withoutLevelPoint(map, i)) }}>✕</button>
    </li>)}</ul>
    <div className="scene-levelmap-note scene-levelmap-error">{error ?? ' '}</div>
  </div>
}

const GW = 260, GH = 120, PL = 30, PR = 6, PT = 6, PB = 18
/**
 * The function as the main graph (fixed size): input 0 .. the recording's max (or the last point, if beyond) left to
 * right, output bottom to top (強さ: 0 .. the largest of 1 and the drawn line; 左右比: −1 (left) .. +1 (right) with the
 * centre line; ピッチ: 0 .. the largest of 2 and the line, with the line at 1); the line from (0, intercept) through the
 * points and its extension past the last one, the points (hover or click: their input and output) and the current
 * input as a line with a dot on the curve, following the playhead.
 */
function LevelMapGraph({ kind, map, fixed, level, max }: { kind: MapKind; map: LevelMap | undefined; fixed?: number; level: number; max: number }) {
  const { t } = useI18n()
  const [picked, setPicked] = useState<number | null>(null)
  const xMax = Math.max(max, map?.points[map.points.length - 1]?.[0] ?? 0) * 1.05 || 1
  // From (0, intercept) (a levelMap is 0 at input 0 itself: the loop is off), then the function sampled up to xMax.
  const at = (l: number) => mapOutput(kind, map, l, fixed)
  const samples = Array.from({ length: 97 }, (_, i) => { const l = i / 96 * xMax; return [l, i ? at(l) : kind !== 'level' ? at(0) : map ? map.intercept ?? 0 : 0] as const })
  const yMin = kind === 'pan' ? -1 : 0, yMax = kind === 'pan' ? 1 : Math.max(kind === 'rate' ? 2 : 1, ...samples.map(p => p[1]))
  const baseline = kind === 'pan' ? 0 : kind === 'rate' ? 1 : null
  const X = (l: number) => PL + l / xMax * (GW - PL - PR), Y = (g: number) => GH - PB - (g - yMin) / (yMax - yMin) * (GH - PT - PB)
  const line = samples.map(([l, g]) => `${X(l).toFixed(1)},${Y(g).toFixed(1)}`).join(' ')
  const pointText = (l: number, g: number) => t('scene.levelMap.point', { level: l.toFixed(3), output: g.toFixed(2) })
  const p = picked !== null ? map?.points[picked] : undefined
  return <div className="scene-levelmap-graphbox">
    <svg className="scene-curve scene-levelmap-graph" width={GW} height={GH} viewBox={`0 0 ${GW} ${GH}`}>
      <rect x={PL} y={PT} width={GW - PL - PR} height={GH - PT - PB} fill="none" stroke="currentColor" strokeOpacity={0.2} />
      <text x={PL - 3} y={PT + 8} textAnchor="end" fontSize={9} fill="currentColor" fillOpacity={0.6}>{yMax.toFixed(1)}</text>
      <text x={PL - 3} y={GH - PB} textAnchor="end" fontSize={9} fill="currentColor" fillOpacity={0.6}>{yMin.toFixed(kind === 'pan' ? 1 : 0)}</text>
      {baseline !== null && <line x1={PL} x2={GW - PR} y1={Y(baseline)} y2={Y(baseline)} stroke="currentColor" strokeOpacity={0.25} strokeDasharray="3 3" />}
      <text x={PL - 3} y={(PT + GH - PB) / 2 + 3} textAnchor="end" fontSize={9} fill="currentColor" fillOpacity={0.6}>{t('scene.levelMap.output')}</text>
      <text x={GW - PR} y={GH - 5} textAnchor="end" fontSize={9} fill="currentColor" fillOpacity={0.6}>{xMax.toFixed(2)}</text>
      <text x={(PL + GW - PR) / 2} y={GH - 5} textAnchor="middle" fontSize={9} fill="currentColor" fillOpacity={0.6}>{t('scene.levelMap.input')}</text>
      <polyline points={line} fill="none" stroke="currentColor" strokeWidth={1.5} />
      {level > 0 && <>
        <line x1={X(level)} x2={X(level)} y1={PT} y2={GH - PB} stroke="#fff" strokeOpacity={0.5} />
        <circle cx={X(level)} cy={Y(at(level))} r={4} fill="#fff" />
      </>}
      {map?.points.map(([l, g], i) => <circle key={l} cx={X(l)} cy={Y(g)} r={picked === i ? 5 : 3.5} fill="currentColor" className="scene-levelmap-dot"
        onClick={() => setPicked(picked === i ? null : i)}><title>{pointText(l, g)}</title></circle>)}
    </svg>
    <div className="scene-dim scene-levelmap-picked">{p ? pointText(p[0], p[1]) : ' '}</div>
  </div>
}
