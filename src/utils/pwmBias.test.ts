import { describe, expect, it } from 'vitest'
import { alignPwmBiasSigns, clampPwmBiasPct, parsePwmBiasPctText } from './pwmBias'

describe('PWM bias sign constraint', () => {
  it('flips playback bias to the standing-bias direction', () => {
    expect(alignPwmBiasSigns('idle', 5, -20)).toEqual({ idle: 5, play: 20 })
    expect(alignPwmBiasSigns('idle', -5, 20)).toEqual({ idle: -5, play: -20 })
  })

  it('flips standing bias when playback bias is the edited profile', () => {
    expect(alignPwmBiasSigns('play', 5, -20)).toEqual({ idle: -5, play: -20 })
    expect(alignPwmBiasSigns('play', -5, 20)).toEqual({ idle: 5, play: 20 })
  })

  it('treats zero as neutral', () => {
    expect(alignPwmBiasSigns('idle', 0, -20)).toEqual({ idle: 0, play: -20 })
    expect(alignPwmBiasSigns('play', 5, 0)).toEqual({ idle: 5, play: 0 })
  })

  it('clamps both profiles to the supported percentage range', () => {
    expect(alignPwmBiasSigns('idle', 90, -80)).toEqual({ idle: 45, play: 45 })
    expect(clampPwmBiasPct(Number.NaN)).toBe(0)
  })

  it('preserves ordinary incomplete text edits instead of coercing them to zero', () => {
    expect(parsePwmBiasPctText('')).toBeNull()
    expect(parsePwmBiasPctText('-')).toBeNull()
    expect(parsePwmBiasPctText('-20')).toBe(-20)
    expect(parsePwmBiasPctText('+5')).toBe(5)
    expect(parsePwmBiasPctText('46')).toBeNull()
  })
})
