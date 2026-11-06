/**
 * Write one Wi-Fi network to one Hapbeat over its USB serial config
 * connection and confirm it by reading it back. The steps of the
 * "選択中の N 台に書き込む" bulk write in the Wi-Fi tab
 * (serialMaster.bulkSetWifi), kept free of Web Serial so they can be tested
 * with a fake `send`.
 *
 * What the firmware does (hapbeat-device-firmware src/serial_config.cpp
 * cmdSetWifi, src/wifi_manager.cpp wifiManagerSetCredentials):
 *  - set_wifi never restarts the device. It switches the connection in place
 *    and answers {"status":"ok"} straight away, in every firmware version.
 *  - Firmware 1.0.0+ saves the network when set_wifi arrives. Older firmware
 *    saves it only after it has associated, a few seconds later.
 *  - An ESP32-S3 resets when the host closes its USB CDC port, so the port
 *    has to stay open until the network is saved. The old bulk write closed
 *    the port right after the reply, which lost the network on older firmware.
 *  - A classic ESP32 behind a USB-serial bridge resets when its port is
 *    opened and reads commands only ~1 s later, so a command sent at once is
 *    lost. Ask get_info until it answers before sending set_wifi.
 *
 * Success means the network was read back from list_wifi_profiles. A reply,
 * or no reply, to set_wifi does not prove anything.
 */

/** The `send` of a serial config connection (serialConfig.ts). */
export type SerialSend = (
  cmd: Record<string, unknown>,
  opts?: { timeoutMs?: number },
) => Promise<Record<string, unknown>>

export interface WifiCredentials {
  ssid: string
  /** Empty or absent = open network (no `pass` is sent). */
  pass?: string
}

export type WifiWriteFailure =
  /** The USB port could not be opened. */
  | 'open'
  /** The device never answered (no firmware, still booting, wrong cable). */
  | 'no_reply'
  /** The firmware answered set_wifi with an error. */
  | 'rejected'
  /** The device answers, but the network never showed up in its list. */
  | 'not_saved'
  /** The connection dropped (cable pulled, device restarted) before the
   *  network was confirmed. */
  | 'lost'

export type WifiWriteOutcome =
  /** Saved, and the device connected to it. */
  | { kind: 'connected'; ip?: string }
  /** Saved, but not connected within `connectWaitMs` (wrong password, out of
   *  range, or a network for another place). */
  | { kind: 'saved' }
  | { kind: 'failed'; reason: WifiWriteFailure; detail?: string }

export interface WifiWriteTiming {
  /** get_info reply timeout per attempt. */
  infoTimeoutMs: number
  infoAttempts: number
  /** Gap between get_info attempts. */
  infoGapMs: number
  /** set_wifi reply timeout (it is answered within tens of ms). */
  setTimeoutMs: number
  /** Read-back interval and per-command timeout. */
  pollMs: number
  pollTimeoutMs: number
  /** Give up when the network is still not in the list this long after
   *  set_wifi. Older firmware saves only once associated (the first attempt
   *  plus 5 s retries, wifi_manager.cpp RETRY_INTERVAL_MS). */
  saveTimeoutMs: number
  /** After it is saved, wait this long (from set_wifi) for the connection
   *  before reporting "saved, not connected". */
  connectWaitMs: number
}

export const WIFI_WRITE_TIMING: WifiWriteTiming = {
  // Same budget as the single-device connect (serialMaster attachConfigConn):
  // a just-reset ESP32 reaches its loop in ~1 s.
  infoTimeoutMs: 1200,
  infoAttempts: 3,
  infoGapMs: 200,
  setTimeoutMs: 3000,
  pollMs: 600,
  pollTimeoutMs: 1500,
  saveTimeoutMs: 20000,
  connectWaitMs: 15000,
}

