/**
 * Loop cue level → multiplier (DEC-090, docs/haptic-authoring-cue-table.md `levelMap`): a loop cue's `sfx` and each of
 * its haptics routes may map the recorded layer level (feed speed, brushing strength, ... ≥ 0) to a multiplier through
 * points `[level, gain]`, interpolated between them (`linear`, or `smooth` = smoothstep between two points), the end
 * value beyond the range, and always 0 at level 0. Absent = the multiplier is the level itself (the behaviour before).
 * Output = WAV × intensity × gain / volume × levelMap(level).
 */

export const LEVEL_MAP_CURVES = ['linear', 'smooth'] as const
export type LevelMapCurve = typeof LEVEL_MAP_CURVES[number]
/** Points sorted by level (no level twice); `curve` absent = linear. */
export interface LevelMap { points: [number, number][]; curve?: LevelMapCurve; [key: string]: unknown }

export const LEVEL_MAP_GAIN_RANGE = [0, 4] as const
export const LEVEL_MAP_MAX_POINTS = 16
const LEVEL_MAP_KEYS = ['points', 'curve']

/** The multiplier at recorded `level`: 0 at (or below) 0, the level itself without a map, else the points interpolated. */
export function mapLevel(map: LevelMap | null | undefined, level: number): number {
  if (!(level > 0)) return 0
  const p = map?.points
  if (!p || !p.length) return level
  if (level <= p[0][0]) return p[0][1]
  for (let i = 1; i < p.length; i++) {
    if (level > p[i][0]) continue
    const [l0, g0] = p[i - 1], [l1, g1] = p[i]
    let f = (level - l0) / (l1 - l0)
    if (map!.curve === 'smooth') f = f * f * (3 - 2 * f)
    return g0 + (g1 - g0) * f
  }
  return p[p.length - 1][1]
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/** Whether `value` is a valid levelMap: 1–16 points [level ≥ 0, gain 0..4] with increasing levels, curve linear / smooth. */
export function isLevelMap(value: unknown): value is LevelMap {
  if (!isRecord(value) || Object.keys(value).some(k => !LEVEL_MAP_KEYS.includes(k))) return false
  const points = value.points
  if (!Array.isArray(points) || points.length < 1 || points.length > LEVEL_MAP_MAX_POINTS) return false
  let last = -Infinity
  for (const p of points) {
    if (!Array.isArray(p) || p.length !== 2 || !finite(p[0]) || !finite(p[1])) return false
    if (p[0] < 0 || p[0] <= last || p[1] < LEVEL_MAP_GAIN_RANGE[0] || p[1] > LEVEL_MAP_GAIN_RANGE[1]) return false
    last = p[0]
  }
  return value.curve === undefined || (LEVEL_MAP_CURVES as readonly unknown[]).includes(value.curve)
}
export const LEVEL_MAP_RULE = `{points: [[level >= 0, gain ${LEVEL_MAP_GAIN_RANGE[0]}..${LEVEL_MAP_GAIN_RANGE[1]}], ...] (1-${LEVEL_MAP_MAX_POINTS}, levels increasing), curve?: ${LEVEL_MAP_CURVES.join(' | ')}}`

const round3 = (x: number) => Math.round(x * 1000) / 1000

/**
 * `map` with the point (`level`, `gain`) (rounded to 0.001; gain clamped to 0..4): replaces the point at that level,
 * else is inserted in order. Throws when there are already 16 points and none at that level.
 */
export function withLevelPoint(map: LevelMap | null | undefined, level: number, gain: number): LevelMap {
  const l = round3(Math.max(0, level)), g = round3(Math.max(LEVEL_MAP_GAIN_RANGE[0], Math.min(LEVEL_MAP_GAIN_RANGE[1], Number.isFinite(gain) ? gain : 0)))
  const points = (map?.points ?? []).filter(p => p[0] !== l)
  if (points.length >= LEVEL_MAP_MAX_POINTS) throw new Error(`levelMap: up to ${LEVEL_MAP_MAX_POINTS} points`)
  points.push([l, g])
  points.sort((a, b) => a[0] - b[0])
  return { ...(map ?? {}), points }
}
/** `map` without point `index`; undefined (no map: the multiplier is the level) when none is left. */
export function withoutLevelPoint(map: LevelMap, index: number): LevelMap | undefined {
  const points = map.points.filter((_, i) => i !== index)
  return points.length ? { ...map, points } : undefined
}
/** `map` with `curve` (linear = the key left out). */
export function withLevelCurve(map: LevelMap, curve: LevelMapCurve): LevelMap {
  const { curve: _curve, ...rest } = map
  return curve === 'linear' ? rest as LevelMap : { ...rest, points: map.points, curve }
}

/**
 * "At this level, the output is `output`": `map` with that point placed (or replaced) at recorded `level` (the playhead's
 * level), so mapLevel(result, level) = output. Null when there is no level (≤ 0) or the map is full without a point there.
 */
export function withOutputAt(map: LevelMap | null | undefined, level: number, output: number): LevelMap | null {
  if (!(level > 0)) return null
  if (map && map.points.length >= LEVEL_MAP_MAX_POINTS && !map.points.some(p => p[0] === round3(level))) return null
  return withLevelPoint(map, level, output)
}
