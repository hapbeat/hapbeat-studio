import type { SceneLayer } from './sceneData'
import { layerRuns } from './sceneEmit'
import { loopSoundLevel } from './sceneLoopSounds'

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
 * starts from its beginning and tiles phase-continuously, each sample × the recorded gain, the phase advancing by the
 * recorded rate (as the Scene tab's loop voices, renderChunk); silence outside the segments.
 */
export function renderLoopStretch(channels: readonly Float32Array[], rate: number, stretch: Pick<LoopStretch, 'segments' | 'level'>, durationSec: number): Float32Array[] {
  const length = Math.max(1, Math.round(durationSec * rate))
  const out = channels.map(() => new Float32Array(length))
  const n = channels[0]?.length ?? 0
  if (!n) return out
  for (const segment of stretch.segments) {
    let ph = 0
    for (let i = Math.round(segment.start * rate), end = Math.min(length, Math.round(segment.end * rate)); i < end; i++) {
      const { gain, rate: r } = stretch.level(i / rate)
      if (gain > 0) { const j = Math.floor(ph) % n; channels.forEach((data, c) => { out[c][i] = data[j] * gain }) }
      ph = (ph + r) % n
    }
  }
  return out
}
