import { describe, expect, it, vi } from 'vitest'
import { handlePlaybackShortcut } from './playbackShortcut'
const key = (extra = {}) => ({code: 'Space', isComposing: false, repeat: false, preventDefault: vi.fn(), stopImmediatePropagation: vi.fn(), ...extra}) as unknown as KeyboardEvent
describe('Studio playback shortcuts', () => {
  it.each(['input', 'button', 'select', 'textarea', 'div'])('uses only Editor playback with focus in %s', tagName => {
    const event = key({target: {tagName}}), dispatch = vi.fn()
    handlePlaybackShortcut(event, 'editor', dispatch)
    expect(dispatch.mock.calls.map(([e]) => e.type)).toEqual(['studio:editor-playback'])
    expect(event.preventDefault).toHaveBeenCalled(); expect(event.stopImmediatePropagation).toHaveBeenCalled()
  })
  it.each(['kit', 'devices'])('keeps selected Kit playback available from %s', tab => {
    const dispatch = vi.fn(); handlePlaybackShortcut(key(), tab, dispatch)
    expect(dispatch.mock.calls.map(([e]) => e.type)).toEqual(['studio:kit-playback'])
  })
  it('sends Scene playback to the Scene tab', () => {
    const dispatch = vi.fn(); handlePlaybackShortcut(key(), 'scene', dispatch)
    expect(dispatch.mock.calls.map(([e]) => e.type)).toEqual(['studio:scene-playback'])
  })
  it('does not repeatedly toggle, interfere with composition, or play a hidden tab from Display', () => {
    const dispatch = vi.fn()
    handlePlaybackShortcut(key({repeat: true}), 'editor', dispatch)
    handlePlaybackShortcut(key({isComposing: true}), 'editor', dispatch)
    handlePlaybackShortcut(key(), 'display', dispatch)
    expect(dispatch).not.toHaveBeenCalled()
  })
})
