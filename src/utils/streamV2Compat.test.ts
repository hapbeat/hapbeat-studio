import { describe, it, expect } from 'vitest'
import { isStreamV2Firmware, needsStreamV2Warning, streamV2MinimumLines } from './streamV2Compat'

describe('isStreamV2Firmware', () => {
  it('0.5.0 以上は v2', () => {
    expect(isStreamV2Firmware('0.5.0')).toBe(true)
    expect(isStreamV2Firmware('v0.5.0')).toBe(true)
    expect(isStreamV2Firmware('0.5.1')).toBe(true)
    expect(isStreamV2Firmware('0.10.0')).toBe(true)
    expect(isStreamV2Firmware('1.0.0')).toBe(true)
  })
  it('開発版・pre-release は core version で判定する', () => {
    expect(isStreamV2Firmware('0.5.0d7')).toBe(true)
    expect(isStreamV2Firmware('0.5.0-d7')).toBe(true)
    expect(isStreamV2Firmware('0.5.0-rc1')).toBe(true)
    expect(isStreamV2Firmware('0.4.1d4')).toBe(false)
    expect(isStreamV2Firmware('0.4.2-d3')).toBe(false)
  })
  it('0.5.0 未満・不明・解釈不能は v2 ではない', () => {
    expect(isStreamV2Firmware('0.4.1')).toBe(false)
    expect(isStreamV2Firmware('0.4.99')).toBe(false)
    expect(isStreamV2Firmware(undefined)).toBe(false)
    expect(isStreamV2Firmware(null)).toBe(false)
    expect(isStreamV2Firmware('')).toBe(false)
    expect(isStreamV2Firmware('unknown')).toBe(false)
  })
})

describe('needsStreamV2Warning', () => {
  it('v2 イメージを旧ファーム / 不明の機器へ書く時だけ警告する', () => {
    expect(needsStreamV2Warning('0.5.0', ['0.4.1'])).toBe(true)
    expect(needsStreamV2Warning('0.5.0d7', [undefined])).toBe(true)
    expect(needsStreamV2Warning('0.5.0', ['0.5.0d2', '0.4.1'])).toBe(true)
  })
  it('全台が v2 済みなら警告しない', () => {
    expect(needsStreamV2Warning('0.5.1', ['0.5.0', '0.5.0d7'])).toBe(false)
  })
  it('書き込むイメージが v2 でない・版不明なら警告しない', () => {
    expect(needsStreamV2Warning('0.4.1', ['0.4.0'])).toBe(false)
    expect(needsStreamV2Warning(null, ['0.4.0'])).toBe(false)
  })
})

describe('streamV2MinimumLines', () => {
  it('SDK ごとに 1 行の箇条書きを返す', () => {
    const lines = streamV2MinimumLines().split('\n')
    expect(lines).toHaveLength(5)
    expect(lines[0]).toBe('・Unity SDK ≥ 0.6.0')
    expect(lines.every((l) => l.startsWith('・'))).toBe(true)
  })
})
