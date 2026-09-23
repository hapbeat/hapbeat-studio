import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ManagerMessage } from '@/types/manager'
import { streamClip } from './audioStreamer'

class FakeAudioBuffer {
  readonly numberOfChannels = 2
  readonly length = 4
  readonly sampleRate = 16000

  getChannelData(): Float32Array {
    return new Float32Array([0.1, -0.1, 0.2, -0.2])
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
