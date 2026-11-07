import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  addWifiPreset,
  confirmsPresetConnection,
  parseWifiPresets,
  PRESET_CONFIRM_MIN_MS,
  WIFI_PRESETS_KEY,
  WIFI_PRESETS_MAX,
  type WifiPreset,
} from './wifiPresets'

const preset = (ssid: string, savedAt: number, password = 'pw'): WifiPreset => ({ ssid, password, savedAt })

describe('parseWifiPresets', () => {
  it('reads a stored list, newest first', () => {
    const raw = JSON.stringify([preset('Old', 1), preset('New', 3), preset('Mid', 2)])
    expect(parseWifiPresets(raw).map((p) => p.ssid)).toEqual(['New', 'Mid', 'Old'])
  })

  it('returns nothing for a missing, broken or non-list value', () => {
    expect(parseWifiPresets(null)).toEqual([])
    expect(parseWifiPresets('')).toEqual([])
    expect(parseWifiPresets('{not json')).toEqual([])
    expect(parseWifiPresets('{"ssid":"A"}')).toEqual([])
    expect(parseWifiPresets('"A"')).toEqual([])
  })

  it('drops malformed entries and repeated SSIDs, keeps the rest', () => {
    const raw = JSON.stringify([
      null, 3, 'x', { ssid: '' }, { ssid: '  ' }, { password: 'p' },
      { ssid: 'A', password: 'a', savedAt: 5 },
      { ssid: 'A', password: 'older', savedAt: 1 },
      { ssid: 'Open', savedAt: 'nope' },
    ])
    expect(parseWifiPresets(raw)).toEqual([
      { ssid: 'A', password: 'a', savedAt: 5 },
      { ssid: 'Open', password: '', savedAt: 0 },
    ])
  })

  it(`keeps at most ${WIFI_PRESETS_MAX}`, () => {
    const raw = JSON.stringify(Array.from({ length: 15 }, (_, i) => preset(`N${i}`, i)))
    const list = parseWifiPresets(raw)
    expect(list).toHaveLength(WIFI_PRESETS_MAX)
    expect(list[0].ssid).toBe('N14')
  })
})

describe('addWifiPreset', () => {
  it('puts the new one first and replaces the same SSID', () => {
    const list = [preset('A', 2), preset('B', 1)]
    expect(addWifiPreset(list, preset('B', 9, 'new')).map((p) => [p.ssid, p.password]))
      .toEqual([['B', 'new'], ['A', 'pw']])
  })

  it('drops the oldest beyond the limit', () => {
    const list = Array.from({ length: WIFI_PRESETS_MAX }, (_, i) => preset(`N${i}`, 100 - i))
    const next = addWifiPreset(list, preset('Venue', 200))
    expect(next).toHaveLength(WIFI_PRESETS_MAX)
    expect(next[0].ssid).toBe('Venue')
    expect(next.some((p) => p.ssid === `N${WIFI_PRESETS_MAX - 1}`)).toBe(false)
  })
})

describe('confirmsPresetConnection', () => {
  const baseline = { connected: true, ssid: 'Home' }
  const pending = { ssid: 'Venue', at: 1000, baseline }
  const late = 1000 + PRESET_CONFIRM_MIN_MS

  it('a fresh read connected to that network', () => {
    expect(confirmsPresetConnection(pending, { connected: true, ssid: 'Venue' }, late)).toBe(true)
  })

  it('not the status that was on screen when it was sent', () => {
    const same = { connected: true, ssid: 'Venue' }
    expect(confirmsPresetConnection({ ...pending, baseline: same }, same, late)).toBe(false)
  })

  it('not a read right after set_wifi (it may describe the previous connection)', () => {
    expect(confirmsPresetConnection(pending, { connected: true, ssid: 'Venue' }, late - 1)).toBe(false)
  })

  it('not while connecting, nor connected elsewhere, nor without a status', () => {
    expect(confirmsPresetConnection(pending, { connected: false, ssid: 'Venue' }, late)).toBe(false)
    expect(confirmsPresetConnection(pending, { connected: true, ssid: 'Home' }, late)).toBe(false)
    expect(confirmsPresetConnection(pending, undefined, late)).toBe(false)
  })
})

