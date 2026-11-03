import { describe, expect, it, vi } from 'vitest'
import type { ManagerMessage } from '@/types/manager'
import { LiveStream, floatToPcm16, LIVE_CHUNK_FRAMES, LIVE_PREROLL_CHUNKS } from '@/utils/liveStream'
import { isStreamOpen } from '@/utils/openStreams'

function fakeChannel() {
  const sent: ManagerMessage[] = []
  const listeners = new Set<(message: ManagerMessage) => void>()
  return {
    sent,
    listeners,
    channel: {
      send: (message: ManagerMessage) => { sent.push(message) },
      subscribe: (listener: (message: ManagerMessage) => void) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    emit(message: ManagerMessage) {
      for (const listener of [...listeners]) listener(message)
    },
  }
}

const chunk = () => new Int16Array(LIVE_CHUNK_FRAMES * 2)

describe('floatToPcm16', () => {
  it('scales, saturates and reports the peak', () => {
    const { pcm, peak } = floatToPcm16(new Float32Array([0, 0.5, -0.5, 1, -1, 1.5, -2]))
    expect(Array.from(pcm)).toEqual([0, 16384, -16383, 32767, -32767, 32767, -32768])
    expect(peak).toBe(1)
    expect(floatToPcm16(new Float32Array([0.25, -0.125])).peak).toBe(0.25)
  })

  it('applies the gain, scaling only at or below 1 and rounding a boost off above 0.95', () => {
    expect(Array.from(floatToPcm16(new Float32Array([0.5, -1]), 0.5).pcm)).toEqual([8192, -16383])
    const boosted = floatToPcm16(new Float32Array([0.4, 0.5, -0.5, 0.9]), 2)
    expect(boosted.pcm[0]).toBe(Math.round(0.8 * 32767)) // below the knee: unchanged
    expect(boosted.pcm[1]).toBe(Math.round((0.95 + 0.05 * Math.tanh(1)) * 32767)) // 1.0 rounded off, not cut flat
    expect(boosted.pcm[2]).toBe(-boosted.pcm[1])
    expect(boosted.pcm[3]).toBeLessThanOrEqual(32767) // 1.8 stays in range
    expect(boosted.peak).toBe(1) // meter: the level before the knee, capped
    expect(floatToPcm16(new Float32Array([0.9]), 0).pcm[0]).toBe(0)
  })
})

describe('LiveStream', () => {
  it('begins once on the named devices, then sends each chunk with a growing offset', () => {
    const helper = fakeChannel()
    const stream = new LiveStream(helper.channel, vi.fn())
    stream.setTargets(['10.0.0.2', '10.0.0.3'])
    stream.setTargets(['10.0.0.3', '10.0.0.2']) // same devices: no restart
    stream.push(chunk())
    stream.push(chunk())
    const [begin, ...data] = helper.sent
    expect(helper.sent).toHaveLength(1 + LIVE_PREROLL_CHUNKS + 2)
    expect(begin.type).toBe('stream_begin')
    expect(begin.payload).toMatchObject({
      sample_rate: 16000, channels: 2, format: 'pcm16', total_samples: 0, targets: ['10.0.0.2', '10.0.0.3'],
    })
    const id = begin.payload.stream_id as string
    expect(isStreamOpen(id)).toBe(true)
    // Silence first (the device's depth), then the chunks, one packet each, offsets in bytes.
    data.forEach((m, i) => {
      expect(m.type).toBe('stream_data')
      expect(m.payload).toMatchObject({ stream_id: id, offset: i * LIVE_CHUNK_FRAMES * 4, targets: ['10.0.0.2', '10.0.0.3'] })
      expect(atob(m.payload.data as string)).toHaveLength(LIVE_CHUNK_FRAMES * 4)
    })
    expect(/^\0+$/.test(atob(data[0].payload.data as string))).toBe(true)
    stream.dispose()
    expect(helper.sent[helper.sent.length - 1]).toMatchObject({ type: 'stream_end', payload: { stream_id: id, targets: ['10.0.0.2', '10.0.0.3'] } })
    expect(isStreamOpen(id)).toBe(false)
    expect(helper.listeners.size).toBe(0)
  })

  it('never sends a stream without devices (the helper would reach every device)', () => {
    const helper = fakeChannel()
    const stream = new LiveStream(helper.channel, vi.fn())
    stream.setTargets([])
    stream.push(chunk())
    expect(helper.sent).toHaveLength(0)
    expect(stream.active).toBe(false)
  })

  it('moves to new devices on a new stream, and ends with no devices', () => {
    const helper = fakeChannel()
    const stream = new LiveStream(helper.channel, vi.fn())
    stream.setTargets(['10.0.0.2'])
    const first = helper.sent[0].payload.stream_id
    stream.setTargets(['10.0.0.4'])
    const control = helper.sent.filter((m) => m.type !== 'stream_data')
    expect(control.map((m) => m.type)).toEqual(['stream_begin', 'stream_end', 'stream_begin'])
    expect(control[1].payload).toMatchObject({ stream_id: first, targets: ['10.0.0.2'] })
    expect(control[2].payload.stream_id).not.toBe(first)
    expect(control[2].payload.targets).toEqual(['10.0.0.4'])
    // The new stream starts its own silence and offsets from 0.
    const second = helper.sent.slice(helper.sent.indexOf(control[2]) + 1)
    expect(second.map((m) => m.payload.offset)).toEqual(Array.from({ length: LIVE_PREROLL_CHUNKS }, (_, i) => i * LIVE_CHUNK_FRAMES * 4))
    stream.setTargets([])
    expect(helper.sent[helper.sent.length - 1].type).toBe('stream_end')
    expect(stream.active).toBe(false)
  })

  it('keeps going while a device is left, and is lost once another stream took them all', () => {
    const helper = fakeChannel()
    const onLost = vi.fn()
    const stream = new LiveStream(helper.channel, onLost)
    stream.setTargets(['10.0.0.2', '10.0.0.3'])
    const id = helper.sent[0].payload.stream_id
    helper.emit({ type: 'stream_displaced', payload: { stream_id: 'other', targets: ['10.0.0.2', '10.0.0.3'] } })
    helper.emit({ type: 'stream_displaced', payload: { stream_id: id, targets: ['10.0.0.2'], by: 'x', same_client: false } })
    expect(onLost).not.toHaveBeenCalled()
    helper.emit({ type: 'stream_displaced', payload: { stream_id: id, targets: ['10.0.0.3'], by: 'x', same_client: true } })
    expect(onLost).toHaveBeenCalledWith('displaced')
    const count = helper.sent.length
    stream.push(chunk())
    stream.dispose() // no END: the helper routes it nowhere
    expect(helper.sent).toHaveLength(count)
  })

  it('is lost when the helper starts it on no device or holds no session for it', () => {
    for (const [ack, reason] of [
      [{ status: 'no_target', deferred: ['10.0.0.2'] }, 'unreachable'],
      [{ status: 'ok', targets: [], deferred: ['10.0.0.2'] }, 'unreachable'],
      [{ status: 'no_session' }, 'no_session'],
    ] as const) {
      const helper = fakeChannel()
      const onLost = vi.fn()
      const stream = new LiveStream(helper.channel, onLost)
      stream.setTargets(['10.0.0.2'])
      helper.emit({ type: 'stream_ack', payload: { ...ack, stream_id: helper.sent[0].payload.stream_id } })
      expect(onLost).toHaveBeenCalledWith(reason)
      expect(stream.active).toBe(false)
    }
  })

  it('carries on when only some devices were deferred', () => {
    const helper = fakeChannel()
    const onLost = vi.fn()
    const stream = new LiveStream(helper.channel, onLost)
    stream.setTargets(['10.0.0.2', '10.0.0.3'])
    const id = helper.sent[0].payload.stream_id
    helper.emit({ type: 'stream_ack', payload: { status: 'ok', stream_id: id, targets: ['10.0.0.2'], deferred: ['10.0.0.3'] } })
    expect(onLost).not.toHaveBeenCalled()
    expect(stream.active).toBe(true)
  })
})

describe('LiveStream (1.x helper)', () => {
  it('asks the helper to take the devices back (the user starts it)', () => {
    const helper = fakeChannel()
    const stream = new LiveStream(helper.channel, vi.fn())
    stream.setTargets(['10.0.0.2'])
    expect(helper.sent[0]).toMatchObject({ type: 'stream_begin', payload: { takeover: true } })
    stream.setTargets(['10.0.0.3'])
    expect(helper.sent.filter((m) => m.type === 'stream_begin').every((m) => m.payload.takeover === true)).toBe(true)
  })

  it('stream_lost removes devices; once none is left it is lost with the reason', () => {
    const helper = fakeChannel()
    const onLost = vi.fn()
    const stream = new LiveStream(helper.channel, onLost)
    stream.setTargets(['10.0.0.2', '10.0.0.3'])
    const id = helper.sent[0].payload.stream_id as string
    helper.emit({ type: 'stream_lost', payload: { stream_id: 'other', targets: ['10.0.0.2', '10.0.0.3'], reason: 'stopped' } })
    expect(stream.active).toBe(true)
    helper.emit({ type: 'stream_lost', payload: { stream_id: id, targets: ['10.0.0.2'], reason: 'device_rebooted' } })
    expect(stream.active).toBe(true)
    expect(onLost).not.toHaveBeenCalled()
    const before = helper.sent.length
    helper.emit({ type: 'stream_lost', payload: { stream_id: id, targets: ['10.0.0.3'], reason: 'stopped' } })
    expect(onLost).toHaveBeenCalledWith('lost', 'stopped')
    expect(stream.active).toBe(false)
    expect(isStreamOpen(id)).toBe(false)
    expect(helper.sent.length).toBe(before) // no END: the helper already ended it
  })
})
