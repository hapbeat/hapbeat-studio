import { describe, expect, it } from 'vitest'
import { checkHelperCompat, helperHasFeature, helperHasType, helperNewerThanStudio, parseHelperHello } from './helperCompat'

const v1 = parseHelperHello({
  version: '1.0.0',
  generation: 1,
  types: ['get_info', 'stream_begin', 'reset_storage', 42],
  features: ['stream_gen2', 'stream_lost', 'device_caps', 'future_thing'],
  unknown_field: true,
})
const v0 = parseHelperHello({ version: '0.5.0' })

describe('helper_hello (helper-ws.md)', () => {
  it('1.x: 申告された type・feature だけを使う', () => {
    expect(v1).toEqual({
      generation: 1,
      types: ['get_info', 'stream_begin', 'reset_storage'],
      features: ['stream_gen2', 'stream_lost', 'device_caps', 'future_thing'],
    })
    expect(helperHasType(v1, 'reset_storage')).toBe(true)
    expect(helperHasType(v1, 'kit_list')).toBe(false)
    expect(helperHasFeature(v1, 'device_caps')).toBe(true)
    expect(helperHasFeature(v1, 'stream_takeover')).toBe(false)
  })

  it('types の無い 0.x は helper 0.5.0 の機能だけ', () => {
    expect(v0).toEqual({ generation: null, types: null, features: [] })
    expect(helperHasType(v0, 'get_info')).toBe(true)
    expect(helperHasType(v0, 'reset_storage')).toBe(false)
    expect(helperHasFeature(v0, 'stream_gen2')).toBe(true)
    expect(helperHasFeature(v0, 'device_caps')).toBe(false)
  })

  it('helper_hello の前は何も使えない', () => {
    expect(helperHasType(null, 'get_info')).toBe(false)
    expect(helperHasFeature(null, 'stream_gen2')).toBe(false)
  })

  it('版の比較は types の無い helper の接続の可否だけ', () => {
    expect(checkHelperCompat('0.4.2', parseHelperHello({ version: '0.4.2' }))).toBe('outdated')
    expect(checkHelperCompat('0.5.0', v0)).toBe('ok')
    expect(checkHelperCompat('0.0.1', v1)).toBe('ok')
    expect(checkHelperCompat(null)).toBe('unknown')
  })

  it('helper の major が Studio より大きいときだけ更新を促す', () => {
    expect(helperNewerThanStudio(v1, '0.8.1')).toBe(true)
    expect(helperNewerThanStudio(v1, '1.0.0-d1')).toBe(false)
    expect(helperNewerThanStudio(v0, '0.8.1')).toBe(false)
    expect(helperNewerThanStudio(null, '0.8.1')).toBe(false)
  })
})
