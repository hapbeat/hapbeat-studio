import { afterEach, describe, expect, it, vi } from 'vitest'

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value) },
    removeItem: (key: string) => { data.delete(key) },
  }
}

async function load(stored: Record<string, string> = {}) {
  vi.resetModules()
  const storage = memoryStorage(stored)
  vi.stubGlobal('localStorage', storage)
  return { ...(await import('@/stores/systemAudioStore')), storage }
}

afterEach(() => {
  vi.unstubAllGlobals()
  delete (window as { hapbeatDesktop?: unknown }).hapbeatDesktop
})

describe('PC sound settings', () => {
  it('start from 100% / 0 ms, are clamped and kept in this browser', async () => {
    const { useSystemAudio, SYSTEM_AUDIO_STORAGE_KEY, GAIN_PCT_MAX, DELAY_MS_MAX, storage } = await load()
    expect(useSystemAudio.getState()).toMatchObject({ gainPct: 100, delayMs: 0 })
    useSystemAudio.getState().setGainPct(999)
    useSystemAudio.getState().setDelayMs(123.6)
    expect(useSystemAudio.getState()).toMatchObject({ gainPct: GAIN_PCT_MAX, delayMs: 124 })
    useSystemAudio.getState().setDelayMs(-5)
    expect(useSystemAudio.getState().delayMs).toBe(0)
    useSystemAudio.getState().setDelayMs(1e9)
    expect(useSystemAudio.getState().delayMs).toBe(DELAY_MS_MAX)
    expect(JSON.parse(storage.getItem(SYSTEM_AUDIO_STORAGE_KEY) ?? '{}')).toEqual({ gainPct: GAIN_PCT_MAX, delayMs: DELAY_MS_MAX })
  })

  it('come back on the next load, and a broken entry falls back to the defaults', async () => {
    const kept = await load({ 'hapbeat-studio-pc-sound': JSON.stringify({ gainPct: 140, delayMs: 180 }) })
    expect(kept.useSystemAudio.getState()).toMatchObject({ gainPct: 140, delayMs: 180 })
    const broken = await load({ 'hapbeat-studio-pc-sound': '{not json' })
    expect(broken.useSystemAudio.getState()).toMatchObject({ gainPct: 100, delayMs: 0 })
  })
})

describe('systemAudioMode', () => {
  it('is the app without a picker when it says so, none in an app that cannot, the picker in a browser', async () => {
    const { systemAudioMode } = await load()
    vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia: () => Promise.resolve() } })
    expect(systemAudioMode()).toBe('browser')
    ;(window as { hapbeatDesktop?: unknown }).hapbeatDesktop = { shell: 'electron', systemAudio: true }
    expect(systemAudioMode()).toBe('app')
    ;(window as { hapbeatDesktop?: unknown }).hapbeatDesktop = { shell: 'electron', apiVersion: 1 }
    expect(systemAudioMode()).toBeNull()
    delete (window as { hapbeatDesktop?: unknown }).hapbeatDesktop
    vi.stubGlobal('navigator', {})
    expect(systemAudioMode()).toBeNull()
  })
})
