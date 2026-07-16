import { describe, it, expect } from 'vitest'
import { clampOpusComplexity, clampHpBufferMs } from './solidTransmitterTuning'

describe('clampOpusComplexity', () => {
  it('範囲内はそのまま（四捨五入）', () => {
    expect(clampOpusComplexity(0)).toBe(0)
    expect(clampOpusComplexity(10)).toBe(10)
    expect(clampOpusComplexity(5.4)).toBe(5)
    expect(clampOpusComplexity(5.5)).toBe(6)
  })
  it('範囲外は clamp', () => {
    expect(clampOpusComplexity(-5)).toBe(0)
    expect(clampOpusComplexity(-1)).toBe(0)
    expect(clampOpusComplexity(99)).toBe(10)
  })
  it('非数値は 0 にフォールバック', () => {
    expect(clampOpusComplexity(NaN)).toBe(0)
    expect(clampOpusComplexity(Infinity)).toBe(0)
  })
})

describe('clampHpBufferMs', () => {
  it('範囲内はそのまま（四捨五入）', () => {
    expect(clampHpBufferMs(40)).toBe(40)
    expect(clampHpBufferMs(500)).toBe(500)
    expect(clampHpBufferMs(120)).toBe(120)
    expect(clampHpBufferMs(119.6)).toBe(120)
  })
  it('範囲外は clamp', () => {
    expect(clampHpBufferMs(0)).toBe(40)
    expect(clampHpBufferMs(39)).toBe(40)
    expect(clampHpBufferMs(5000)).toBe(500)
  })
  it('非数値は既定 120ms にフォールバック', () => {
    expect(clampHpBufferMs(NaN)).toBe(120)
    expect(clampHpBufferMs(Infinity)).toBe(120)
  })
})