describe('useWifiPresets', () => {
  let storage: Map<string, string>
  const fakeStorage = () => ({
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => { storage.set(k, v) },
    removeItem: (k: string) => { storage.delete(k) },
  })

  async function load() {
    vi.resetModules()
    return (await import('./wifiPresets')).useWifiPresets
  }

  beforeEach(() => {
    storage = new Map()
    vi.stubGlobal('localStorage', fakeStorage())
  })
  afterEach(() => vi.unstubAllGlobals())

  it('loads what was saved before', async () => {
    storage.set(WIFI_PRESETS_KEY, JSON.stringify([preset('Venue', 5)]))
    const store = await load()
    expect(store.getState().presets.map((p) => p.ssid)).toEqual(['Venue'])
  })

  it('saves, replaces and removes, and writes each change to localStorage', async () => {
    const store = await load()
    expect(store.getState().remember({ ssid: ' Venue ', pass: 'pw-1' })).toBe(true)
    store.getState().remember({ ssid: 'Office', pass: 'pw-2' })
    store.getState().remember({ ssid: 'Venue', pass: 'pw-3' })
    const stored = () => parseWifiPresets(storage.get(WIFI_PRESETS_KEY) ?? null)
    expect(store.getState().presets.map((p) => [p.ssid, p.password])).toEqual([['Venue', 'pw-3'], ['Office', 'pw-2']])
    expect(stored().map((p) => p.ssid)).toEqual(['Venue', 'Office'])
    store.getState().remove('Venue')
    expect(stored().map((p) => p.ssid)).toEqual(['Office'])
    store.getState().clear()
    expect(store.getState().presets).toEqual([])
    expect(storage.has(WIFI_PRESETS_KEY)).toBe(false)
  })

  it('an open network is saved without a password; an empty SSID is not saved', async () => {
    const store = await load()
    store.getState().remember({ ssid: 'Open' })
    expect(store.getState().remember({ ssid: '  ', pass: 'x' })).toBe(false)
    expect(store.getState().presets).toMatchObject([{ ssid: 'Open', password: '' }])
  })

  it('keeps what another tab saved meanwhile', async () => {
    const store = await load()
    store.getState().remember({ ssid: 'Here', pass: 'a' })
    // Another Studio tab writes its own list.
    storage.set(WIFI_PRESETS_KEY, JSON.stringify([preset('Here', 1, 'a'), preset('There', Date.now() + 1, 'b')]))
    store.getState().remember({ ssid: 'Venue', pass: 'c' })
    expect(store.getState().presets.map((p) => p.ssid)).toEqual(['Venue', 'There', 'Here'])
  })

  it('works in memory when localStorage is unusable, and says it could not save', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('SecurityError') },
      setItem: () => { throw new Error('SecurityError') },
      removeItem: () => { throw new Error('SecurityError') },
    })
    const store = await load()
    expect(store.getState().presets).toEqual([])
    expect(store.getState().remember({ ssid: 'Venue', pass: 'pw' })).toBe(false)
    store.getState().remember({ ssid: 'Office', pass: 'pw' })
    expect(store.getState().presets.map((p) => p.ssid)).toEqual(['Office', 'Venue'])
    store.getState().remove('Office')
    expect(store.getState().presets.map((p) => p.ssid)).toEqual(['Venue'])
  })

  it('a full localStorage keeps the list in memory and reports the failure', async () => {
    vi.stubGlobal('localStorage', { ...fakeStorage(), setItem: () => { throw new Error('QuotaExceededError') } })
    const store = await load()
    expect(store.getState().remember({ ssid: 'Venue', pass: 'pw' })).toBe(false)
    expect(store.getState().presets.map((p) => p.ssid)).toEqual(['Venue'])
  })

  it('without localStorage at all (node), it still loads', async () => {
    vi.unstubAllGlobals()
    const store = await load()
    expect(store.getState().presets).toEqual([])
  })
})
