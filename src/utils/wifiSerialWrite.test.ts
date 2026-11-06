import { describe, expect, it } from 'vitest'
import {
  askInfoWithRetry,
  confirmWifiSaved,
  profileListHas,
  sendSetWifi,
  setWifiCommand,
  summarizeWifiOutcomes,
  WIFI_WRITE_TIMING,
  type SerialSend,
  type WifiWriteTiming,
} from './wifiSerialWrite'

/** A virtual clock: sleep advances it, nothing waits for real. */
function clock() {
  let t = 0
  return {
    now: () => t,
    sleep: async (ms: number) => { t += ms },
    advance: (ms: number) => { t += ms },
  }
}

const timing: WifiWriteTiming = WIFI_WRITE_TIMING

/** A fake device that answers the serial config commands like the firmware.
 *  `saveOnSet` = 1.0.0+ (saves on set_wifi); otherwise it saves when it
 *  connects (`connectAfterMs` after set_wifi, never when undefined). */
function fakeDevice(opts: {
  now: () => number
  saveOnSet?: boolean
  connectAfterMs?: number
  /** get_info calls that time out before the firmware answers (booting). */
  bootingInfoCalls?: number
  /** set_wifi calls that time out. */
  dropSetWifi?: number
  setWifiReply?: Record<string, unknown>
  closed?: boolean
}) {
  const sent: Record<string, unknown>[] = []
  let profiles: Array<{ index: number; ssid: string; has_pass: boolean }> = []
  let active: { ssid: string; pass: string; at: number } | null = null
  let infoLeft = opts.bootingInfoCalls ?? 0
  let dropLeft = opts.dropSetWifi ?? 0
  const save = (ssid: string, pass: string) => {
    profiles = [{ index: 0, ssid, has_pass: pass.length > 0 }, ...profiles.filter((p) => p.ssid !== ssid)]
      .map((p, i) => ({ ...p, index: i }))
  }
  const connected = () =>
    !!active && opts.connectAfterMs !== undefined && opts.now() - active.at >= opts.connectAfterMs
  const send: SerialSend = async (cmd) => {
    sent.push(cmd)
    if (opts.closed) throw new Error('serial connection closed')
    switch (cmd.cmd) {
      case 'get_info':
        if (infoLeft > 0) { infoLeft--; throw new Error('serial timeout: get_info') }
        return { status: 'ok', name: 'Band', fw: '1.0.0' }
      case 'set_wifi': {
        if (dropLeft > 0) { dropLeft--; throw new Error('serial timeout: set_wifi') }
        if (opts.setWifiReply) return opts.setWifiReply
        const ssid = String(cmd.ssid)
        const pass = String(cmd.pass ?? '')
        active = { ssid, pass, at: opts.now() }
        if (opts.saveOnSet) save(ssid, pass)
        return { status: 'ok', message: 'wifi credentials applied, connecting...' }
      }
      case 'list_wifi_profiles':
        if (!opts.saveOnSet && active && connected()) save(active.ssid, active.pass)
        return { status: 'ok', count: profiles.length, max: 5, profiles }
      case 'get_wifi_status':
        return {
          status: 'ok',
          connected: connected(),
          ssid: active?.ssid ?? '',
          ip: connected() ? '192.168.1.42' : '',
        }
      default:
        return { status: 'error', message: 'unknown command' }
    }
  }
  return { send, sent }
}

const creds = { ssid: 'Venue', pass: 'pw-1234' }

describe('setWifiCommand', () => {
  it('sends the password as pass, and leaves it out for an open network', () => {
    expect(setWifiCommand(creds)).toEqual({ cmd: 'set_wifi', ssid: 'Venue', pass: 'pw-1234' })
    expect(setWifiCommand({ ssid: 'Open', pass: '' })).toEqual({ cmd: 'set_wifi', ssid: 'Open' })
    expect(setWifiCommand({ ssid: 'Open' })).toEqual({ cmd: 'set_wifi', ssid: 'Open' })
  })
})

describe('askInfoWithRetry', () => {
  it('waits out a device that is still booting', async () => {
    const c = clock()
    const dev = fakeDevice({ now: c.now, bootingInfoCalls: 2 })
    const r = await askInfoWithRetry(dev.send, timing, c)
    expect(r?.status).toBe('ok')
    expect(dev.sent.filter((x) => x.cmd === 'get_info')).toHaveLength(3)
  })

  it('gives up after the attempts (no firmware)', async () => {
    const c = clock()
    const dev = fakeDevice({ now: c.now, bootingInfoCalls: 99 })
    expect(await askInfoWithRetry(dev.send, timing, c)).toBeNull()
  })
})

