import { describe, expect, it } from 'vitest'
import { parseCapsFields, parseDeviceCaps } from './deviceCaps'

describe('parseDeviceCaps (serial-config.md §4.1)', () => {
  it('知っている項目だけを型どおりに残す', () => {
    expect(parseDeviceCaps({
      caps_version: 1, generation: 1, stream_gens: [2, 'x'], kit_schema: { min: 2, max: 2, extra: 1 },
      kit_clip_formats: ['pcm16'], features: ['play_pan'], future_field: 'ignored',
    })).toMatchObject({
      caps_version: 1, generation: 1, stream_gens: [2], kit_schema: { min: 2, max: 2 },
      kit_clip_formats: ['pcm16'], features: ['play_pan'],
    })
    expect(parseDeviceCaps({ future_field: 1 })).not.toHaveProperty('future_field')
  })
  it('caps でないものは undefined', () => {
    expect(parseDeviceCaps(undefined)).toBeUndefined()
    expect(parseDeviceCaps([1])).toBeUndefined()
    expect(parseDeviceCaps('x')).toBeUndefined()
  })
})

describe('parseCapsFields', () => {
  it('storage_incompatible は定義済みの領域だけ、無ければ [] (初期化後に古い一覧を残さない)', () => {
    expect(parseCapsFields({ storage_incompatible: ['audio_partition', 'unknown_area'] }).storage_incompatible).toEqual(['audio_partition'])
    expect(parseCapsFields({}).storage_incompatible).toEqual([])
  })
  it('stream_protocol・stream_formats', () => {
    expect(parseCapsFields({ stream_protocol: 2, stream_formats: ['pcm16', 'opus'] })).toMatchObject({ stream_protocol: 2, stream_formats: ['pcm16', 'opus'] })
  })
})
