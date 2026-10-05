import { MATERIAL_PEAK } from './sceneCueTable'

/**
 * DEC-086 levels: a material WAV is written at full scale (peak −0.5 dBFS); how strong it is lives in its
 * intensity (0..1). Final output = WAV × intensity × scene multiplier (route gain / sfx.volume) × device volume.
 */

/** Peak absolute sample of channel data. */
export function peakOf(channels: readonly Float32Array[]): number {
  let peak = 0
  for (const data of channels) for (let i = 0; i < data.length; i++) { const v = Math.abs(data[i]); if (v > peak) peak = v }
  return peak
}

/** The gain that brings `peak` to the material peak (1 for silence). */
export const normalizeGain = (peak: number) => peak > 0 ? MATERIAL_PEAK / peak : 1

/**
 * A new material from an AI candidate / clip: written normalized, its original size kept as the intensity —
 * the normalization correction (peak / MATERIAL_PEAK) × the strength the rating chose (`rated`, an AI candidate's
 * rating `intensity`; 1 otherwise), capped at 1.
 */
export const intensityForPeak = (peak: number, rated = 1) => Math.min(1, peak / MATERIAL_PEAK * rated)

/**
 * An adjusted material written back after its chain changed: the render (`peak`) is normalized again, and the
 * intensity follows so it sounds as loud as before. `previousGain`: the normalization gain of the last write
 * (1 for a file never normalized by Studio); `intensity`: the intensity now. Capped at 1 (then it gets quieter).
 */
export function renormalize(peak: number, previousGain: number, intensity: number): { gain: number; intensity: number } {
  const gain = normalizeGain(peak)
  return { gain, intensity: Math.min(1, previousGain * intensity / gain) }
}
