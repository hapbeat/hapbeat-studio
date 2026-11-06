import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// serialMaster.bulkSetWifi against fake USB devices: Web Serial and the
// serial config connection are replaced, so nothing reaches real hardware.

interface FakeDevice {
  /** 1.0.0+ firmware saves on set_wifi; older saves once connected. */
  saveOnSet: boolean
  /** ms after set_wifi until it connects; undefined = never. */
  connectAfterMs?: number
  /** port.open() throws. */
  openFails?: boolean
  /** get_info never answers (no firmware). */
  silent?: boolean
  opened: number
  closed: number
  /** Commands and closes in order, with the clock. */
  events: Array<{ at: number; what: string }>
  profiles: Array<{ index: number; ssid: string; has_pass: boolean }>
  active: { ssid: string; pass: string; at: number } | null
}

const fake = vi.hoisted(() => ({
  supported: false,
  devices: new Map<object, FakeDevice>(),
}))

function sendFor(d: FakeDevice) {
  const connected = () =>
    !!d.active && d.connectAfterMs !== undefined && Date.now() - d.active.at >= d.connectAfterMs
  const save = (ssid: string, pass: string) => {
    d.profiles = [{ index: 0, ssid, has_pass: pass.length > 0 }, ...d.profiles.filter((p) => p.ssid !== ssid)]
  }
  return async (cmd: Record<string, unknown>, opts?: { timeoutMs?: number }) => {
    d.events.push({ at: Date.now(), what: String(cmd.cmd) })
    if (d.silent) {
      await new Promise((r) => setTimeout(r, opts?.timeoutMs ?? 2000))
      throw new Error(`serial timeout: ${String(cmd.cmd)}`)
    }
    switch (cmd.cmd) {
      case 'get_info': return { status: 'ok', name: 'Band', fw: '1.0.0', mac: 'aa' }
      case 'set_wifi':
        d.active = { ssid: String(cmd.ssid), pass: String(cmd.pass ?? ''), at: Date.now() }
        if (d.saveOnSet) save(d.active.ssid, d.active.pass)
        return { status: 'ok', message: 'wifi credentials applied, connecting...' }
      case 'list_wifi_profiles':
        if (!d.saveOnSet && d.active && connected()) save(d.active.ssid, d.active.pass)
        return { status: 'ok', count: d.profiles.length, max: 5, profiles: d.profiles }
      case 'get_wifi_status':
        return { status: 'ok', connected: connected(), ssid: d.active?.ssid ?? '', ip: connected() ? '10.0.0.7' : '' }
      default: return { status: 'ok' }
    }
  }
}

vi.mock('@/utils/serialFlasher', () => ({ eraseFlash: vi.fn(), flashRegions: vi.fn() }))
vi.mock('@/utils/serialConfig', () => ({
  isWebSerialSupported: () => fake.supported,
  pickConfigPort: vi.fn(),
  releaseSerialPort: async () => {},
  resetNativeUsbIntoApp: async () => false,
  openConfigConnection: async (port: object) => {
    const d = fake.devices.get(port)
    if (!d || d.openFails) throw new Error('Failed to open serial port.')
    d.opened++
    return {
      port,
      send: sendFor(d),
      close: async () => { d.closed++; d.events.push({ at: Date.now(), what: 'close' }) },
    }
  },
}))

function addDevice(opts: Partial<Pick<FakeDevice, 'saveOnSet' | 'connectAfterMs' | 'openFails' | 'silent'>> = {}) {
  const port = { getInfo: () => ({ usbVendorId: 0x303a, usbProductId: 0x1001 }) }
  const d: FakeDevice = {
    saveOnSet: opts.saveOnSet ?? true,
    connectAfterMs: opts.connectAfterMs,
    openFails: opts.openFails,
    silent: opts.silent,
    opened: 0,
    closed: 0,
    events: [],
    profiles: [],
    active: null,
  }
  fake.devices.set(port, d)
  return d
}

async function load() {
  vi.resetModules()
  const { useSerialMaster } = await import('./serialMaster')
  const { useLogStore } = await import('./logStore')
  fake.supported = true
  await useSerialMaster.getState().syncPorts()
  // Checked cards are never auto-identified (that would open the ports too).
  useSerialMaster.getState().selectAllPorts()
  return { useSerialMaster, useLogStore }
}

/** Run a bulk write to completion on the fake clock. */
async function run(
  sm: Awaited<ReturnType<typeof load>>['useSerialMaster'],
  creds = { ssid: 'Venue', pass: 'pw-1234' },
) {
  const ids = sm.getState().knownPorts.map((e) => e.id)
  let result: Awaited<ReturnType<ReturnType<typeof sm.getState>['bulkSetWifi']>> | undefined
  let done = false
  void sm.getState().bulkSetWifi(ids, creds).then((r) => { result = r; done = true })
  for (let i = 0; i < 400 && !done; i++) await vi.advanceTimersByTimeAsync(250)
  expect(done).toBe(true)
  return result!
}

const stateOf = (sm: Awaited<ReturnType<typeof load>>['useSerialMaster']) =>
  sm.getState().wifiBulk!.items.map((i) => i.state)

