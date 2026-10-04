import { describe, expect, it } from 'vitest'
import { scenePreRoll, setScenePreRoll } from './editorSceneSync'

describe('scene pre-roll', () => {
  it('applies only while the Scene video panel has focus', () => {
    let focused = false
    const preRoll = { seconds: 1, begin: () => {}, cancel: () => {}, active: () => focused }
    setScenePreRoll(preRoll)
    expect(scenePreRoll()).toBeNull()
    focused = true
    expect(scenePreRoll()).toBe(preRoll)
    setScenePreRoll(null)
    expect(scenePreRoll()).toBeNull()
  })
})
