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
 * Distinct from the firmware-flash port picker so the browser
 * remembers each separately.
 */
export async function pickConfigPort(): Promise<SerialPort> {
  if (!isWebSerialSupported()) {
    throw new Error('Web Serial API is not supported (Chrome / Edge を使ってください)')
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

  const dispatchLine = (line: string) => {
    const trimmed = line.replace(/\r$/, '').trim()
    if (!trimmed) return
    if (trimmed.startsWith('{')) {
      // JSON line — send to next waiter.
      try {
        const obj = JSON.parse(trimmed)
        const w = waiters.shift()
        if (w) {
          if (w.timer) clearTimeout(w.timer)
          w.resolve(obj as Record<string, unknown>)
        } else {
          // Unsolicited JSON (firmware push) — forward as a log line.
          cb.onLog?.(trimmed)
        }
      } catch (err) {
        cb.onLog?.(`(parse error) ${trimmed}`)
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
      // 5 s default timeout — firmware should answer within a few
      // hundred ms for every config command. set_wifi may take longer
      // because of the connect attempt, but it returns "ok" before
      // the actual association.
      const timer = setTimeout(() => {
        const idx = waiters.findIndex((w) => w.resolve === resolve)
        if (idx >= 0) waiters.splice(idx, 1)
        reject(new Error(`serial timeout: ${JSON.stringify(cmd).slice(0, 60)}`))
      }, 5000)
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
