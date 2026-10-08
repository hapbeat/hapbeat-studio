import { describe, expect, it, vi } from 'vitest'
import { newDockPanels, showDockPanel, withoutDockPanels } from './dockPanels'

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

describe('withoutDockPanels (panels a later Studio removed)', () => {
  const leaf = (id: string, views: string[], activeView = views[0]) => ({ type: 'leaf', data: { id, views, activeView }, size: 100 })
  const saved = {
    grid: { root: { type: 'branch', data: [leaf('g1', ['video']), { type: 'branch', data: [leaf('g2', ['haptics']), leaf('g3', ['sound', 'event', 'project'], 'sound')], size: 400 }], size: 800 }, width: 1200, height: 800, orientation: 'HORIZONTAL' },
    panels: { video: { id: 'video' }, haptics: { id: 'haptics' }, sound: { id: 'sound' }, event: { id: 'event' }, project: { id: 'project' } },
    activeGroup: 'g3', knownPanels: ['video', 'haptics', 'sound', 'event', 'project'],
  }
  it('drops the old Haptics / Sound panels, their emptied group, and keeps the rest', () => {
    const out = withoutDockPanels(saved, ['haptics', 'sound']) as typeof saved
    expect(Object.keys(out.panels)).toEqual(['video', 'event', 'project'])
    const inner = (out.grid.root.data[1] as { data: { data: { views: string[]; activeView: string } }[] }).data
    expect(inner).toHaveLength(1)
    expect(inner[0].data).toMatchObject({ views: ['event', 'project'], activeView: 'event' })
    expect(withoutDockPanels(out, ['haptics', 'sound'])).toBe(out) // nothing left to drop
  })
})

describe('newDockPanels (panels added by a later Studio join a saved layout once)', () => {
  const panels = ['clips', 'events', 'eventDetail', 'waveform'] as const
  const before = ['clips', 'events', 'waveform']
  it('adds the event detail panel to a layout saved before it existed', () => {
    expect(newDockPanels({ grid: {}, panels: {} }, panels, before)).toEqual(['eventDetail'])
  })
  it('adds nothing once the layout was saved with it known (closed by the user stays closed)', () => {
    expect(newDockPanels({ grid: {}, panels: {}, knownPanels: [...panels] }, panels, before)).toEqual([])
  })
})
