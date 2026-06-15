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
  it('空文字は既定値', () => {
    expect(parseAddress('')).toEqual({ prefix: '', player: 1, position: 'pos_chest', group: -1 })
  })
  it('prefix 無し', () => {
    expect(parseAddress('player_5/pos_neck')).toEqual({
      prefix: '', player: 5, position: 'pos_neck', group: -1,
    })
  })
  it('prefix が "/" を含む + group_<N> 末尾', () => {
    expect(parseAddress('red/alpha/player_3/pos_chest/group_7')).toEqual({
      prefix: 'red/alpha', player: 3, position: 'pos_chest', group: 7,
    })
  })
  it('group は 1..99 のみ有効 (範囲外は未指定として残す)', () => {
    // group_100 は無効 → pop されず position 扱いになる (実挙動)
    const r = parseAddress('player_2/pos_hip/group_100')
    expect(r.group).toBe(-1)
  })
})

describe('buildAddress', () => {
  it('prefix 無し / group 未指定', () => {
    expect(buildAddress('', 1, 'pos_chest', -1)).toBe('player_1/pos_chest')
  })
  it('prefix + group 付き', () => {
    expect(buildAddress('red/alpha', 3, 'pos_neck', 7)).toBe('red/alpha/player_3/pos_neck/group_7')
  })
  it('group が 1..99 外なら suffix を付けない', () => {
    expect(buildAddress('x', 2, 'pos_hip', 0)).toBe('x/player_2/pos_hip')
    expect(buildAddress('x', 2, 'pos_hip', 100)).toBe('x/player_2/pos_hip')
  })
})

describe('parse ↔ build round-trip', () => {
  it('build した address を parse すると元に戻る', () => {
    const cases = [
      { prefix: '', player: 1, position: 'pos_chest', group: -1 },
      { prefix: 'red', player: 5, position: 'pos_neck', group: 9 },
      { prefix: 'red/alpha', player: 12, position: 'pos_l_wrist', group: 1 },
    ]
    for (const c of cases) {
      expect(parseAddress(buildAddress(c.prefix, c.player, c.position, c.group))).toEqual(c)
    }
  })
})
