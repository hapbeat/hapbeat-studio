import { describe, it, expect } from 'vitest'
import { openConfigConnection } from './serialConfig'

/**
 * Minimal fake `SerialPort` for `openConfigConnection`'s internal read loop.
 * `push(line)` feeds one raw line (with trailing `\n`) into the read stream,
 * either resolving an in-flight `reader.read()` immediately or queuing it for
 * the next call — this lets a test interleave unsolicited event lines with a
 * pending command's real reply, exactly like the firmware does on hardware.
 */
function makeFakePort(vid = 0x303a) {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  let pendingResolve: ((v: { value?: Uint8Array; done: boolean }) => void) | null = null
  const queue: Array<{ value?: Uint8Array; done: boolean }> = []
  let cancelled = false

  const push = (line: string) => {
    const chunk = { value: encoder.encode(line), done: false }
    if (pendingResolve) {
      const r = pendingResolve
      pendingResolve = null
      r(chunk)
    } else {
      queue.push(chunk)
    }
  }

  const reader = {
    read: (): Promise<{ value?: Uint8Array; done: boolean }> => {
      if (queue.length > 0) return Promise.resolve(queue.shift()!)
      if (cancelled) return Promise.resolve({ done: true })
      return new Promise((resolve) => { pendingResolve = resolve })
    },
    cancel: async () => {
      cancelled = true
      if (pendingResolve) {
        const r = pendingResolve
        pendingResolve = null
        r({ done: true })
      }
    },
    releaseLock: () => {},
  }

  const written: string[] = []
  const writer = {
    write: (bytes: Uint8Array) => {
      written.push(decoder.decode(bytes))
      return Promise.resolve()
    },
    releaseLock: () => {},
  }

  const port = {
    readable: { getReader: () => reader },
    writable: { getWriter: () => writer },
    open: () => Promise.resolve(),
    close: () => Promise.resolve(),
    getInfo: () => ({ usbVendorId: vid, usbProductId: 0x1001 }),
    setSignals: () => Promise.resolve(),
  }

  return { port: port as unknown as SerialPort, push, written }
}

describe('openConfigConnection — response matching robustness', () => {
  it('resolves a pending get_info to the real "status" reply, not an interleaved "event" push', async () => {
    const { port, push } = makeFakePort()
    const conn = await openConfigConnection(port)
    try {
      const reply = conn.send({ cmd: 'get_info' }, { timeoutMs: 2000 })
      // Firmware (e.g. DuoWL v4 espnow_stream, knob resting at a step
      // boundary) pushes these unsolicited at several Hz — they must not
      // win the FIFO race against the actual get_info response.
      push('{"event":"volume_changed","volume_level":5,"volume_wiper":80,"volume_steps":16}\n')
      push('{"event":"volume_changed","volume_level":6,"volume_wiper":85,"volume_steps":16}\n')
      push('{"status":"ok","name":"duo1","transport":"espnow_stream","fw":"0.5.0"}\n')
      const result = await reply
      expect(result.status).toBe('ok')
      expect(result.transport).toBe('espnow_stream')
    } finally {
      await conn.close()
    }
  })

  it('forwards event lines to onLog instead of dropping or misrouting them', async () => {
    const logs: string[] = []
    const { port, push } = makeFakePort()
    const conn = await openConfigConnection(port, { onLog: (l) => logs.push(l) })
    try {
      push('{"event":"volume_changed","volume_level":1,"volume_wiper":10,"volume_steps":16}\n')
      // Give the read-loop microtask a tick to dispatch the line.
      await new Promise((r) => setTimeout(r, 0))
      expect(logs.some((l) => l.includes('volume_changed'))).toBe(true)
    } finally {
      await conn.close()
    }
  })

  it('a second get_info still resolves correctly after event spam consumed no waiter', async () => {
    const { port, push } = makeFakePort()
    const conn = await openConfigConnection(port)
    try {
      push('{"event":"volume_changed","volume_level":2,"volume_wiper":20,"volume_steps":16}\n')
      await new Promise((r) => setTimeout(r, 0))
      const reply = conn.send({ cmd: 'get_info' }, { timeoutMs: 2000 })
      push('{"event":"volume_changed","volume_level":3,"volume_wiper":30,"volume_steps":16}\n')
      push('{"status":"ok","name":"duo2","transport":"espnow_stream"}\n')
      const result = await reply
      expect(result.name).toBe('duo2')
    } finally {
      await conn.close()
    }
  })
})
