import { describe, expect, it } from 'vitest'
import { idleHidesControls, playerPlaysAllDevices, pressOnlyShowsControls } from './playerUi'
import type { CueTable } from './sceneCueTable'

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

describe('player device routing', () => {
  const table: CueTable = { clips: {}, cues: {
    detent: { haptics: [{ clip: 'tick', at: 'hand', gain: 1 }] },
    rumble: { haptics: [{ clip: 'hum', at: 'pos_neck', gain: 1 }] },
  } }
  it('plays by position once a Hapbeat is at a position the table routes to (neck + wrist)', () => {
    expect(playerPlaysAllDevices(table, ['player_1/pos_neck', 'player_1/pos_r_wrist'])).toBe(false)
    expect(playerPlaysAllDevices(table, ['player_1/pos_r_wrist', ''])).toBe(false)
  })
  it('sends every route to every Hapbeat when none is at a position the table uses', () => {
    expect(playerPlaysAllDevices(table, ['player_1/pos_chest'])).toBe(true)
    expect(playerPlaysAllDevices(table, [''])).toBe(true)
    expect(playerPlaysAllDevices(table, [])).toBe(true)
    expect(playerPlaysAllDevices(null, ['player_1/pos_neck'])).toBe(true)
  })
})
