/**
 * Loop cue input → output (DEC-090, revised 2026-10-09; docs/haptic-authoring-cue-table.md `levelMap`): a loop cue's
 * `sfx` and each of its haptics routes may map the input the game gives the loop (the recorded layer level: feed speed,
 * brushing strength, ... ≥ 0) to an output multiplier. The function runs through (0, `intercept`) and the points in
 * input order; each segment [(x0, y0), (x1, y1)] is y0 + (y1 − y0)·c((x − x0) / (x1 − x0)) with c the `curve` shape
 * (rampCurve's); beyond the last point the last segment's secant extends it linearly; the output is kept in 0..4, and
 * input 0 (the loop is not playing) is always 0. Absent = the output is the input itself.
 * Output = WAV × intensity × gain / volume × levelMap(input).
 */
import { curveAt, RAMP_CURVES, type RampCurve } from './rampCurve'

export const LEVEL_MAP_CURVES = RAMP_CURVES
export type LevelMapCurve = RampCurve
/** Points sorted by input (> 0, no input twice); `intercept` absent = 0 (through the origin); `curve` absent = linear. */
export interface LevelMap { points: [number, number][]; intercept?: number; curve?: LevelMapCurve; [key: string]: unknown }

export const LEVEL_MAP_GAIN_RANGE = [0, 4] as const
export const LEVEL_MAP_MAX_POINTS = 16
const LEVEL_MAP_KEYS = ['points', 'intercept', 'curve']

const clampOutput = (y: number) => Math.max(LEVEL_MAP_GAIN_RANGE[0], Math.min(LEVEL_MAP_GAIN_RANGE[1], y))

/**
 * The output at `input`: 0 at (or below) 0, the input itself without a map, else the segments from (0, intercept)
 * through the points (shaped by `curve`), the last segment's secant beyond the last point, kept in 0..4.
 */
export function mapLevel(map: LevelMap | null | undefined, input: number): number {
  if (!(input > 0)) return 0
  const p = map?.points
  if (!p || !p.length) return input
  const curve = map!.curve ?? 'linear', intercept = map!.intercept ?? 0
  let x0 = 0, y0 = intercept
  for (const [x1, y1] of p) {
    if (input <= x1) return clampOutput(y0 + (y1 - y0) * curveAt(curve, (input - x0) / (x1 - x0)))
    x0 = x1; y0 = y1
  }
  const [xa, ya] = p.length > 1 ? p[p.length - 2] : [0, intercept]
  return clampOutput(y0 + (y0 - ya) / (x0 - xa) * (input - x0))
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const inOutputRange = (x: number) => x >= LEVEL_MAP_GAIN_RANGE[0] && x <= LEVEL_MAP_GAIN_RANGE[1]

/** Whether `value` is a valid levelMap: 1–16 points [input > 0, output 0..4] with increasing inputs, intercept 0..4, curve one of LEVEL_MAP_CURVES. */
export function isLevelMap(value: unknown): value is LevelMap {
  if (!isRecord(value) || Object.keys(value).some(k => !LEVEL_MAP_KEYS.includes(k))) return false
  const points = value.points
  if (!Array.isArray(points) || points.length < 1 || points.length > LEVEL_MAP_MAX_POINTS) return false
  let last = 0
  for (const p of points) {
    if (!Array.isArray(p) || p.length !== 2 || !finite(p[0]) || !finite(p[1])) return false
    if (p[0] <= last || !inOutputRange(p[1])) return false
    last = p[0]
  }
  if (value.intercept !== undefined && !(finite(value.intercept) && inOutputRange(value.intercept))) return false
  return value.curve === undefined || (LEVEL_MAP_CURVES as readonly unknown[]).includes(value.curve)
}
const RANGE = `${LEVEL_MAP_GAIN_RANGE[0]}..${LEVEL_MAP_GAIN_RANGE[1]}`
export const LEVEL_MAP_RULE = `{points: [[input > 0, output ${RANGE}], ...] (1-${LEVEL_MAP_MAX_POINTS}, inputs increasing), intercept?: ${RANGE}, curve?: ${LEVEL_MAP_CURVES.join(' | ')}}`

const round3 = (x: number) => Math.round(x * 1000) / 1000

/**
 * `map` with the point (`input`, `output`) (rounded to 0.001; output clamped to 0..4): replaces the point at that input,
 * else is inserted in order. Throws when the input rounds to 0 or less, or there are already 16 points and none at that input.
 */
export function withLevelPoint(map: LevelMap | null | undefined, input: number, output: number): LevelMap {
  const l = round3(input), g = round3(clampOutput(Number.isFinite(output) ? output : 0))
  if (!(l > 0)) throw new Error('levelMap: a point needs an input > 0')
  const points = (map?.points ?? []).filter(p => p[0] !== l)
  if (points.length >= LEVEL_MAP_MAX_POINTS) throw new Error(`levelMap: up to ${LEVEL_MAP_MAX_POINTS} points`)
  points.push([l, g])
  points.sort((a, b) => a[0] - b[0])
  return { ...(map ?? {}), points }
}
/** `map` without point `index`; undefined (no map: the output is the input) when none is left. */
export function withoutLevelPoint(map: LevelMap, index: number): LevelMap | undefined {
  const points = map.points.filter((_, i) => i !== index)
  return points.length ? { ...map, points } : undefined
}
/** `map` with `curve` (linear = the key left out). */
export function withLevelCurve(map: LevelMap, curve: LevelMapCurve): LevelMap {
  const { curve: _curve, ...rest } = map
  return curve === 'linear' ? rest as LevelMap : { ...rest, points: map.points, curve }
}
/** `map` with `intercept`, the output near input 0 (rounded to 0.001, clamped to 0..4; 0 = the key left out). */
export function withLevelIntercept(map: LevelMap, intercept: number): LevelMap {
  const { intercept: _intercept, ...rest } = map
  const v = round3(clampOutput(Number.isFinite(intercept) ? intercept : 0))
  return v === 0 ? rest as LevelMap : { ...rest, points: map.points, intercept: v }
}

/**
 * "At this input, the output is `output`": `map` with that point placed (or replaced) at `input` (the playhead's
 * recorded level), so mapLevel(result, input) = output. Null when there is no input (rounds to ≤ 0) or the map is full
 * without a point there.
 */
export function withOutputAt(map: LevelMap | null | undefined, input: number, output: number): LevelMap | null {
  if (!(round3(input) > 0)) return null
  if (map && map.points.length >= LEVEL_MAP_MAX_POINTS && !map.points.some(p => p[0] === round3(input))) return null
  return withLevelPoint(map, input, output)
}
