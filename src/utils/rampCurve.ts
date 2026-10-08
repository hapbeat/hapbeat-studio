/**
 * The curve shapes shared by a variant's ramp (`rampCurve`), distance falloff (`distanceFalloff.curve`) and a loop cue's
 * levelMap segments (`levelMap.curve`, DEC-090).
 */
export const RAMP_CURVES = ['linear', 'easeIn', 'easeOut', 'easeInOut', 'sigmoid'] as const
export type RampCurve = typeof RAMP_CURVES[number]

const SIGMOID_K = 6
/** The ramp shapes on t ∈ [0, 1] → [0, 1]: easeIn t², easeOut 1−(1−t)², easeInOut smoothstep, sigmoid a steep tanh S. */
export function curveAt(curve: RampCurve, t: number): number {
  const x = Math.max(0, Math.min(1, t))
  switch (curve) {
    case 'easeIn': return x * x
    case 'easeOut': return 1 - (1 - x) * (1 - x)
    case 'easeInOut': return x * x * (3 - 2 * x)
    case 'sigmoid': return 0.5 + 0.5 * Math.tanh(SIGMOID_K * (x - 0.5)) / Math.tanh(SIGMOID_K / 2)
    default: return x
  }
}
