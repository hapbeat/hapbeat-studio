import { describe, expect, it } from 'vitest'
import type { DeviceCaps } from './deviceCaps'
import { findKitCompatProblems, KIT_CLIP_FORMAT, KIT_SCHEMA_VERSION } from './kitCompat'

const target = (ipAddress: string, name?: string) => ({ ipAddress, name })
const infoOf = (map: Record<string, { caps?: DeviceCaps }>) => (ip: string) => map[ip]

describe('findKitCompatProblems', () => {
  it('今の Kit は schema 2 の pcm16', () => {
    expect(KIT_SCHEMA_VERSION).toBe('2.0.0')
    expect(KIT_CLIP_FORMAT).toBe('pcm16')
  })

  it('kit_schema の範囲内・pcm16 ありは問題なし', () => {
    const r = findKitCompatProblems([target('10.0.0.2')], infoOf({ '10.0.0.2': { caps: { kit_schema: { min: 2, max: 2 }, kit_clip_formats: ['pcm16'] } } }))
    expect(r).toEqual({ problems: [], unchecked: [] })
  })

  it('schema の major が範囲の外なら書き込まない', () => {
    const r = findKitCompatProblems([target('10.0.0.2', 'Band A')], infoOf({ '10.0.0.2': { caps: { kit_schema: { min: 3, max: 4 }, kit_clip_formats: ['pcm16'] } } }))
    expect(r.problems).toEqual([{ kind: 'schema', device: 'Band A', major: 2, min: 3, max: 4 }])
    const below = findKitCompatProblems([target('10.0.0.2')], infoOf({ '10.0.0.2': { caps: { kit_schema: { min: 1, max: 1 } } } }))
    expect(below.problems).toEqual([{ kind: 'schema', device: '10.0.0.2', major: 2, min: 1, max: 1 }])
  })

  it('kit_clip_formats に pcm16 が無ければ書き込まない', () => {
    const r = findKitCompatProblems([target('10.0.0.2')], infoOf({ '10.0.0.2': { caps: { kit_schema: { min: 2, max: 2 }, kit_clip_formats: ['opus'] } } }))
    expect(r.problems).toEqual([{ kind: 'clipFormat', device: '10.0.0.2', format: 'pcm16' }])
  })

  it('caps の無い機体 (0.x) は照合しない', () => {
    expect(findKitCompatProblems([target('10.0.0.2')], infoOf({ '10.0.0.2': {} }))).toEqual({ problems: [], unchecked: [] })
  })

  it('get_info が未取得の機体は照合せず unchecked に挙げる', () => {
    expect(findKitCompatProblems([target('10.0.0.2', 'Band A')], infoOf({}))).toEqual({ problems: [], unchecked: ['Band A'] })
  })

  it('1 台でも合わなければその機体だけが挙がる', () => {
    const r = findKitCompatProblems(
      [target('10.0.0.2', 'A'), target('10.0.0.3', 'B')],
      infoOf({ '10.0.0.2': { caps: { kit_schema: { min: 2, max: 2 } } }, '10.0.0.3': { caps: { kit_schema: { min: 3, max: 3 } } } }),
    )
    expect(r.problems.map((p) => p.device)).toEqual(['B'])
  })
})
