import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ManagerMessage } from '@/types/manager'
import { streamClip, StreamLostError } from './audioStreamer'
import { isStreamOpen } from './openStreams'

class FakeAudioBuffer {
  /** Frames of the decoded clip (a longer one streams for a while, paced at real time). */
  static frames = 4
  readonly numberOfChannels = 2
  readonly length = FakeAudioBuffer.frames
  readonly sampleRate = 16000

  getChannelData(): Float32Array {
    return FakeAudioBuffer.frames === 4 ? new Float32Array([0.1, -0.1, 0.2, -0.2]) : new Float32Array(FakeAudioBuffer.frames)
  }
}

class FakeOfflineAudioContext {
  static constructions = 0
  readonly destination = {}

  constructor() {
    FakeOfflineAudioContext.constructions += 1
  }

  async decodeAudioData(): Promise<AudioBuffer> {
    return new FakeAudioBuffer() as unknown as AudioBuffer
  }

  createBufferSource() {
    return {
      buffer: null as AudioBuffer | null,
      connect: () => undefined,
      start: () => undefined,
    }
  }

  async startRendering(): Promise<AudioBuffer> {
    return new FakeAudioBuffer() as unknown as AudioBuffer
  }
}

beforeEach(() => {
  FakeOfflineAudioContext.constructions = 0
  FakeAudioBuffer.frames = 4
  vi.stubGlobal('OfflineAudioContext', FakeOfflineAudioContext)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('streamClip sessions', () => {
  it('adds one unique stream_id to begin, data, and end', async () => {
    const messages: ManagerMessage[] = []
    const secondMessages: ManagerMessage[] = []
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' })

    await streamClip(blob, (message) => messages.push(message), { cacheKey: 'session-id-a' })
    await streamClip(blob, (message) => secondMessages.push(message), { cacheKey: 'session-id-a' })

    const ids = messages.map((message) => message.payload.stream_id)
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true)
    expect(new Set(ids).size).toBe(1)
    expect(secondMessages[0]?.payload.stream_id).not.toBe(ids[0])
  })

  it('does not send BEGIN after cancellation during decode', async () => {
    const messages: ManagerMessage[] = []
    const controller = new AbortController()
    controller.abort()

    await expect(streamClip(
      new Blob([new Uint8Array([4, 5, 6])]),
      (message) => messages.push(message),
      { signal: controller.signal, cacheKey: 'already-aborted' },
    )).rejects.toMatchObject({ name: 'AbortError' })

    expect(messages).toEqual([])
  })

  it('reuses decoded and resampled PCM for the same clip cache key', async () => {
    const send = () => undefined
    const first = new Blob([new Uint8Array([7, 8, 9])], { type: 'audio/wav' })
    const secondReadOfSameClip = new Blob([new Uint8Array([7, 8, 9])], { type: 'audio/wav' })

    await streamClip(first, send, { cacheKey: 'kit:event-1' })
    await streamClip(secondReadOfSameClip, send, { cacheKey: 'kit:event-1' })

    // One decode context + one resample context for both calls together.
    expect(FakeOfflineAudioContext.constructions).toBe(2)
  })
})

describe('streamClip lost streams', () => {
  /** A 1 s clip streaming at real time, with the helper's messages delivered by `deliver`. */
  const streaming = () => {
    FakeAudioBuffer.frames = 16000
    const sent: ManagerMessage[] = []
    const listeners = new Set<(message: ManagerMessage) => void>()
    const subscribe = (listener: (message: ManagerMessage) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
    const done = streamClip(new Blob([new Uint8Array([7, 8, 9])]), message => sent.push(message), { subscribe })
    const id = async () => { while (sent.length < 2) await new Promise(resolve => setTimeout(resolve, 5)); return sent[0].payload.stream_id as string }
    return { sent, listeners, done, id, deliver: (message: ManagerMessage) => listeners.forEach(listener => listener(message)) }
  }

  it('stops without END when another client displaces it', async () => {
    const h = streaming(), id = await h.id()
    expect(isStreamOpen(id)).toBe(true)
    h.deliver({ type: 'stream_displaced', payload: { stream_id: id, targets: ['10.0.0.2'], by: 'other', same_client: false } })
    await expect(h.done).rejects.toBeInstanceOf(StreamLostError)
    expect(h.sent.filter(m => m.type !== 'stream_data').map(m => m.type)).toEqual(['stream_begin'])
    expect(isStreamOpen(id)).toBe(false); expect(h.listeners.size).toBe(0)
  })

  it('stops on a no_session ack for its stream', async () => {
    const h = streaming(), id = await h.id()
    h.deliver({ type: 'stream_ack', payload: { stream_id: 'someone-else', status: 'no_session' } })
    h.deliver({ type: 'stream_ack', payload: { stream_id: id, status: 'no_session' } })
    await expect(h.done).rejects.toMatchObject({ name: 'StreamLostError', reason: 'no_session' })
  })

  it('a same-client displacement does not stop it', async () => {
    const h = streaming(), id = await h.id()
    h.deliver({ type: 'stream_displaced', payload: { stream_id: id, targets: ['10.0.0.2'], by: 'scene-1', same_client: true } })
    await h.done
    expect(h.sent[h.sent.length - 1]).toMatchObject({ type: 'stream_end', payload: { stream_id: id } })
  })
})

describe('streamClip pause (stream-session-v2 inactivity timeout)', () => {
  it('ends the stream on pause and resumes on a new stream_id, no session left open without DATA', async () => {
    const sent: ManagerMessage[] = []
    let paused = true
    const done = streamClip(new Blob([new Uint8Array([1])]), message => sent.push(message), { control: { isPaused: () => paused } })
    while (sent.length < 2) await new Promise(resolve => setTimeout(resolve, 5))
    const first = sent[0].payload.stream_id as string
    expect(sent.map(m => m.type)).toEqual(['stream_begin', 'stream_end'])
    expect(sent[1].payload.stream_id).toBe(first); expect(isStreamOpen(first)).toBe(false)
    paused = false
    await done
    expect(sent.map(m => m.type)).toEqual(['stream_begin', 'stream_end', 'stream_begin', 'stream_data', 'stream_end'])
    const second = sent[2].payload.stream_id
    expect(second).not.toBe(first)
    expect(sent.slice(2).every(m => m.payload.stream_id === second)).toBe(true)
  })

  it('an abort during the pause sends no second END', async () => {
    const sent: ManagerMessage[] = [], controller = new AbortController()
    const done = streamClip(new Blob([new Uint8Array([2])]), message => sent.push(message), { signal: controller.signal, control: { isPaused: () => true } })
    while (sent.length < 2) await new Promise(resolve => setTimeout(resolve, 5))
    controller.abort()
    await expect(done).rejects.toMatchObject({ name: 'AbortError' })
    expect(sent.map(m => m.type)).toEqual(['stream_begin', 'stream_end'])
  })
})

describe('streamClip live samples', () => {
  const sentSamples = (messages: ManagerMessage[]) => messages.filter(m => m.type === 'stream_data')
    .flatMap(m => [...new Int16Array(Uint8Array.from(atob(m.payload.data as string), c => c.charCodeAt(0)).buffer)])
  it('a chunk from liveChunk (a source mixed again while it streams) is sent in place of the prepared PCM, L = R', async () => {
    const messages: ManagerMessage[] = [], asked: [number, number][] = []
    const blob = new Blob([new Uint8Array([1])], { type: 'audio/wav' })
    await streamClip(blob, m => messages.push(m), { control: { liveChunk: (atSec, frames) => { asked.push([atSec, frames]); return new Float32Array(frames).fill(0.5) } } })
    expect(asked).toEqual([[0, 4]])
    expect(sentSamples(messages)).toEqual(Array(8).fill(Math.round(0.5 * 32767)))
  })
  it('null (or a chunk of another length) keeps the prepared PCM', async () => {
    const plain: ManagerMessage[] = [], wrong: ManagerMessage[] = [], none: ManagerMessage[] = []
    const blob = new Blob([new Uint8Array([1])], { type: 'audio/wav' })
    await streamClip(blob, m => plain.push(m))
    await streamClip(blob, m => none.push(m), { control: { liveChunk: () => null } })
    await streamClip(blob, m => wrong.push(m), { control: { liveChunk: () => new Float32Array(1) } })
    expect(sentSamples(none)).toEqual(sentSamples(plain)); expect(sentSamples(wrong)).toEqual(sentSamples(plain))
  })
})
