import { useEffect, useMemo, useState } from 'react'
import { useI18n, type MessageId } from '@/i18n/I18nProvider'
import { useSceneStore } from '@/stores/sceneStore'
import { offsetOf, type SceneLayer } from '@/utils/sceneData'
import type { CueTable } from '@/utils/sceneCueTable'
import { setLevelMap } from '@/utils/cueEvents'
import { loopSoundLevel } from '@/utils/sceneLoopSounds'
import { LEVEL_MAP_CURVES, LEVEL_MAP_GAIN_RANGE, LEVEL_MAP_MAX_POINTS, mapLevel, withLevelCurve, withLevelPoint, withoutLevelPoint, type LevelMap, type LevelMapCurve } from '@/utils/levelMap'
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
 * Level → multiplier of a loop cue (levelMap, DEC-090): the recorded level at the playhead and the recording's max, and
 * per sound / route the points (set one at the current level with 「このレベルで倍率を決める」), the interpolation and a
 * small graph. Without points the multiplier is the level itself.
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
    {entry?.sfx && <LevelMapEditor label={t('scene.levelMap.sound')} map={entry.sfx.levelMap} level={level} max={max}
      onChange={m => edit(tb => setLevelMap(tb, cue, 'sfx', m))} />}
    {(entry?.haptics ?? []).map((r, i) => <LevelMapEditor key={i} label={atLabel(r.at)} map={r.levelMap} level={level} max={max}
      onChange={m => edit(tb => setLevelMap(tb, cue, i, m))} />)}
  </div>
}

/** One sound's / route's levelMap: the multiplier now, a gain field + 「このレベルで倍率を決める」, the graph, interpolation and points. */
function LevelMapEditor({ label, map, level, max, onChange }: { label: string; map: LevelMap | undefined; level: number; max: number; onChange: (map: LevelMap | undefined) => void }) {
  const { t } = useI18n()
  const [draft, setDraft] = useState<number | null>(null)
  const now = mapLevel(map, level)
  const full = !!map && map.points.length >= LEVEL_MAP_MAX_POINTS && !map.points.some(p => p[0] === level)
  const set = () => { onChange(withLevelPoint(map, level, draft ?? now)); setDraft(null) }
  return <div className="scene-levelmap-item">
    <div className="scene-row">
      <span className="scene-levelmap-label" title={label}>{label}</span>
      <span className="scene-dim scene-levelmap-num" title={t('scene.levelMap.nowGain.hint')}>×{now.toFixed(2)}</span>
      <NumberField value={draft ?? Math.round(now * 100) / 100} min={LEVEL_MAP_GAIN_RANGE[0]} max={LEVEL_MAP_GAIN_RANGE[1]} step={0.05} label={t('scene.levelMap.gain')}
        onCommit={x => setDraft(Math.max(LEVEL_MAP_GAIN_RANGE[0], Math.min(LEVEL_MAP_GAIN_RANGE[1], x)))} />
      <button type="button" className="scene-icon-btn" disabled={!(level > 0) || full} title={t(full ? 'scene.levelMap.full' : 'scene.levelMap.set.hint', { max: LEVEL_MAP_MAX_POINTS })}
        onClick={ev => { ev.currentTarget.blur(); set() }}>{t('scene.levelMap.set')}</button>
    </div>
    <div className="scene-levelmap-body">
      <LevelMapGraph map={map} level={level} max={max} />
      <div className="scene-levelmap-side">
        <label className="scene-row" title={`${t('scene.levelMap.curve.hint')}\ncurve`}><span className="scene-dim">{t('scene.levelMap.curve')}</span>
          <select value={map?.curve ?? 'linear'} disabled={!map} onChange={ev => { const c = ev.target.value as LevelMapCurve; ev.target.blur(); if (map) onChange(withLevelCurve(map, c)) }}>
            {LEVEL_MAP_CURVES.map(c => <option key={c} value={c}>{t(`scene.levelMap.curve.${c}` as MessageId)}</option>)}
          </select></label>
        {!map ? <div className="scene-dim">{t('scene.levelMap.none')}</div>
          : <ul className="scene-levelmap-points">{map.points.map(([l, g], i) => <li key={l}>
            <span className="scene-levelmap-num">{l.toFixed(3)} → ×{g.toFixed(2)}</span>
            <button type="button" className="scene-icon-btn" title={t('scene.levelMap.remove', { level: l })} aria-label={t('scene.levelMap.remove', { level: l })}
              onClick={() => onChange(withoutLevelPoint(map, i))}>✕</button>
          </li>)}</ul>}
      </div>
    </div>
  </div>
}

const GW = 160, GH = 64, PAD = 4
/**
 * The map as a small graph (fixed size): level 0 .. the recording's max (or the last point, if beyond) left to right,
 * multiplier bottom to top (0 .. the largest of 1 and the points); the points as dots, the playhead level as a line.
 */
function LevelMapGraph({ map, level, max }: { map: LevelMap | undefined; level: number; max: number }) {
  const xMax = Math.max(max, map?.points[map.points.length - 1]?.[0] ?? 0, level) * 1.05 || 1
  const yMax = Math.max(1, ...(map ? map.points.map(p => p[1]) : [xMax]))
  const X = (l: number) => (PAD + l / xMax * (GW - 2 * PAD)).toFixed(1), Y = (g: number) => (GH - PAD - g / yMax * (GH - 2 * PAD)).toFixed(1)
  const line = Array.from({ length: 49 }, (_, i) => { const l = i / 48 * xMax; return `${X(l)},${Y(mapLevel(map, l))}` }).join(' ')
  return <svg className="scene-curve scene-levelmap-graph" width={GW} height={GH} viewBox={`0 0 ${GW} ${GH}`} aria-hidden="true">
    <rect x={PAD} y={PAD} width={GW - 2 * PAD} height={GH - 2 * PAD} fill="none" stroke="currentColor" strokeOpacity={0.2} />
    <polyline points={line} fill="none" stroke="currentColor" strokeWidth={1.5} />
    {map?.points.map(([l, g]) => <circle key={l} cx={X(l)} cy={Y(g)} r={2.5} fill="currentColor" />)}
    {level > 0 && <line x1={X(level)} x2={X(level)} y1={PAD} y2={GH - PAD} stroke="#fff" strokeOpacity={0.7} />}
  </svg>
}
