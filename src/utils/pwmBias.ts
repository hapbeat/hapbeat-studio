export const PWM_BIAS_MAX_PCT = 45

export interface PwmBiasPair {
  idle: number
  play: number
}

export function clampPwmBiasPct(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(-PWM_BIAS_MAX_PCT, Math.min(PWM_BIAS_MAX_PCT, Math.round(value)))
}

/** Parse a completed integer percent draft without coercing blank / sign-only
 * text to zero. Number inputs cannot preserve those ordinary edit states. */
export function parsePwmBiasPctText(text: string): number | null {
  const trimmed = text.trim()
  if (!/^[+-]?\d+$/.test(trimmed)) return null
  const value = Number(trimmed)
  if (!Number.isFinite(value) || value < -PWM_BIAS_MAX_PCT || value > PWM_BIAS_MAX_PCT) return null
  return Math.round(value)
}

/**
 * Keep standing and playback tension in the same motor direction.
 * The profile the user just edited owns the direction; the other profile
 * keeps its magnitude and is flipped only when its non-zero sign conflicts.
 * Zero is neutral and therefore compatible with either direction.
 */
export function alignPwmBiasSigns(
  changed: 'idle' | 'play',
  idleValue: number,
  playValue: number,
): PwmBiasPair {
  let idle = clampPwmBiasPct(idleValue)
  let play = clampPwmBiasPct(playValue)
  const directionSource = changed === 'idle' ? idle : play
  const other = changed === 'idle' ? play : idle

  if (directionSource !== 0 && other !== 0 && Math.sign(directionSource) !== Math.sign(other)) {
    if (changed === 'idle') play = Math.sign(idle) * Math.abs(play)
    else idle = Math.sign(play) * Math.abs(idle)
  }

  return { idle, play }
}
