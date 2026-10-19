import { describe, it, expect } from 'vitest'
import { pagePresets, duoStandardTemplate, bandStandardTemplate } from './templates'
import { getElementSize, type DisplayPage } from '@/types/display'
import { messages } from '@/i18n/messages'

/** 16×2 のグリッドに収まり、要素どうしが重ならないこと。 */
function expectFits(page: DisplayPage) {
  const used = new Set<string>()
  for (const el of page.elements) {
    const [w, h] = getElementSize(el.type, el.variant)
    const [x, y] = el.pos
    expect(x + w, `${page.name}/${el.id}`).toBeLessThanOrEqual(16)
    expect(y + h, `${page.name}/${el.id}`).toBeLessThanOrEqual(2)
    for (let dx = 0; dx < w; dx++) {
      for (let dy = 0; dy < h; dy++) {
        const cell = `${x + dx},${y + dy}`
        expect(used.has(cell), `${page.name}/${el.id} overlaps at ${cell}`).toBe(false)
        used.add(cell)
      }
    }
  }
}

describe('page presets (Band / Duo 共通)', () => {
  it('main（バンド）/ main（ネック）/ exhibit / debug の順', () => {
    expect(pagePresets.map((p) => p.name)).toEqual(['main_band', 'main_neck', 'exhibit', 'debug'])
  })
  it('main は両方ともページ名 main、表示名は i18n にある', () => {
    expect(pagePresets[0].page.name).toBe('main')
    expect(pagePresets[1].page.name).toBe('main')
    for (const p of pagePresets) expect(messages[p.labelKey]).toBeDefined()
  })
  it('main（バンド）は装着位置、main（ネック）は Var/Fix を出す', () => {
    const types = (i: number) => pagePresets[i].page.elements.map((e) => e.type)
    expect(types(0)).toContain('position')
    expect(types(0)).not.toContain('volume_mode')
    expect(types(1)).toContain('volume_mode')
    expect(types(1)).not.toContain('position')
  })
  it('全プリセットが 16×2 に重ならず収まる', () => {
    for (const p of pagePresets) expectFits(p.page)
  })
})

describe('出荷時レイアウト', () => {
  it('Band = main（バンド）+ exhibit', () => {
    const pages = bandStandardTemplate.layout.pages
    expect(pages.map((p) => p.name)).toEqual(['main', 'exhibit'])
    expect(pages[0].elements.map((e) => e.type)).toContain('position')
  })
  it('Duo = main（ネック）/ exhibit / debug', () => {
    const pages = duoStandardTemplate.layout.pages
    expect(pages.map((p) => p.name)).toEqual(['main', 'exhibit', 'debug'])
    expect(pages[0].elements.map((e) => e.type)).toContain('volume_mode')
  })
})
