import { describe, expect, it } from 'vitest'
import { applyGroupEdits, detachCue, groupContext, joinGroupOf } from './eventGroups'

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
