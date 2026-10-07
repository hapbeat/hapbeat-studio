import { describe, expect, it } from 'vitest'
import { placeMenu } from './menuPlacement'

const view = { width: 800, height: 600 }
const button = (left: number, top: number) => ({ left, top, right: left + 30, bottom: top + 20 })

describe('placeMenu', () => {
  it('opens under the trigger, left-aligned with it', () => {
    expect(placeMenu(button(100, 50), { width: 200, height: 150 }, view)).toEqual({ left: 100, top: 72 })
  })
  it('flips up when there is no room below but room above', () => {
    expect(placeMenu(button(100, 500), { width: 200, height: 150 }, view)).toEqual({ left: 100, top: 348 })
  })
  it('flips left (right-aligned with the trigger) near the right edge', () => {
    expect(placeMenu(button(700, 50), { width: 200, height: 150 }, view)).toEqual({ left: 530, top: 72 })
  })
  it('never leaves the viewport when wider than the room either way', () => {
    expect(placeMenu(button(10, 50), { width: 900, height: 100 }, view).left).toBe(4)
  })
  it('caps the height to the roomier side (internal scroll) when neither side fits', () => {
    // 524 px of room below (600 - 4 - 72), 44 above: below, capped.
    expect(placeMenu(button(100, 50), { width: 200, height: 700 }, view)).toEqual({ left: 100, top: 72, maxHeight: 524 })
    // Near the bottom: above, capped to the room above, starting at the margin.
    const up = placeMenu(button(100, 450), { width: 200, height: 700 }, view)
    expect(up).toEqual({ left: 100, top: 4, maxHeight: 444 })
    expect(up.top + up.maxHeight!).toBe(448)
  })
  it('places a right-click menu at the pointer and keeps it inside', () => {
    const at = (x: number, y: number) => ({ left: x, right: x, top: y, bottom: y })
    expect(placeMenu(at(300, 200), { width: 120, height: 40 }, view, 0)).toEqual({ left: 300, top: 200 })
    expect(placeMenu(at(790, 590), { width: 120, height: 40 }, view, 0)).toEqual({ left: 670, top: 550 })
  })
})
