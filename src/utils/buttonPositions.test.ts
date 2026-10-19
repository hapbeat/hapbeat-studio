import { describe, expect, it } from 'vitest'
import { positionIdAt } from './buttonPositions'

describe('positionIdAt', () => {
  it('keeps the spec ids in the normal orientation', () => {
    for (const id of ['btn_l', 'btn_c', 'btn_r']) expect(positionIdAt('band_wl', id, false)).toBe(id)
    for (const id of ['btn_1', 'btn_2', 'btn_3', 'btn_4', 'btn_5']) expect(positionIdAt('duo_wl', id, false)).toBe(id)
  })

  it('swaps Band left and right when flipped, centre stays', () => {
    expect(positionIdAt('band_wl', 'btn_l', true)).toBe('btn_r')
    expect(positionIdAt('band_wl', 'btn_r', true)).toBe('btn_l')
    expect(positionIdAt('band_wl', 'btn_c', true)).toBe('btn_c')
  })

  it('swaps the Duo column ends when flipped, middle stays', () => {
    expect(positionIdAt('duo_wl', 'btn_1', true)).toBe('btn_3')
    expect(positionIdAt('duo_wl', 'btn_3', true)).toBe('btn_1')
    expect(positionIdAt('duo_wl', 'btn_4', true)).toBe('btn_5')
    expect(positionIdAt('duo_wl', 'btn_5', true)).toBe('btn_4')
    expect(positionIdAt('duo_wl', 'btn_2', true)).toBe('btn_2')
  })
})
