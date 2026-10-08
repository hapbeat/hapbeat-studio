import { describe, expect, it } from 'vitest'
import { applyGroupEdits, detachCue, groupContext, joinCues } from './eventGroups'

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

  it('joins a cue with the previous one, also bringing a detached cue back', () => {
    let edits = joinCues(undefined, 'cut_loop', 'feed_loop')
    expect(applyGroupEdits([['engage', 'cut_loop']], edits, ORDER)).toEqual([['engage', 'cut_loop', 'feed_loop']])
    edits = detachCue(edits, 'feed_loop')
    expect(edits.joined).toEqual([])
    edits = joinCues(edits, 'engage', 'feed_loop')
    expect(edits.detached).toEqual([])
    expect(applyGroupEdits([], edits, ORDER)).toEqual([['engage', 'feed_loop']])
    // The same pair twice is stored once; cues no longer in the table are ignored.
    expect(joinCues(edits, 'engage', 'feed_loop').joined).toHaveLength(1)
    expect(applyGroupEdits([], joinCues(undefined, 'gone', 'engage'), ORDER)).toEqual([])
  })

  it('the other cues of a group play as context', () => {
    const groups = [['engage', 'cut_loop', 'feed_loop']]
    expect(groupContext(groups, 'engage')).toEqual(['cut_loop', 'feed_loop'])
    expect(groupContext(groups, 'retract')).toEqual([])
  })
})
