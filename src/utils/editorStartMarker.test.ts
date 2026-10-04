import { describe, expect, it } from 'vitest'
import { playStart } from './editorStartMarker'

describe('editor start marker', () => {
  it('prefers the range, then the clicked start, then the head', () => {
    expect(playStart({ start: 1.5 }, 0.4)).toBe(1.5)
    expect(playStart(null, 0.4)).toBe(0.4)
    expect(playStart(null, null)).toBe(0)
  })
})
