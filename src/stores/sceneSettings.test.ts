import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SCENE_UI_STORAGE_KEY } from '@/utils/sceneUiSettings'

const storage = new Map<string, string>()
vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, v) }, removeItem: (k: string) => { storage.delete(k) } })

beforeEach(() => { storage.clear(); vi.resetModules() })

describe('per-firing editing stays with its project', () => {
  it('is never written to localStorage and never read from it', async () => {
    const { useSceneSettings } = await import('./sceneSettings')
    useSceneSettings.getState().update({ editFirings: true, leadSec: 2 })
    const stored = JSON.parse(storage.get(SCENE_UI_STORAGE_KEY)!)
    expect(stored.leadSec).toBe(2)
    expect('editFirings' in stored).toBe(false)
    storage.set(SCENE_UI_STORAGE_KEY, JSON.stringify({ ...stored, editFirings: true }))
    vi.resetModules()
    const again = await import('./sceneSettings')
    expect(again.useSceneSettings.getState().editFirings).toBe(false)
    expect(again.useSceneSettings.getState().leadSec).toBe(2)
  })
})
