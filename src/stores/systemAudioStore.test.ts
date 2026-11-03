import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ManagerMessage } from '@/types/manager'

// The capture itself needs a browser: replaced by a fake that hands chunks to the test.
const capture = vi.hoisted(() => ({
  options: null as null | { source: unknown; picker: boolean; onChunk(chunk: Float32Array): void },
  fail: null as null | string,
}))
vi.mock('@/utils/systemAudioCapture', () => ({
  MAX_CAPTURE_DELAY_S: 1,
  startSystemAudioCapture: async (options: typeof capture.options) => {
    if (capture.fail) throw new DOMException('no', capture.fail)
    capture.options = options
    return { info: { name: 'CABLE Output (VB-Audio Virtual Cable)', channels: 2, sampleRate: 48000 }, setDelay: () => {}, stop: () => {} }
  },
}))

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

const setDesktop = (api: unknown) => { (window as { hapbeatDesktop?: unknown }).hapbeatDesktop = api }

afterEach(() => {
  vi.unstubAllGlobals()
  delete (window as { hapbeatDesktop?: unknown }).hapbeatDesktop
})

describe('PC sound settings', () => {
  it('start from 100% / 0 ms / the default playback device, are clamped and kept in this browser', async () => {
    const { useSystemAudio, SYSTEM_AUDIO_STORAGE_KEY, GAIN_PCT_MAX, DELAY_MS_MAX, storage } = await load()
    expect(useSystemAudio.getState()).toMatchObject({ gainPct: 100, delayMs: 0, source: null })
    useSystemAudio.getState().setGainPct(999)
    useSystemAudio.getState().setDelayMs(123.6)
    expect(useSystemAudio.getState()).toMatchObject({ gainPct: GAIN_PCT_MAX, delayMs: 124 })
    useSystemAudio.getState().setDelayMs(-5)
    expect(useSystemAudio.getState().delayMs).toBe(0)
    useSystemAudio.getState().setDelayMs(1e9)
    expect(useSystemAudio.getState().delayMs).toBe(DELAY_MS_MAX)
    useSystemAudio.getState().setSource({ deviceId: 'cable', label: 'CABLE Output (VB-Audio Virtual Cable)' })
    expect(JSON.parse(storage.getItem(SYSTEM_AUDIO_STORAGE_KEY) ?? '{}')).toEqual({
      gainPct: GAIN_PCT_MAX, delayMs: DELAY_MS_MAX, source: { deviceId: 'cable', label: 'CABLE Output (VB-Audio Virtual Cable)' },
    })
    useSystemAudio.getState().setSource(null)
    expect(useSystemAudio.getState().source).toBeNull()
  })

  it('come back on the next load, and a broken entry falls back to the defaults', async () => {
    const kept = await load({ 'hapbeat-studio-pc-sound': JSON.stringify({ gainPct: 140, delayMs: 180, source: { deviceId: 'vm', label: 'Voicemeeter Out 6' } }) })
    expect(kept.useSystemAudio.getState()).toMatchObject({ gainPct: 140, delayMs: 180, source: { deviceId: 'vm', label: 'Voicemeeter Out 6' } })
    const broken = await load({ 'hapbeat-studio-pc-sound': '{not json' })
    expect(broken.useSystemAudio.getState()).toMatchObject({ gainPct: 100, delayMs: 0, source: null })
    const noId = await load({ 'hapbeat-studio-pc-sound': JSON.stringify({ source: { deviceId: '', label: 'x' } }) })
    expect(noId.useSystemAudio.getState().source).toBeNull()
  })
})

describe('systemAudioSupport', () => {
  it('app: loopback without a picker when it says so, recording devices from apiVersion 4; browser: picker + getUserMedia', async () => {
    const { systemAudioSupport } = await load()
    vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia: () => Promise.resolve(), getUserMedia: () => Promise.resolve() } })
    expect(systemAudioSupport()).toEqual({ loopback: 'picker', inputs: true })
    setDesktop({ shell: 'electron', apiVersion: 4, systemAudio: true, audioInput: true })
    expect(systemAudioSupport()).toEqual({ loopback: 'app', inputs: true })
    setDesktop({ shell: 'electron', apiVersion: 3, systemAudio: true })
    expect(systemAudioSupport()).toEqual({ loopback: 'app', inputs: false })
    setDesktop({ shell: 'electron', apiVersion: 1 })
    expect(systemAudioSupport()).toEqual({ loopback: null, inputs: false })
    delete (window as { hapbeatDesktop?: unknown }).hapbeatDesktop
    vi.stubGlobal('navigator', {})
    expect(systemAudioSupport()).toEqual({ loopback: null, inputs: false })
  })
})

describe('PC sound run', () => {
  async function liveRun(source: { deviceId: string; label: string } | null) {
    const loaded = await load()
    const sent: ManagerMessage[] = []
    const { setActiveHelperChannel } = await import('@/utils/helperRequest')
    setActiveHelperChannel({ send: (m) => { sent.push(m) }, subscribe: () => () => {} })
    setDesktop({ shell: 'electron', apiVersion: 4, systemAudio: true, audioInput: true })
    loaded.useSystemAudio.getState().setSource(source)
    capture.options = null
    capture.fail = null
    return { ...loaded, sent }
  }

  it('captures the chosen recording device, names it, and flags exact silence after a while', async () => {
    const { useSystemAudio, SILENT_HINT_MS, sent } = await liveRun({ deviceId: 'cable', label: 'CABLE Output' })
    await useSystemAudio.getState().start(['192.0.2.10'])
    expect(capture.options).toMatchObject({ source: { kind: 'input', deviceId: 'cable' }, picker: false })
    expect(useSystemAudio.getState()).toMatchObject({ state: 'live', capturing: { name: 'CABLE Output (VB-Audio Virtual Cable)', channels: 2 } })
    const onChunk = capture.options!.onChunk
    const zeros = new Float32Array(512)
    const chunks = Math.ceil(SILENT_HINT_MS / 16)
    for (let i = 0; i < chunks - 1; i++) onChunk(zeros)
    expect(useSystemAudio.getState().silent).toBe(false)
    onChunk(zeros)
    expect(useSystemAudio.getState().silent).toBe(true)
    onChunk(new Float32Array(512).fill(0.1))
    expect(useSystemAudio.getState().silent).toBe(false)
    expect(sent.filter((m) => m.type === 'stream_data').length).toBeGreaterThan(chunks)
    useSystemAudio.getState().stop()
    expect(useSystemAudio.getState()).toMatchObject({ state: 'idle', capturing: null, silent: false, notice: null })
  })

  it('uses the loopback when no device is chosen, and tells a missing device from a refusal', async () => {
    const run = await liveRun(null)
    await run.useSystemAudio.getState().start(['192.0.2.10'])
    expect(capture.options).toMatchObject({ source: { kind: 'loopback' }, picker: false })
    run.useSystemAudio.getState().stop()

    const missing = await liveRun({ deviceId: 'gone', label: 'Old device' })
    capture.fail = 'OverconstrainedError'
    await missing.useSystemAudio.getState().start(['192.0.2.10'])
    expect(missing.useSystemAudio.getState()).toMatchObject({ state: 'idle', notice: 'sourceMissing' })

    const refused = await liveRun(null)
    capture.fail = 'NotAllowedError'
    await refused.useSystemAudio.getState().start(['192.0.2.10'])
    expect(refused.useSystemAudio.getState()).toMatchObject({ state: 'idle', notice: 'denied' })
  })
})
