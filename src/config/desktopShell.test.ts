import { describe, expect, it } from 'vitest'
import { isSimpleUi, visibleTabs } from './desktopShell'

const TABS = ['editor', 'scene', 'kit', 'display', 'devices'] as const

describe('desktop layout', () => {
  it('is simple only inside the desktop app and until "show all features" is chosen', () => {
    expect(isSimpleUi(true, false)).toBe(true)
    expect(isSimpleUi(true, true)).toBe(false)
    expect(isSimpleUi(false, false)).toBe(false)
  })

  it('keeps Kit, UI and Manage in their order', () => {
    expect(visibleTabs(TABS, true)).toEqual(['kit', 'devices'])
    expect(visibleTabs(TABS, false)).toEqual([...TABS])
  })
})
