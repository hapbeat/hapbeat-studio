import { describe, expect, it } from 'vitest'
import { restoreSceneHandle } from './sceneRegistry'

describe('restoreSceneHandle (page load)', () => {
  it('the last opened project wins over the Scene tab\'s remembered folder', () => {
    expect(restoreSceneHandle({ handle: 'safety-mill', permission: 'granted' }, { handle: 'trex', permission: 'granted' })).toBe('safety-mill')
  })
  it('opens nothing else when the last project needs a click (the Events panel offers "allow")', () => {
    expect(restoreSceneHandle({ handle: 'safety-mill', permission: 'prompt' }, { handle: 'trex', permission: 'granted' })).toBeNull()
  })
  it('falls back to the Scene tab\'s folder when no last project is known or registered', () => {
    expect(restoreSceneHandle(null, { handle: 'trex', permission: 'granted' })).toBe('trex')
    expect(restoreSceneHandle(null, { handle: 'trex', permission: 'prompt' })).toBeNull()
    expect(restoreSceneHandle<string>(null, null)).toBeNull()
  })
})
