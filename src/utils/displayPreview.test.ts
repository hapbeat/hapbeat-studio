import { describe, it, expect } from 'vitest'
import {
  charCells,
  textCells,
  padClipToCells,
  getElementPreviewText,
} from './displayPreview'

describe('charCells', () => {
  it('ASCII は 1 セル', () => {
    expect(charCells('a')).toBe(1)
    expect(charCells('1')).toBe(1)
    expect(charCells(' ')).toBe(1)
    expect(charCells(':')).toBe(1)
  })
  it('全角 (日本語) は 2 セル', () => {
    expect(charCells('あ')).toBe(2)
    expect(charCells('制')).toBe(2)
    expect(charCells('全')).toBe(2)
    expect(charCells('ア')).toBe(2)
  })
  it('全角記号も 2 セル', () => {
    expect(charCells('％')).toBe(2) // U+FF05 fullwidth
  })
})

describe('textCells', () => {
  it('ASCII は文字数 = セル数', () => {
    expect(textCells('abc')).toBe(3)
    expect(textCells('P:01')).toBe(4)
  })
  it('全角は文字あたり 2 セル', () => {
    expect(textCells('制限')).toBe(4)
    expect(textCells('全て再生')).toBe(8)
  })
  it('混在', () => {
    expect(textCells('a制')).toBe(3) // 1 + 2
  })
})

describe('padClipToCells', () => {
  it('セル基準で末尾 pad する', () => {
    expect(padClipToCells('全て再生', 10)).toBe('全て再生  ') // 8 cells + 2 spaces
    expect(textCells(padClipToCells('全て再生', 10))).toBe(10)
    expect(padClipToCells('abc', 5)).toBe('abc  ')
  })
  it('セル基準で clip する (全角は跨がない)', () => {
    expect(padClipToCells('全て再生', 6)).toBe('全て再') // 3 JA = 6 cells
    // 全角がセル境界を跨ぐ場合はその文字を入れず手前で切り、空きを pad
    expect(padClipToCells('全角', 3)).toBe('全 ') // 全(2) + 余り1セルは space
    expect(textCells(padClipToCells('全角', 3))).toBe(3)
  })
  it('ちょうどぴったりは pad しない', () => {
    expect(padClipToCells('制限', 4)).toBe('制限')
  })
})

describe('getElementPreviewText — セル幅 = 要素幅 の不変条件', () => {
  it('alert_limit_mode は standard=10 / compact=4 セル', () => {
    expect(textCells(getElementPreviewText('alert_limit_mode'))).toBe(10)
    expect(textCells(getElementPreviewText('alert_limit_mode', undefined, 'compact'))).toBe(4)
  })
  it('custom_text は全角を含んでも要素幅 (8 セル) に収まる', () => {
    const t = getElementPreviewText('custom_text', undefined, undefined, '警報')
    expect(textCells(t)).toBe(8)
    expect(t.startsWith('警報')).toBe(true)
  })
  it('ASCII 要素は従来どおり (文字数 = セル数)', () => {
    expect(getElementPreviewText('player_number')).toBe('P:00')
    expect(getElementPreviewText('group_id')).toBe('Gr:00')
  })
})
