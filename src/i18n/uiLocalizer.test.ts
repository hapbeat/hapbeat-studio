import { describe, expect, it } from 'vitest'
import { translateJapanese } from './uiLocalizer'

describe('translateJapanese', () => {
  it('translates shared UI labels exactly', () => {
    expect(translateJapanese('保存')).toBe('Save')
    expect(translateJapanese('Helper 接続中')).toBe('Helper connected')
  })

  it('leaves English and IDs unchanged', () => {
    expect(translateJapanese('Save Folder')).toBe('Save Folder')
    expect(translateJapanese('player_1')).toBe('player_1')
  })

  it('translates a dynamic update notice without changing its version', () => {
    expect(translateJapanese('Studio v0.7.0 が公開されています')).toBe('Studio v0.7.0 is available')
  })
})
