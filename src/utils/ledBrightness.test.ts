import { describe, it, expect } from 'vitest'
import {
  BRIGHTNESS_TABLE,
  BRIGHTNESS_STEPS,
  rawToStep,
  stepToRaw,
} from './ledBrightness'

describe('BRIGHTNESS_TABLE (gamma 1.8 + min 2)', () => {
  it('既知の段階値', () => {
    expect(BRIGHTNESS_TABLE).toEqual([0, 2, 5, 17, 35, 59, 89, 123, 162, 206, 255])
  })
  it('単調増加', () => {
    for (let i = 1; i < BRIGHTNESS_TABLE.length; i++) {
      expect(BRIGHTNESS_TABLE[i]).toBeGreaterThan(BRIGHTNESS_TABLE[i - 1])
    }
  })
})

describe('stepToRaw', () => {
  it('端と中間', () => {
    expect(stepToRaw(0)).toBe(0)
    expect(stepToRaw(BRIGHTNESS_STEPS)).toBe(255)
    expect(stepToRaw(5)).toBe(59)
  })
  it('範囲外は clamp', () => {
    expect(stepToRaw(-1)).toBe(0)
    expect(stepToRaw(999)).toBe(255)
  })
})

describe('rawToStep', () => {
  it('最近傍の step を返す', () => {
    expect(rawToStep(0)).toBe(0)
    expect(rawToStep(255)).toBe(10)
    expect(rawToStep(59)).toBe(5)
    expect(rawToStep(58)).toBe(5) // 最近傍
  })
  it('round-trip: rawToStep(stepToRaw(s)) === s', () => {
    for (let s = 0; s <= BRIGHTNESS_STEPS; s++) {
      expect(rawToStep(stepToRaw(s))).toBe(s)
    }
  })
})
