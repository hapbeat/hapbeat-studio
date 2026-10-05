import { describe, expect, it, vi } from 'vitest'
import { showDockPanel } from './dockPanels'

/**
 * Regression: Space / ▶ in the AI trials panel scrolled it to the top, because
 * setActive() on the already shown panel made dockview re-append its content
 * (scrollTop → 0). The panel is now activated only when it is not shown.
 */
describe('showDockPanel', () => {
  it('leaves a shown panel alone (its scroll position survives)', () => {
    const content = { scrollTop: 420 }
    const panel = { api: { isVisible: true, setActive: vi.fn(() => { content.scrollTop = 0 }) } }
    expect(showDockPanel(panel)).toBe(false)
    expect(panel.api.setActive).not.toHaveBeenCalled()
    expect(content.scrollTop).toBe(420)
  })
  it('activates a hidden panel', () => {
    const panel = { api: { isVisible: false, setActive: vi.fn() } }
    expect(showDockPanel(panel)).toBe(true)
    expect(panel.api.setActive).toHaveBeenCalledOnce()
  })
})
