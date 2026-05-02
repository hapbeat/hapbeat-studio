/**
 * USB Serial config protocol — line-based JSON over Web Serial.
 *
 * Mirrors the firmware's `serial_config` interface (and matches the TCP
 * 7701 JSON protocol). Used for initial Wi-Fi provisioning when the
 * device isn't on the network yet, plus name / group changes that the
 * user might prefer to do over a wired link.
 *
 * Wire format:
 *   - 921600 baud, 8N1
 *   - Newline-terminated JSON: each command is `{...}\n`, each
 *     response is `{...}\n` echoed back (firmware also prints other
 *     debug lines that don't start with `{` — those are forwarded
 *     to `onLog` so the user can see them while we filter them out
 *     of the response queue)
 */

export interface SerialConfigCallbacks {
  /** Called for every non-JSON line the firmware emits (boot logs,
   *  warnings, etc.). Returning JSON lines are dispatched separately. */
  onLog?: (line: string) => void
  /** Called when the connection is closed (port unplugged, user
   *  disconnect, error). */
  onDisconnect?: (reason: string) => void
}

export interface SerialConfigConn {
  port: SerialPort
  send: (cmd: Record<string, unknown>) => Promise<Record<string, unknown>>
  close: () => Promise<void>
}

export function isWebSerialSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serial' in navigator
}

/**
 * Prompt the user to pick a USB-serial device for config commands.
 * Reuses a previously-granted port silently when one is available so
 * the user doesn't have to re-confirm the same COM port across the
 * Serial connect → Firmware flash flow. Pass `forcePicker: true` to
 * always show the picker (useful when the user has multiple Hapbeats
 * plugged in and needs to switch).
 */
export async function pickConfigPort(
  opts: { forcePicker?: boolean } = {},
): Promise<SerialPort> {
  if (!isWebSerialSupported()) {
    throw new Error('Web Serial API is not supported (Chrome / Edge を使ってください)')
  }
  if (!opts.forcePicker) {
    try {
      const ports = await navigator.serial.getPorts()
      if (ports.length > 0) return ports[ports.length - 1]
    } catch { /* fall through to picker */ }
  }
  return navigator.serial.requestPort({})
}

/**
 * Open a SerialPort + start the line-reader loop. Returns a connection
 * handle with a request/response `send` method. The reader runs as
 * long as the port is open — `close()` cancels it and releases the
 * port lock.
 */
