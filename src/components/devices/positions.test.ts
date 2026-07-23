import { describe, it, expect } from 'vitest'
import { parseAddress, buildAddress, positionLabel } from './positions'

describe('positionLabel', () => {
  it('pos_ プレフィックスを除く', () => {
    expect(positionLabel('pos_l_wrist')).toBe('l_wrist')
    expect(positionLabel('pos_neck')).toBe('neck')
  })
  it('pos_ で始まらなければそのまま', () => {
    expect(positionLabel('foo')).toBe('foo')
  })
})

describe('parseAddress', () => {
  it('空文字は既定値 (group は既定 1)', () => {
    expect(parseAddress('')).toEqual({ prefix: '', player: 1, position: 'pos_chest', group: 1 })
  })
  it('prefix 無し / group suffix 無し → group は既定 1', () => {
    expect(parseAddress('player_5/pos_neck')).toEqual({
      prefix: '', player: 5, position: 'pos_neck', group: 1,
    })
  })
  it('prefix が "/" を含む + group_<N> 末尾', () => {
    expect(parseAddress('red/alpha/player_3/pos_chest/group_7')).toEqual({
      prefix: 'red/alpha', player: 3, position: 'pos_chest', group: 7,
    })
  })
  it('group は 1..99 のみ有効 (範囲外は既定 1 にフォールバック)', () => {
    // group_100 は無効 → pop されず position 扱いになる (実挙動)、group は既定 1
    const r = parseAddress('player_2/pos_hip/group_100')
    expect(r.group).toBe(1)
  })
})

describe('buildAddress', () => {
  it('prefix 無し / group 省略 → 既定 1 を常に付与', () => {
    expect(buildAddress('', 1, 'pos_chest')).toBe('player_1/pos_chest/group_1')
  })
  it('prefix + group 付き', () => {
    expect(buildAddress('red/alpha', 3, 'pos_neck', 7)).toBe('red/alpha/player_3/pos_neck/group_7')
  })
  it('group が 1..99 外なら 1..99 にクランプして常に suffix を付ける', () => {
    expect(buildAddress('x', 2, 'pos_hip', 0)).toBe('x/player_2/pos_hip/group_1')
    expect(buildAddress('x', 2, 'pos_hip', 100)).toBe('x/player_2/pos_hip/group_99')
  })
  it('group が NaN なら既定 1 にフォールバック', () => {
    expect(buildAddress('', 1, 'pos_chest', NaN)).toBe('player_1/pos_chest/group_1')
  })
  it('group が負値なら 1 にクランプ', () => {
    expect(buildAddress('', 1, 'pos_chest', -5)).toBe('player_1/pos_chest/group_1')
  })
  it('group が小数なら round してからクランプ (4.6 → 5)', () => {
    expect(buildAddress('', 1, 'pos_chest', 4.6)).toBe('player_1/pos_chest/group_5')
  })
  it('group が 99 超なら 99 にクランプ (100 → 99)', () => {
    expect(buildAddress('', 1, 'pos_chest', 100)).toBe('player_1/pos_chest/group_99')
  })
})

describe('parse ↔ build round-trip', () => {
  it('build した address を parse すると元に戻る', () => {
    const cases = [
      { prefix: '', player: 1, position: 'pos_chest', group: 1 },
      { prefix: 'red', player: 5, position: 'pos_neck', group: 9 },
      { prefix: 'red/alpha', player: 12, position: 'pos_l_wrist', group: 1 },
    ]
    for (const c of cases) {
      expect(parseAddress(buildAddress(c.prefix, c.player, c.position, c.group))).toEqual(c)
    }
  })
})
