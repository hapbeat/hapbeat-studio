import type { SceneLayer, SceneLib } from './sceneData'
import { layerRuns } from './sceneEmit'
import { loopSoundLevel } from './sceneLoopSounds'
import { routeAlternates, routeClips, type CueTable } from './sceneCueTable'
import { mapLevel, type LevelMap } from './levelMap'

/**
 * A loop cue's material over its representative stretch, as the game plays it: one continuous loop while the cue's
 * layer is active (its recorded level > 0), the material tiled seamlessly, its gain (and rate, when the layer records
 * one) following the recorded level, silent when the level is back to 0. The recorded firings of a loop cue are only
 * the layer's starts, so the material is never placed per firing (DEC-085).
 * Times are playback seconds (0 s = the stretch's mark, the first firing).
 */
export interface LoopStretch {
  /** The layer's active runs in the stretch (a run that starts in it is kept to where the level returns to 0). */
  segments: { start: number; end: number }[]
  /** The recorded level (louder hand) per recorded frame over the stretch, for the drawn line. */
  envelope: { t: number; gain: number }[]
  /** How long the stretch plays: its end, or the end of the last run if later. */
  durationSec: number
  /** The recorded level at playback time `sec` (loopSoundLevel: the louder hand's gain and its rate). */
  level: (sec: number) => { gain: number; rate: number }
  /** The played material's level → multiplier (DEC-090; absent = the level), applied by renderLoopStretch. */
  levelMap?: LevelMap
}

/**
 * The loop stretch of layer `layer` from full replay time `mark` (playback 0 s) to `endSec` playback seconds; null
 * when the layer is not active there (the material is then shown once).
 */
export function loopStretch(levels: number[][], fps: number, layer: SceneLayer, mark: number, endSec: number): LoopStretch | null {
  const segments = layerRuns(levels, fps, layer)
    .filter(([start, end]) => end > mark && start - mark < endSec)
    .map(([start, end]) => ({ start: Math.max(0, start - mark), end: end - mark }))
  if (!segments.length) return null
  const durationSec = Math.max(endSec, segments[segments.length - 1].end)
  const envelope: { t: number; gain: number }[] = [{ t: 0, gain: loopSoundLevel(levels, fps, layer, mark).gain }]
  for (let i = Math.floor(mark * fps) + 1; i < levels.length && i / fps - mark <= durationSec; i++)
    envelope.push({ t: i / fps - mark, gain: Math.max(0, levels[i][layer.gain[0]], levels[i][layer.gain[1]]) })
  return { segments, envelope, durationSec, level: sec => loopSoundLevel(levels, fps, layer, mark + sec) }
}

/**
 * `channels` (one material at `rate` Hz) looped over `stretch`, `durationSec` long: within each segment the material
 * starts from its beginning and tiles phase-continuously, each sample × the recorded gain through the stretch's levelMap,
 * the phase advancing by the recorded rate (as the Scene tab's loop voices, renderChunk); silence outside the segments.
 */
export function renderLoopStretch(channels: readonly Float32Array[], rate: number, stretch: Pick<LoopStretch, 'segments' | 'level' | 'levelMap'>, durationSec: number): Float32Array[] {
  const length = Math.max(1, Math.round(durationSec * rate))
  const out = channels.map(() => new Float32Array(length))
  const n = channels[0]?.length ?? 0
  if (!n) return out
  for (const segment of stretch.segments) {
    let ph = 0
    for (let i = Math.round(segment.start * rate), end = Math.min(length, Math.round(segment.end * rate)); i < end; i++) {
      const { gain: level, rate: r } = stretch.level(i / rate), gain = mapLevel(stretch.levelMap, level)
      if (gain > 0) { const j = Math.floor(ph) % n; channels.forEach((data, c) => { out[c][i] = data[j] * gain }) }
      ph = (ph + r) % n
    }
  }
  return out
}

/**
 * The material position (seconds, 0..`materialSec`) a loop plays at playback time `sec`: the recorded rate integrated
 * from its segment's start (`step` s), wrapped; null outside the segments.
 */
export function loopPhaseAt(stretch: Pick<LoopStretch, 'segments' | 'level'>, materialSec: number, sec: number, step = 0.01): number | null {
  const segment = stretch.segments.find(p => sec >= p.start && sec < p.end)
  if (!segment || materialSec <= 0) return null
  let ph = 0
  for (let t = segment.start; t < sec; t += step) ph += stretch.level(t).rate * Math.min(step, sec - t)
  return ph % materialSec
}

/**
 * The levelMap a loop cue's material plays with (DEC-090): the sfx's for a sound; for a haptic the route that stars or
 * keeps `material` (the first route when none, e.g. an AI candidate). Undefined = the level itself.
 */
export function loopMaterialLevelMap(table: CueTable, cue: string, target: 'sound' | 'haptic', material: string | null): LevelMap | undefined {
  const entry = table.cues[cue]
  if (target === 'sound') return entry?.sfx?.levelMap
  const routes = entry?.haptics ?? []
  return (routes.find(r => material !== null && (routeClips(r).includes(material) || routeAlternates(r).includes(material))) ?? routes[0])?.levelMap
}

/** The active runs [start, end) of loop cue `name`'s layer (cue or cue:variant) over `levels` (the layer's max gain > 0); [] for other cues. */
export function loopCueRuns(levels: number[][], fps: number, lib: Pick<SceneLib, 'layers' | 'loop_cues'>, name: string): [number, number][] {
  const cue = name.split(':')[0], layer = lib.loop_cues.includes(cue) ? lib.layers.find(l => l.cue === cue) : undefined
  return layer ? layerRuns(levels, fps, layer) : []
}