beforeEach(() => {
  vi.useFakeTimers()
  fake.devices.clear()
  fake.supported = false
  vi.stubGlobal('navigator', {
    serial: { getPorts: async () => [...fake.devices.keys()], addEventListener: () => {} },
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('bulkSetWifi', () => {
  it('writes every device, confirms each by reading it back, and closes each port only afterwards', async () => {
    const a = addDevice({ connectAfterMs: 2000 })
    const b = addDevice({ connectAfterMs: 4000 })
    const { useSerialMaster, useLogStore } = await load()
    const r = await run(useSerialMaster)
    expect(r).toEqual({ total: 2, connected: 2, savedOnly: 0, failed: 0 })
    expect(stateOf(useSerialMaster)).toEqual(['connected', 'connected'])
    expect(useSerialMaster.getState().wifiBulk?.running).toBe(false)
    for (const d of [a, b]) {
      expect(d.profiles.map((p) => p.ssid)).toEqual(['Venue'])
      expect(d.opened).toBe(1)
      expect(d.closed).toBe(1)
      const whats = d.events.map((e) => e.what)
      // get_info before set_wifi (the firmware must be up), the read-back
      // before the close (an S3 resets on close).
      expect(whats.indexOf('get_info')).toBeLessThan(whats.indexOf('set_wifi'))
      expect(whats.lastIndexOf('list_wifi_profiles')).toBeLessThan(whats.indexOf('close'))
    }
    // The password never reaches the log.
    expect(useLogStore.getState().entries.some((e) => e.message.includes('pw-1234'))).toBe(false)
  })

  it('reports a device that saved the network but did not connect', async () => {
    addDevice({ connectAfterMs: 1000 })
    addDevice({})  // never connects (out of range / wrong password)
    const { useSerialMaster } = await load()
    const r = await run(useSerialMaster)
    expect(r).toEqual({ total: 2, connected: 1, savedOnly: 1, failed: 0 })
    expect(stateOf(useSerialMaster)).toEqual(['connected', 'saved'])
  })

  it('older firmware: keeps the port open until the network is saved', async () => {
    const d = addDevice({ saveOnSet: false, connectAfterMs: 7000 })
    const { useSerialMaster } = await load()
    expect(await run(useSerialMaster)).toEqual({ total: 1, connected: 1, savedOnly: 0, failed: 0 })
    const setAt = d.events.find((e) => e.what === 'set_wifi')!.at
    const closeAt = d.events.find((e) => e.what === 'close')!.at
    expect(closeAt - setAt).toBeGreaterThanOrEqual(7000)
  })

  it('times out when the network never shows up (older firmware, cannot connect)', async () => {
    addDevice({ saveOnSet: false })
    const { useSerialMaster } = await load()
    expect(await run(useSerialMaster)).toEqual({ total: 1, connected: 0, savedOnly: 0, failed: 1 })
    expect(useSerialMaster.getState().wifiBulk?.items[0]).toMatchObject({ state: 'failed', failure: 'not_saved' })
  })

  it('a port that cannot be opened fails alone; the others are still written', async () => {
    addDevice({ openFails: true })
    const ok = addDevice({ connectAfterMs: 1000 })
    const { useSerialMaster } = await load()
    expect(await run(useSerialMaster)).toEqual({ total: 2, connected: 1, savedOnly: 0, failed: 1 })
    expect(useSerialMaster.getState().wifiBulk?.items[0]).toMatchObject({ state: 'failed', failure: 'open' })
    expect(ok.profiles.map((p) => p.ssid)).toEqual(['Venue'])
  })

  it('no reply (no firmware) is a failure and set_wifi is never sent', async () => {
    const d = addDevice({ silent: true })
    const { useSerialMaster } = await load()
    expect(await run(useSerialMaster)).toEqual({ total: 1, connected: 0, savedOnly: 0, failed: 1 })
    expect(useSerialMaster.getState().wifiBulk?.items[0]).toMatchObject({ state: 'failed', failure: 'no_reply' })
    expect(d.events.some((e) => e.what === 'set_wifi')).toBe(false)
    expect(d.closed).toBe(1)
  })

  it('writes the 設定-connected device over its live connection without closing it', async () => {
    const held = addDevice({ connectAfterMs: 1000 })
    const other = addDevice({ connectAfterMs: 1000 })
    const { useSerialMaster } = await load()
    const [heldPort] = [...fake.devices.keys()]
    const heldId = useSerialMaster.getState().knownPorts[0].id
    let heldClosed = 0
    const heldConn = {
      port: heldPort as unknown as SerialPort,
      send: sendFor(held),
      close: async () => { heldClosed++ },
    }
    useSerialMaster.setState({ conn: heldConn, mode: 'config', activePortId: heldId, port: heldPort as unknown as SerialPort })
    expect(await run(useSerialMaster)).toEqual({ total: 2, connected: 2, savedOnly: 0, failed: 0 })
    expect(held.opened).toBe(0)
    expect(heldClosed).toBe(0)
    expect(useSerialMaster.getState().conn).toBe(heldConn)
    expect(other.opened).toBe(1)
  })

  it('refuses a second run while one is in progress', async () => {
    addDevice({ connectAfterMs: 1000 })
    const { useSerialMaster } = await load()
    const ids = useSerialMaster.getState().knownPorts.map((e) => e.id)
    const first = useSerialMaster.getState().bulkSetWifi(ids, { ssid: 'Venue', pass: 'x' })
    await vi.advanceTimersByTimeAsync(0)
    expect(await useSerialMaster.getState().bulkSetWifi(ids, { ssid: 'Other', pass: 'y' })).toBeNull()
    for (let i = 0; i < 100; i++) await vi.advanceTimersByTimeAsync(250)
    expect((await first)?.connected).toBe(1)
  })
})
