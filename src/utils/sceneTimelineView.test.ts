import { describe, expect, it } from 'vitest'
import { spanWindow, stepView, timelineClick, type TimelineView } from './sceneTimelineView'

const W = 1000, DUR = 57, MAX = 2000
const fresh = (): TimelineView => ({ key: '', start: 0, zoom: 1, fit: true, span: false })
const shown = (vw: TimelineView): [number, number] => [vw.start, vw.start + W / vw.zoom]

describe('Scene timeline: a playing loop cue span fills the timeline', () => {
  // feed_loop's span 4.4–15.4 s with a 1 s lead-in and post-roll.
  const win = spanWindow([4.4 - 1, 15.4 + 1], DUR)!

  it('the window is the span ± its margins, clamped to the moment', () => {
    expect(win[0]).toBeCloseTo(3.4); expect(win[1]).toBeCloseTo(16.4)
    expect(spanWindow([-0.5, 60], DUR)).toEqual([0, DUR])
    expect(spanWindow(null, DUR)).toBeNull()
  })

  it('while the span plays the timeline shows only the window (also while playing and on resize)', () => {
    const vw = fresh()
    stepView(vw, '0:full', null, W, DUR, MAX, false, 0)
    expect(shown(vw)[0]).toBe(0); expect(shown(vw)[1]).toBeCloseTo(DUR)
    stepView(vw, '0:full:3.4-16.4', win, W, DUR, MAX, true, 10)
    expect(shown(vw)[0]).toBeCloseTo(3.4); expect(shown(vw)[1]).toBeCloseTo(16.4)
    stepView(vw, '0:full:3.4-16.4', win, W, DUR, MAX, true, 16.3)
    expect(shown(vw)[0]).toBeCloseTo(3.4)
    stepView(vw, '0:full:3.4-16.4', win, 500, DUR, MAX, true, 5)
    expect(vw.start).toBeCloseTo(3.4); expect(vw.start + 500 / vw.zoom).toBeCloseTo(16.4)
  })

  it('leaving the span (another row, W, a clip moment) restores the whole moment', () => {
    const vw = fresh()
    stepView(vw, '0:full:3.4-16.4', win, W, DUR, MAX, true, 5)
    stepView(vw, '0:full', null, W, DUR, MAX, true, 5)
    expect(shown(vw)[0]).toBe(0); expect(shown(vw)[1]).toBeCloseTo(DUR); expect(vw.span).toBe(false)
  })

  it('another span shows its own window', () => {
    const vw = fresh(), other = spanWindow([37.5, 44.8], DUR)!
    stepView(vw, '0:full:3.4-16.4', win, W, DUR, MAX, true, 5)
    stepView(vw, '0:full:37.5-44.8', other, W, DUR, MAX, true, 38)
    expect(shown(vw)[0]).toBeCloseTo(37.5); expect(shown(vw)[1]).toBeCloseTo(44.8)
  })

  it('zoomed by hand (Ctrl + wheel from the span window) it stays as zoomed and follows the playhead', () => {
    const vw = fresh()
    stepView(vw, '0:full:3.4-16.4', win, W, DUR, MAX, true, 5)
    vw.zoom = vw.zoom / 2; vw.span = false // the wheel handler's zoom out
    stepView(vw, '0:full:3.4-16.4', win, W, DUR, MAX, true, 5)
    expect(W / vw.zoom).toBeCloseTo(26); expect(vw.span).toBe(false)
    stepView(vw, '0:full:3.4-16.4', win, W, DUR, MAX, true, 45)
    expect(shown(vw)[0]).toBeLessThanOrEqual(45); expect(shown(vw)[1]).toBeGreaterThanOrEqual(45)
  })
})

describe('Scene timeline click: a plain click only seeks; Ctrl / Cmd + click switches to the clicked event', () => {
  const marker = { name: 'cut_loop', t: 12 }, run: [number, number] = [20, 30]
  it('a plain click on a marker, a band or elsewhere seeks to the clicked time', () => {
    expect(timelineClick(false, marker, null, 8)).toEqual({ kind: 'seek', t: 8 })
    expect(timelineClick(false, null, run, 25)).toEqual({ kind: 'seek', t: 25 })
    expect(timelineClick(false, null, null, 3)).toEqual({ kind: 'seek', t: 3 })
  })
  it('Ctrl / Cmd + click on a marker selects that event, on a band plays that span, elsewhere seeks', () => {
    expect(timelineClick(true, marker, null, 8)).toEqual({ kind: 'select', name: 'cut_loop', t: 12 })
    expect(timelineClick(true, null, run, 25)).toEqual({ kind: 'span', run })
    expect(timelineClick(true, null, null, 3)).toEqual({ kind: 'seek', t: 3 })
  })
})
