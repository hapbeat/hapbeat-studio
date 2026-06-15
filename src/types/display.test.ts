import { describe, it, expect } from 'vitest'
import { getElementSize } from './display'

describe('getElementSize — 要素のセル幅 (全角は 2 セル換算済み)', () => {
  it('alert_limit_mode: standard=10 / compact=4 (全角を 2 セルで数えた値)', () => {
    expect(getElementSize('alert_limit_mode')).toEqual([10, 1])
    expect(getElementSize('alert_limit_mode', 'compact')).toEqual([4, 1])
  })
  it('battery: percent=4 / bar=8', () => {
    expect(getElementSize('battery')).toEqual([4, 1])
    expect(getElementSize('battery', 'bar')).toEqual([8, 1])
  })
  it('テキスト系 3 サイズ (compact/standard/wide)', () => {
    expect(getElementSize('device_name', 'compact')).toEqual([4, 1])
    expect(getElementSize('device_name')).toEqual([8, 1])
    expect(getElementSize('device_name', 'wide')).toEqual([16, 1])
  })
  it('固定幅要素', () => {
    expect(getElementSize('player_number')).toEqual([4, 1])
    expect(getElementSize('group_id')).toEqual([5, 1])
    expect(getElementSize('page_indicator')).toEqual([3, 1])
    expect(getElementSize('wifi_status')).toEqual([5, 1])
  })
  it('mqtt_status は [OK]/[NG] 固定 4 セル', () => {
    expect(getElementSize('mqtt_status')).toEqual([4, 1])
  })
  it('ip_address は右切り出しの 3 サイズ', () => {
    expect(getElementSize('ip_address', 'compact')).toEqual([4, 1])
    expect(getElementSize('ip_address')).toEqual([6, 1])
    expect(getElementSize('ip_address', 'wide')).toEqual([13, 1])
  })
})