describe('sendSetWifi', () => {
  it('accepts the firmware reply', async () => {
    const c = clock()
    const dev = fakeDevice({ now: c.now, saveOnSet: true })
    expect(await sendSetWifi(dev.send, creds, timing, c)).toBeNull()
  })

  it('sends once more when the first set_wifi goes unanswered', async () => {
    const c = clock()
    const dev = fakeDevice({ now: c.now, saveOnSet: true, dropSetWifi: 1 })
    expect(await sendSetWifi(dev.send, creds, timing, c)).toBeNull()
    expect(dev.sent.filter((x) => x.cmd === 'set_wifi')).toHaveLength(2)
  })

  it('never counts a missing reply as sent', async () => {
    const c = clock()
    const dev = fakeDevice({ now: c.now, saveOnSet: true, dropSetWifi: 2 })
    expect(await sendSetWifi(dev.send, creds, timing, c)).toEqual({ kind: 'failed', reason: 'no_reply' })
  })

  it('reports a refusal with the firmware message', async () => {
    const c = clock()
    const dev = fakeDevice({ now: c.now, setWifiReply: { status: 'error', message: 'missing ssid' } })
    expect(await sendSetWifi(dev.send, creds, timing, c))
      .toEqual({ kind: 'failed', reason: 'rejected', detail: 'missing ssid' })
  })

  it('reports a dropped connection', async () => {
    const c = clock()
    const dev = fakeDevice({ now: c.now, closed: true })
    expect(await sendSetWifi(dev.send, creds, timing, c)).toEqual({ kind: 'failed', reason: 'lost' })
  })
})

describe('profileListHas', () => {
  it('needs the SSID, and a stored password when one was written', () => {
    const list = { profiles: [{ ssid: 'Venue', has_pass: false }, { ssid: 'Office', has_pass: true }] }
    expect(profileListHas(list, { ssid: 'Office', pass: 'x' })).toBe(true)
    expect(profileListHas(list, { ssid: 'Venue', pass: 'x' })).toBe(false)
    expect(profileListHas(list, { ssid: 'Venue' })).toBe(true)
    expect(profileListHas(list, { ssid: 'Other' })).toBe(false)
    expect(profileListHas({}, { ssid: 'Venue' })).toBe(false)
  })
})

/** set_wifi through the fake device, then the read-back. */
async function writeAndConfirm(dev: ReturnType<typeof fakeDevice>, c: ReturnType<typeof clock>) {
  expect(await sendSetWifi(dev.send, creds, timing, c)).toBeNull()
  return confirmWifiSaved(dev.send, creds, c.now(), timing, c)
}

describe('confirmWifiSaved', () => {
  it('saved and connected (firmware 1.0.0+)', async () => {
    const c = clock()
    const dev = fakeDevice({ now: c.now, saveOnSet: true, connectAfterMs: 3000 })
    expect(await writeAndConfirm(dev, c)).toEqual({ kind: 'connected', ip: '192.168.1.42' })
    expect(c.now()).toBeGreaterThanOrEqual(3000)
    expect(c.now()).toBeLessThan(timing.connectWaitMs)
  })

  it('saved but not connected: reported as saved once the connect wait has passed', async () => {
    const c = clock()
    const dev = fakeDevice({ now: c.now, saveOnSet: true })
    expect(await writeAndConfirm(dev, c)).toEqual({ kind: 'saved' })
    expect(c.now()).toBeGreaterThanOrEqual(timing.connectWaitMs)
  })

  it('older firmware: keeps reading until it connects and saves', async () => {
    const c = clock()
    const dev = fakeDevice({ now: c.now, saveOnSet: false, connectAfterMs: 8000 })
    expect(await writeAndConfirm(dev, c)).toEqual({ kind: 'connected', ip: '192.168.1.42' })
  })

  it('times out when the network never shows up (older firmware, wrong password)', async () => {
    const c = clock()
    const dev = fakeDevice({ now: c.now, saveOnSet: false })
    expect(await writeAndConfirm(dev, c)).toEqual({ kind: 'failed', reason: 'not_saved' })
    expect(c.now()).toBeGreaterThanOrEqual(timing.saveTimeoutMs)
  })

  it('no reply to any read-back is a failure, not a success', async () => {
    const c = clock()
    const silent: SerialSend = async () => { c.advance(timing.pollTimeoutMs); throw new Error('serial timeout: x') }
    expect(await confirmWifiSaved(silent, creds, 0, timing, c)).toEqual({ kind: 'failed', reason: 'no_reply' })
  })

  it('a dropped connection before it was saved is a failure', async () => {
    const c = clock()
    const dev = fakeDevice({ now: c.now, closed: true })
    expect(await confirmWifiSaved(dev.send, creds, 0, timing, c)).toEqual({ kind: 'failed', reason: 'lost' })
  })
})

describe('summarizeWifiOutcomes', () => {
  it('counts each kind', () => {
    expect(summarizeWifiOutcomes([
      { kind: 'connected', ip: '1.2.3.4' },
      { kind: 'saved' },
      { kind: 'failed', reason: 'no_reply' },
      { kind: 'connected' },
    ])).toEqual({ total: 4, connected: 2, savedOnly: 1, failed: 1 })
  })
})
