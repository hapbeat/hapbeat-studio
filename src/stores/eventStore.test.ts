import { describe, expect, it } from 'vitest'
import { revealEvent, useEventStore } from './eventStore'

describe('revealEvent (the AI panel event pill)', () => {
  it('selects the event and brings the Events and Event detail panels forward', () => {
    useEventStore.setState({ selected: 'other' })
    const focused: string[] = []
    revealEvent('engage', id => focused.push(id))
    expect(useEventStore.getState().selected).toBe('engage')
    expect(focused).toEqual(['events', 'eventDetail'])
  })
})
