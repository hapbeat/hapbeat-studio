import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeAll, describe, expect, it } from 'vitest'
import { I18nProvider } from '@/i18n/I18nProvider'
import { HapticIcon, KindIcon, SoundIcon } from './KindIcon'

// The node test window stub has no location; I18nProvider reads the locale from it.
beforeAll(() => { (globalThis as { location?: unknown }).location ??= { pathname: '/' } })

const render = (icon: ReactElement) => renderToStaticMarkup(createElement(I18nProvider, null, icon))
const SLASH = 'd="M2 2l12 12"'

describe('KindIcon slashed (no sound / no haptics)', () => {
  it('draws the diagonal slash only when slashed', () => {
    for (const Icon of [SoundIcon, HapticIcon]) {
      const plain = render(createElement(Icon, { size: 14 })), slashed = render(createElement(Icon, { size: 14, slashed: true }))
      expect(plain).not.toContain(SLASH)
      expect(plain).not.toContain('slashed')
      expect(slashed).toContain(SLASH)
      expect(slashed).toContain('kind-icon')
      expect(slashed).toContain('slashed')
    }
  })

  it('KindIcon passes slashed through and keeps the label', () => {
    const html = render(createElement(KindIcon, { kind: 'haptic', slashed: true }))
    expect(html).toContain('kind-icon haptic slashed')
    expect(html).toContain('aria-label="触覚"')
  })
})
