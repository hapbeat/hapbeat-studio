import { afterEach, describe, expect, it, vi } from 'vitest'
import { OPEN_TAB_EVENT, openSceneSelectionInEditor, revealEvent, useEventStore } from './eventStore'
import { sampleTable } from '@/utils/sceneTestFixtures'

describe('revealEvent (the AI panel event pill)', () => {
  it('selects the event and brings the Events and Event detail panels forward', () => {
    useEventStore.setState({ selected: 'other' })
    const focused: string[] = []
    revealEvent('engage', id => focused.push(id))
    expect(useEventStore.getState().selected).toBe('engage')
    expect(focused).toEqual(['events', 'eventDetail'])
  })
})

describe('Scene → editor (openInEditor)', () => {
  const realOpen = useEventStore.getState().openInEditor
  afterEach(() => { useEventStore.setState({ openInEditor: realOpen }); vi.unstubAllGlobals() })

  it('selects the event, requests the editor focus once and switches to the editor tab', () => {
    const dispatched: { type: string; detail: unknown }[] = []
    vi.stubGlobal('dispatchEvent', (e: CustomEvent) => { dispatched.push({ type: e.type, detail: e.detail }); return true })
    useEventStore.setState({ selected: null, focusRequest: 3 })
    useEventStore.getState().openInEditor('button:soft')
    expect(useEventStore.getState().selected).toBe('button:soft')
    expect(useEventStore.getState().focusRequest).toBe(4)
    expect(dispatched).toEqual([{ type: OPEN_TAB_EVENT, detail: 'editor' }])
  })

  it('opens the Scene event panel selection (a variant as cue:variant); nothing without a selection', () => {
    const open = vi.fn()
    useEventStore.setState({ openInEditor: open })
    const table = sampleTable()
    table.cues.button.variants = { soft: {} }
    expect(openSceneSelectionInEditor(table, { name: 'button:soft' })).toBe('button:soft')
    expect(open).toHaveBeenLastCalledWith('button:soft')
    expect(openSceneSelectionInEditor(table, { name: 'grab' })).toBe('grab')
    expect(open).toHaveBeenLastCalledWith('grab')
    expect(openSceneSelectionInEditor(table, null)).toBeNull()
    expect(openSceneSelectionInEditor(null, { name: 'grab' })).toBeNull()
    expect(openSceneSelectionInEditor(table, { name: 'nope' })).toBeNull()
    expect(open).toHaveBeenCalledTimes(2)
  })
})
