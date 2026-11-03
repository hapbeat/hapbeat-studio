import { describe, expect, it } from 'vitest'
import { isNewerBuild } from './useStudioUpdate'

describe('Studio update notice', () => {
  it('offers a reload only for a different, real build', () => {
    expect(isNewerBuild('abc1234', 'def5678')).toBe(true)
    expect(isNewerBuild('abc1234', 'abc1234')).toBe(false)
    expect(isNewerBuild('abc1234', 'unknown')).toBe(false)
    expect(isNewerBuild('abc1234', '')).toBe(false)
    expect(isNewerBuild('abc1234', undefined)).toBe(false)
    expect(isNewerBuild('unknown', 'def5678')).toBe(false)
    expect(isNewerBuild(undefined, 'def5678')).toBe(false)
  })
})