export async function openConfigConnection(
  port: SerialPort,
  cb: SerialConfigCallbacks = {},
): Promise<SerialConfigConn> {
  await port.open({ baudRate: 921600 })

  const decoder = new TextDecoder()
  let buf = ''
  let closed = false

  // Pending response promises waiting for the next JSON line. We
  // assume the firmware answers one command at a time (no out-of-order
  // responses), so a FIFO of resolvers maps cleanly onto incoming
  // lines.
  const waiters: Array<{
    resolve: (v: Record<string, unknown>) => void
    reject: (e: Error) => void
    timer: ReturnType<typeof setTimeout> | null
  }> = []

  // Multi-line JSON accumulation state.
  //
  // Why this exists: long firmware responses get split when the
  // host newline-splits the byte stream while ESP-IDF tasks emit
  // `[Wifi] event: ...` and other Arduino-ESP32 logs that interleave
  // with our JSON output. The result is:
  //
  //   line 1: `{"status":"ok","networks":[{"ssid":"foo"`
  //   line 2: `[Wifi] event: SCAN_DONE`              ← interleaved log
  //   line 3: `,"rssi":-40,...]}`
  //
  // The previous parser tried to JSON.parse line 1 in isolation and
  // failed, dropping the response entirely. Now we track curly-brace
  // depth: when a line starts with `{` we open an accumulator and
  // append every subsequent line until the depth returns to zero,
  // then parse the joined buffer. Interleaved non-JSON lines are
  // still routed to `onLog` so the user sees them.
  let jsonAccumulator: string[] = []
  let jsonDepth = 0
  let inString = false
  let stringEscape = false

  // Walk every character of `s` and update brace-depth bookkeeping.
  // Strings (between `"`s) and `\` escapes are honored so a `{` or
  // `}` inside a string value doesn't move the depth counter.
  const updateDepth = (s: string) => {
    for (let i = 0; i < s.length; i++) {
      const c = s[i]
      if (inString) {
        if (stringEscape) { stringEscape = false; continue }
        if (c === '\\') { stringEscape = true; continue }
        if (c === '"') inString = false
        continue
      }
      if (c === '"') { inString = true; continue }
      if (c === '{') jsonDepth++
      else if (c === '}') jsonDepth = Math.max(0, jsonDepth - 1)
    }
  }

  const tryDeliverJsonBlob = (blob: string) => {
    try {
      const obj = JSON.parse(blob)
      const w = waiters.shift()
      if (w) {
        if (w.timer) clearTimeout(w.timer)
        w.resolve(obj as Record<string, unknown>)
      } else {
        cb.onLog?.(blob)
      }
    } catch {
      cb.onLog?.(`(parse error) ${blob.slice(0, 200)}${blob.length > 200 ? '…' : ''}`)
    }
  }

  // Pattern for log noise the firmware emits during long operations
  // (NVS `nvs_get_str` failures, ArduinoOTA notices, etc.). Lines
  // matching this are sent to onLog and EXCLUDED from the JSON
  // accumulator — otherwise they'd corrupt the JSON byte sequence
  // and break the parser even with brace-depth tracking, because
  // string-payload `"`s in those logs can flip our in-string state.
  //
  // Heuristic: any line that does NOT contain JSON-shape tokens we
  // care about (`"`, `{`, `}`, `[`, `]`, `:`) is unlikely to be a
  // genuine JSON continuation. ESP-IDF logs usually start with
  // `[<ts>][<lvl>]` brackets but also include free-text after them.
  // The simplest safe filter: lines starting with `[` (ESP-IDF log
  // header) or `E (` / `W (` / `I (` are always log noise.
  const looksLikeFirmwareLog = (s: string) => /^[\[]\s*\d|^[EWID]\s\(\d/.test(s)

  const dispatchLine = (line: string) => {
    const trimmed = line.replace(/\r$/, '').trim()
    if (!trimmed) return

    // Always route obvious firmware log lines straight to onLog —
    // even when we're mid-JSON-accumulation. Preventing them from
    // entering the accumulator keeps brace-depth + in-string
    // bookkeeping correct.
    if (looksLikeFirmwareLog(trimmed)) {
      cb.onLog?.(trimmed)
      return
    }

    // Already inside a multi-line JSON: keep appending until depth
    // returns to 0.
    if (jsonAccumulator.length > 0) {
      jsonAccumulator.push(trimmed)
      updateDepth(trimmed)
      if (jsonDepth === 0) {
        const blob = jsonAccumulator.join('')
        jsonAccumulator = []
        inString = false
        stringEscape = false
        tryDeliverJsonBlob(blob)
      }
      return
    }

    if (trimmed.startsWith('{')) {
      jsonDepth = 0
      inString = false
      stringEscape = false
      updateDepth(trimmed)
      if (jsonDepth === 0) {
        // Single-line JSON — fast path, no accumulation needed.
        tryDeliverJsonBlob(trimmed)
      } else {
        jsonAccumulator = [trimmed]
      }
    } else {
      cb.onLog?.(trimmed)
    }
  }

  const reader = port.readable!.getReader()
  ;(async () => {
    try {
      while (!closed) {
        const { value, done } = await reader.read()
        if (done) break
        if (value) {
          buf += decoder.decode(value, { stream: true })
          let idx: number
          while ((idx = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, idx)
            buf = buf.slice(idx + 1)
            dispatchLine(line)
          }
        }
      }
    } catch (err) {
      if (!closed) cb.onDisconnect?.(`read error: ${(err as Error).message}`)
    } finally {
      try { reader.releaseLock() } catch { /* already released */ }
      // Reject any pending waiters so callers don't hang.
      while (waiters.length) {
        const w = waiters.shift()!
        if (w.timer) clearTimeout(w.timer)
        w.reject(new Error('serial connection closed'))
      }
    }
  })()

  const writer = port.writable!.getWriter()
  const enc = new TextEncoder()

  const send = (cmd: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (closed) return Promise.reject(new Error('connection closed'))
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      // 2 s default timeout — firmware answers within tens of ms for
      // all config commands. The onboarding wizard treats a timeout
      // as "no firmware" and routes to flash. (Wi-Fi SSID scan was
      // previously routed via Serial with a 12 s timeout; we now
      // unify all scans through Helper, so this commented-out branch
      // doesn't apply anymore.)
      const timeoutMs = 2000
      const timer = setTimeout(() => {
        const idx = waiters.findIndex((w) => w.resolve === resolve)
        if (idx >= 0) waiters.splice(idx, 1)
        reject(new Error(`serial timeout: ${JSON.stringify(cmd).slice(0, 60)}`))
      }, timeoutMs)
      waiters.push({ resolve, reject, timer })
      const line = JSON.stringify(cmd) + '\n'
      writer.write(enc.encode(line)).catch((err) => {
        const idx = waiters.findIndex((w) => w.resolve === resolve)
        if (idx >= 0) waiters.splice(idx, 1)
        clearTimeout(timer)
        reject(err)
      })
    })
  }

  const close = async () => {
    if (closed) return
    closed = true
    try { await reader.cancel() } catch { /* already cancelled */ }
    try { writer.releaseLock() } catch { /* released */ }
    try { await port.close() } catch { /* already closed */ }
    cb.onDisconnect?.('user disconnect')
  }

  return { port, send, close }
}
