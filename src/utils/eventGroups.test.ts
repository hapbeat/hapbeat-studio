import { describe, expect, it } from 'vitest'
import { applyGroupEdits, detachCue, eventListItems, firstTimes, groupContext, groupLabel, joinGroupOf, orderByFirst } from './eventGroups'
import { sampleLib, sampleTable } from './sceneTestFixtures'
import type { SceneData } from './sceneData'

const ORDER = ['approach', 'engage', 'cut_loop', 'feed_loop', 'retract']

describe('event groups by hand', () => {
  it('keeps the automatic groups without edits', () => {
    expect(applyGroupEdits([['engage', 'cut_loop']], undefined, ORDER)).toEqual([['engage', 'cut_loop']])
  })

  it('a detached cue leaves its group; a group of one is no group', () => {
    const edits = detachCue(undefined, 'cut_loop')
    expect(applyGroupEdits([['engage', 'cut_loop']], edits, ORDER)).toEqual([])
    expect(applyGroupEdits([['engage', 'cut_loop', 'feed_loop']], edits, ORDER)).toEqual([['engage', 'feed_loop']])
  })

  it('a cue moves into the group of another event; its old group keeps the rest', () => {
    const auto = [['grab', 'feed_loop'], ['engage', 'cut_loop']]
    const order = ['grab', 'feed_loop', 'engage', 'cut_loop', 'retract']
    let edits = joinGroupOf(undefined, 'engage', 'grab')
    expect(applyGroupEdits(auto, edits, order)).toEqual([['grab', 'feed_loop', 'engage']])
    edits = joinGroupOf(edits, 'cut_loop', 'feed_loop')
    expect(applyGroupEdits(auto, edits, order)).toEqual([['grab', 'feed_loop', 'engage', 'cut_loop']])
    // Moving again leaves the hand-made group too; a cue alone joins another alone.
    edits = joinGroupOf(edits, 'engage', 'retract')
    expect(applyGroupEdits(auto, edits, order)).toEqual([['grab', 'feed_loop', 'cut_loop'], ['engage', 'retract']])
    // The same move twice is stored once; itself and cues no longer in the table change nothing.
    expect(joinGroupOf(edits, 'engage', 'retract')).toEqual(edits)
    expect(joinGroupOf(edits, 'engage', 'engage')).toEqual(edits)
    expect(applyGroupEdits([], joinGroupOf(undefined, 'engage', 'gone'), order)).toEqual([])
  })

  it('a detach after a move takes the cue out of the hand-made group', () => {
    const edits = detachCue(joinGroupOf(undefined, 'feed_loop', 'engage'), 'feed_loop')
    expect(edits.joined).toEqual([])
    expect(applyGroupEdits([['engage', 'cut_loop']], edits, ORDER)).toEqual([['engage', 'cut_loop']])
  })

  it('the other cues of a group play as context', () => {
    const groups = [['engage', 'cut_loop', 'feed_loop']]
    expect(groupContext(groups, 'engage')).toEqual(['cut_loop', 'feed_loop'])
    expect(groupContext(groups, 'retract')).toEqual([])
  })
})

describe('group order and list rows', () => {
  const loops = new Set(['feed_loop', 'cut_loop'])
  const isLoop = (c: string) => loops.has(c)

  it('orders a group by first time; a loop starting with a one-shot comes after it; never played last', () => {
    // Safety Mill: grab 1.0, engage 4.0, feed_loop starts 3.98 (with engage), cut_loop 4.5.
    const firsts = { grab: 1.0, engage: 4.0, feed_loop: 3.98, cut_loop: 4.5 }
    const ordered = orderByFirst(['engage', 'cut_loop', 'feed_loop', 'grab'], firsts, isLoop)
    expect(ordered).toEqual(['grab', 'engage', 'feed_loop', 'cut_loop'])
    expect(groupLabel(ordered)).toBe('grab → engage → feed_loop → cut_loop')
    // A loop well before the one-shot stays first; a cue that never plays goes last.
    expect(orderByFirst(['engage', 'feed_loop', 'retract'], { engage: 4, feed_loop: 2 }, isLoop)).toEqual(['feed_loop', 'engage', 'retract'])
  })

  it('a group is one item listing every event as its own row (never merged), at its first cue place', () => {
    const order = ['approach', 'cut_loop', 'engage', 'retract']
    const items = eventListItems(order, [['cut_loop', 'engage']], { engage: 4, cut_loop: 4.05 }, isLoop)
    expect(items).toEqual([
      { cues: ['approach'], group: false },
      { cues: ['engage', 'cut_loop'], group: true },
      { cues: ['retract'], group: false },
    ])
  })

  it('first times: a loop cue from the layer first active run when earlier than any firing', () => {
    const lib = sampleLib(), table = sampleTable()
    const layer = lib.layers.find(l => table.cues[l.cue])!
    const width = Math.max(...layer.gain) + 1
    const row = (on: boolean) => Array.from({ length: width }, (_, i) => on && layer.gain.includes(i) ? 1 : 0)
    const data = { fps: 10, clips: [], full: { file: '', levels: [row(false), row(false), row(true), row(true)], events: [{ t: 1, name: 'button', hand: 'r' }] } } as SceneData
    expect(firstTimes(table, lib, data)).toMatchObject({ button: 1, [layer.cue]: 0.2 })
  })
})
