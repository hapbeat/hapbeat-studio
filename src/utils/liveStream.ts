/**
 * A live PCM stream to Hapbeat devices through the helper, for a source with no end
 * (PC sound). Same wire as `streamClip` (helper `stream_begin` / `stream_data` /
 * `stream_end`, 16 kHz stereo PCM16, 1024-byte packets) but with no total length and
 * no pacing of its own: each chunk goes out as the source delivers it.
 *
 * Every message names its devices in `targets`: a stream without targets would reach
 * every device the helper knows (its fallback), which a live source must never do.
 * A newer stream on a device (another app, or Studio's own clip preview) takes it
 * (helper `stream_displaced`); once no device is left, or the helper cannot start the
 * stream on any device, `onLost` is called and nothing more is sent.
 */

import type { ManagerMessage } from '@/types/manager'
import type { HelperChannel } from '@/utils/helperRequest'
import { markStreamClosed, markStreamOpen } from '@/utils/openStreams'

export const LIVE_SAMPLE_RATE = 16000
export const LIVE_CHANNELS = 2
/** 256 stereo PCM16 frames = 1024 bytes per packet (below the UDP MTU, as `streamClip`) = 16 ms. */
export const LIVE_CHUNK_FRAMES = 256
/**
 * Silent packets sent right after BEGIN (3 = 48 ms). The device starts playing at
 * 4 ms of data and a live source can never get ahead of it, so without this the
 * first seconds under-run until the device's drift correction has built its depth
 * one frame per block (firmware `CLIP_DEFAULT_TARGET` 50 ms, dead band ±14.5 ms).
 * 48 ms sits inside that band, so the depth then holds.
 */
export const LIVE_PREROLL_CHUNKS = 3

/** displaced = a newer stream took every device; unreachable = the helper started it on none; no_session = the helper holds no session for it. */
export type LiveStreamLoss = 'displaced' | 'unreachable' | 'no_session'

let liveIdCounter = 0

function createLiveStreamId(): string {
  liveIdCounter = (liveIdCounter + 1) >>> 0
  return `studio-live-${Date.now().toString(36)}-${liveIdCounter.toString(36)}`
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(a)
  return b.every((ip) => set.has(ip))
}

export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

/**
 * Interleaved stereo float samples (-1..1) as PCM16. Returns the peak |sample| (0..1)
 * of the chunk too, for a level meter.
 */
export function floatToPcm16(interleaved: Float32Array): { pcm: Int16Array; peak: number } {
  const pcm = new Int16Array(interleaved.length)
  let peak = 0
  for (let i = 0; i < interleaved.length; i++) {
    const v = interleaved[i]
    const a = Math.abs(v)
    if (a > peak) peak = a
    let s = Math.round(v * 32767)
    if (s > 32767) s = 32767
    else if (s < -32768) s = -32768
    pcm[i] = s
  }
  return { pcm, peak: Math.min(1, peak) }
}

export class LiveStream {
  private streamId: string | null = null
  private targets: string[] = []
  /** Devices the helper still routes this stream to. */
  private routed = new Set<string>()
  private offset = 0
  private readonly unsubscribe: () => void

  constructor(
    private readonly channel: HelperChannel,
    private readonly onLost: (reason: LiveStreamLoss) => void,
  ) {
    this.unsubscribe = channel.subscribe((message) => this.onHelperMessage(message))
  }

  /** True between a BEGIN and its END or loss. */
  get active(): boolean {
    return this.streamId !== null
  }

  /** The devices of the open stream. */
  get devices(): readonly string[] {
    return this.targets
  }

  /**
   * Starts the stream on `targets`, or moves it there: the open stream ends and a new
   * one (new stream id) begins, so devices left out stop at once. The same devices
   * again change nothing; no devices ends the stream.
   */
  setTargets(targets: readonly string[]): void {
    const next = [...new Set(targets.filter(Boolean))]
    if (this.streamId && sameSet(next, this.targets)) return
    this.end()
    if (next.length === 0) return
    const streamId = createLiveStreamId()
    this.streamId = streamId
    this.targets = next
    this.routed = new Set(next)
    this.offset = 0
    markStreamOpen(streamId)
    this.channel.send({
      type: 'stream_begin',
      payload: {
        stream_id: streamId,
        sample_rate: LIVE_SAMPLE_RATE,
        channels: LIVE_CHANNELS,
        format: 'pcm16',
        total_samples: 0,
        targets: next,
      },
    })
    for (let i = 0; i < LIVE_PREROLL_CHUNKS; i++) this.push(new Int16Array(LIVE_CHUNK_FRAMES * LIVE_CHANNELS))
  }

  /** One chunk of interleaved stereo PCM16, sent now. Ignored when no stream is open. */
  push(pcm: Int16Array): void {
    if (!this.streamId || pcm.length === 0) return
    const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)
    this.channel.send({
      type: 'stream_data',
      payload: {
        stream_id: this.streamId,
        offset: this.offset,
        data: uint8ArrayToBase64(bytes),
        targets: this.targets,
      },
    })
    this.offset += bytes.length
  }

  /** Ends the open stream (END to its devices). Safe to call when none is open. */
  end(): void {
    const streamId = this.streamId
    if (!streamId) return
    this.channel.send({ type: 'stream_end', payload: { stream_id: streamId, targets: this.targets } })
    this.close(streamId)
  }

  /** Ends the stream and stops listening to the helper. */
  dispose(): void {
    this.end()
    this.unsubscribe()
  }

  private close(streamId: string): void {
    markStreamClosed(streamId)
    this.streamId = null
    this.targets = []
    this.routed.clear()
  }

  private lose(reason: LiveStreamLoss): void {
    const streamId = this.streamId
    if (!streamId) return
    // No END: the helper routes this stream to no device any more.
    this.close(streamId)
    this.onLost(reason)
  }

  private onHelperMessage(message: ManagerMessage): void {
    const p = message.payload ?? {}
    if (!this.streamId || p.stream_id !== this.streamId) return
    if (message.type === 'stream_displaced') {
      const taken = Array.isArray(p.targets) ? (p.targets as unknown[]).filter((ip): ip is string => typeof ip === 'string') : this.targets
      for (const ip of taken) this.routed.delete(ip)
      if (this.routed.size === 0) this.lose('displaced')
    } else if (message.type === 'stream_ack') {
      if (p.status === 'no_session') {
        this.lose('no_session')
      } else if (p.status === 'no_target' || p.status === 'error') {
        this.lose('unreachable')
      } else if (Array.isArray(p.deferred)) {
        // Started on some devices only (the others did not answer in time).
        for (const ip of p.deferred as unknown[]) if (typeof ip === 'string') this.routed.delete(ip)
        if (this.routed.size === 0) this.lose('unreachable')
      }
    }
  }
}
