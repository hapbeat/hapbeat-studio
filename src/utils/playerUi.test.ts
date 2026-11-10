import { describe, expect, it } from 'vitest'
import { idleHidesControls, pressOnlyShowsControls } from './playerUi'

describe('player UI', () => {
  const still = { playing: false, fullscreen: false, hovered: false }
  it('auto hides while playing or fullscreen, never while a mouse rests over the controls', () => {
    expect(idleHidesControls('auto', still)).toBe(false)
    expect(idleHidesControls('auto', { ...still, playing: true })).toBe(true)
    expect(idleHidesControls('auto', { ...still, fullscreen: true })).toBe(true)
    expect(idleHidesControls('auto', { ...still, playing: true, hovered: true })).toBe(false)
    expect(idleHidesControls('auto', { ...still, fullscreen: true, hovered: true })).toBe(false)
  })
  it('hide always hides, show never, whatever the hover', () => {
    expect(idleHidesControls('hide', still)).toBe(true)
    expect(idleHidesControls('hide', { ...still, playing: true, hovered: true })).toBe(true)
    expect(idleHidesControls('show', { ...still, playing: true, fullscreen: true })).toBe(false)
  })
  it('a press only shows the controls when auto has hidden them', () => {
    expect(pressOnlyShowsControls('auto', true)).toBe(true)
    expect(pressOnlyShowsControls('auto', false)).toBe(false)
    // hide: the controls never show, so a press on the stage plays or pauses.
    expect(pressOnlyShowsControls('hide', true)).toBe(false)
    expect(pressOnlyShowsControls('show', false)).toBe(false)
  })
})
