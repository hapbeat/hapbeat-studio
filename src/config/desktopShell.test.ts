import { describe, expect, it } from 'vitest'
import { isSimpleUi, visibleSubTabs, visibleTabs } from './desktopShell'

const TABS = ['editor', 'scene', 'kit', 'display', 'devices'] as const

describe('desktop layout', () => {
  it('is simple only inside the desktop app and until "show all features" is chosen', () => {
    expect(isSimpleUi(true, false)).toBe(true)
    expect(isSimpleUi(true, true)).toBe(false)
    expect(isSimpleUi(false, false)).toBe(false)
  })

  it('keeps Kit, UI and Manage in their order', () => {
    expect(visibleTabs(TABS, true)).toEqual(['kit', 'display', 'devices'])
    expect(visibleTabs(TABS, false)).toEqual([...TABS])
  })

  it('keeps the playback test and drops the bench-only PWM sub-tab of Manage', () => {
    expect(visibleSubTabs(['wifi', 'config', 'kit', 'test', 'firmware', 'pwm'], true))
      .toEqual(['wifi', 'config', 'kit', 'test', 'firmware'])
    expect(visibleSubTabs(['espnow', 'audio', 'eq', 'dsp', 'firmware'], true))
      .toEqual(['espnow', 'audio', 'eq', 'dsp', 'firmware'])
    expect(visibleSubTabs(['wifi', 'test'], false)).toEqual(['wifi', 'test'])
  })
})
