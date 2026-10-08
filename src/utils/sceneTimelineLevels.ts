import type { SceneLayer } from './sceneData'
import type { CueTable } from './sceneCueTable'
import { mapLevel, type LevelMap } from './levelMap'

/**
 * The Scene timeline's level curves, each inside its own lane (sound upper, haptics lower): a layer's recorded level
 * from 0 at the lane bottom to its scale top (the recording's max, at least 1), and for the selected loop cue the
 * output its levelMap makes of that level (DEC-090) on the same scale.
 */
export type Lane = 'sound' | 'haptics'

/** The lanes a layer's curves are drawn in: haptics when its loop cue has haptics routes, sound when it has a sound (haptics when neither). */
export function layerLanes(table: CueTable | null, cue: string): Lane[] {
  const entry = table?.cues[cue], lanes: Lane[] = []
  if (entry?.sfx) lanes.push('sound')
  if (entry?.haptics?.length || !lanes.length) lanes.push('haptics')
  return lanes
}

/** A layer's scale top: the recording's max level of either hand, at least 1. */
export function layerScaleMax(levels: number[][], layer: SceneLayer): number {
  let max = 1
  for (const row of levels) max = Math.max(max, row[layer.gain[0]], row[layer.gain[1]])
  return max
}

/** y of `value` in a lane from `bottom` (0) to `top` (`max`), clamped to the lane. */
export function laneY(value: number, max: number, top: number, bottom: number): number {
  return bottom - Math.max(0, Math.min(1, value / max)) * (bottom - top)
}

/** One output curve of a loop cue: its lane, the hand it follows (-1 = the louder), its levelMap. */
export interface OutputCurve { lane: Lane; side: number; map: LevelMap | undefined }

/**
 * The output curves of loop cue `cue`: its sound's (sound lane, the louder hand, as the loop sound plays) and each
 * haptics route's (haptics lane; one per hand for a `hand` route, else the louder hand, as the loop voices play).
 * Routes with the same levelMap and hands are drawn once.
 */
export function outputCurves(table: CueTable | null, cue: string): OutputCurve[] {
  const entry = table?.cues[cue], out: OutputCurve[] = [], seen = new Set<string>()
  const add = (c: OutputCurve) => { const key = `${c.lane}:${c.side}:${JSON.stringify(c.map ?? null)}`; if (!seen.has(key)) { seen.add(key); out.push(c) } }
  if (entry?.sfx) add({ lane: 'sound', side: -1, map: entry.sfx.levelMap })
  for (const r of entry?.haptics ?? []) {
    if (r.at === 'hand') { add({ lane: 'haptics', side: 0, map: r.levelMap }); add({ lane: 'haptics', side: 1, map: r.levelMap }) }
    else add({ lane: 'haptics', side: -1, map: r.levelMap })
  }
  return out
}

/** The recorded level of `layer` in `row` for hand `side` (-1 = the louder). */
export const sideLevel = (row: number[], layer: SceneLayer, side: number) => side >= 0 ? row[layer.gain[side]] : Math.max(row[layer.gain[0]], row[layer.gain[1]])

/** The output (levelMap applied) of `curve` per frame of `levels`. */
export function outputValues(levels: number[][], layer: SceneLayer, curve: OutputCurve): number[] {
  return levels.map(row => mapLevel(curve.map, sideLevel(row, layer, curve.side)))
}

/** The selected loop cue's scale top: its layer's (layerScaleMax) or the largest output of its curves over the recording. */
export function outputScaleMax(levels: number[][], layer: SceneLayer, curves: OutputCurve[]): number {
  let max = layerScaleMax(levels, layer)
  for (const c of curves) for (const x of outputValues(levels, layer, c)) max = Math.max(max, x)
  return max
}