export interface WifiWriteDeps {
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** The conn is gone (serialConfig rejects with "...connection closed"). */
function isClosedError(err: unknown): boolean {
  return /closed/i.test((err as Error)?.message ?? String(err))
}

/**
 * get_info with retries. Resolves to the reply, or null when the device
 * never answered.
 */
export async function askInfoWithRetry(
  send: SerialSend,
  timing: Pick<WifiWriteTiming, 'infoTimeoutMs' | 'infoAttempts' | 'infoGapMs'> = WIFI_WRITE_TIMING,
  deps: WifiWriteDeps = {},
): Promise<Record<string, unknown> | null> {
  const sleep = deps.sleep ?? defaultSleep
  for (let attempt = 0; attempt < timing.infoAttempts; attempt++) {
    try {
      return await send({ cmd: 'get_info' }, { timeoutMs: timing.infoTimeoutMs })
    } catch (err) {
      if (isClosedError(err)) return null
      if (attempt < timing.infoAttempts - 1) await sleep(timing.infoGapMs)
    }
  }
  return null
}

/** The set_wifi command for these credentials. `pass` is left out for an
 *  open network (the firmware reads only `pass`). */
export function setWifiCommand(creds: WifiCredentials): Record<string, unknown> {
  const pass = creds.pass ?? ''
  return { cmd: 'set_wifi', ssid: creds.ssid, ...(pass.length > 0 ? { pass } : {}) }
}

/**
 * Send set_wifi. Resolves to null once the firmware accepted it, or to a
 * failure. An unanswered set_wifi is sent once more after the device has
 * answered get_info; still no reply is a failure, never "sent".
 */
export async function sendSetWifi(
  send: SerialSend,
  creds: WifiCredentials,
  timing: WifiWriteTiming = WIFI_WRITE_TIMING,
  deps: WifiWriteDeps = {},
): Promise<WifiWriteOutcome | null> {
  const cmd = setWifiCommand(creds)
  for (let attempt = 0; attempt < 2; attempt++) {
    let r: Record<string, unknown>
    try {
      r = await send(cmd, { timeoutMs: timing.setTimeoutMs })
    } catch (err) {
      if (isClosedError(err)) return { kind: 'failed', reason: 'lost' }
      if (attempt === 0 && (await askInfoWithRetry(send, timing, deps)) !== null) continue
      return { kind: 'failed', reason: 'no_reply' }
    }
    if (r.status === 'ok') return null
    const detail = String(r.message ?? r.error ?? r.status ?? '')
    return { kind: 'failed', reason: 'rejected', detail }
  }
  return { kind: 'failed', reason: 'no_reply' }
}

/** True when `profiles` (a list_wifi_profiles reply) holds the network. A
 *  network written with a password must be stored with one. */
export function profileListHas(reply: Record<string, unknown>, creds: WifiCredentials): boolean {
  const profiles = Array.isArray(reply.profiles) ? (reply.profiles as Array<Record<string, unknown>>) : []
  const withPass = (creds.pass ?? '').length > 0
  return profiles.some((p) => p.ssid === creds.ssid && (!withPass || p.has_pass !== false))
}

/**
 * Read the network back until it is saved, and keep reading until it also
 * connects or `connectWaitMs` has passed. `startedAt` is when set_wifi was
 * accepted (deps.now's clock). The caller must keep the port open until this
 * resolves (an S3 resets on close).
 */
export async function confirmWifiSaved(
  send: SerialSend,
  creds: WifiCredentials,
  startedAt: number,
  timing: WifiWriteTiming = WIFI_WRITE_TIMING,
  deps: WifiWriteDeps = {},
): Promise<WifiWriteOutcome> {
  const sleep = deps.sleep ?? defaultSleep
  const now = deps.now ?? Date.now
  let saved = false
  let answered = false
  for (;;) {
    let closed = false
    try {
      const list = await send({ cmd: 'list_wifi_profiles' }, { timeoutMs: timing.pollTimeoutMs })
      answered = true
      if (profileListHas(list, creds)) saved = true
    } catch (err) {
      closed = isClosedError(err)
    }
    if (!closed) {
      try {
        const st = await send({ cmd: 'get_wifi_status' }, { timeoutMs: timing.pollTimeoutMs })
        answered = true
        if (saved && st.connected === true && st.ssid === creds.ssid) {
          const ip = typeof st.ip === 'string' && st.ip ? st.ip : undefined
          return { kind: 'connected', ip }
        }
      } catch (err) {
        closed = isClosedError(err)
      }
    }
    if (closed) return saved ? { kind: 'saved' } : { kind: 'failed', reason: 'lost' }
    const elapsed = now() - startedAt
    if (saved && elapsed >= timing.connectWaitMs) return { kind: 'saved' }
    if (!saved && elapsed >= timing.saveTimeoutMs) {
      return { kind: 'failed', reason: answered ? 'not_saved' : 'no_reply' }
    }
    await sleep(timing.pollMs)
  }
}

/** Counts for the summary toast. */
export interface WifiBulkSummary {
  total: number
  connected: number
  /** Saved but not connected. */
  savedOnly: number
  failed: number
}

export function summarizeWifiOutcomes(outcomes: WifiWriteOutcome[]): WifiBulkSummary {
  return {
    total: outcomes.length,
    connected: outcomes.filter((o) => o.kind === 'connected').length,
    savedOnly: outcomes.filter((o) => o.kind === 'saved').length,
    failed: outcomes.filter((o) => o.kind === 'failed').length,
  }
}
