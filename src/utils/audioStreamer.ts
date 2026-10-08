/**
 * Audio streamer — sends audio data to Hapbeat device(s) via the Helper WebSocket.
 *
 * Flow: Studio → WebSocket (JSON+base64) → Helper → UDP (binary) → Device(s)
 *
 * Routing: this module is target-agnostic. The CALLER picks the destinations by
 * wrapping `send` to inject `targets: [ip, ...]` into each stream message (see
 * KitManager `useAudioPreview` and StreamingTestSection). Helper's
 * `_resolve_targets` prefers that list; with NO targets it FALLS BACK to
 * broadcasting to every known device — so a caller that wants to honour the
 * user's device selection MUST inject targets. (Earlier copy here claimed
 * "Manager resolves the selected device"; the Manager is deprecated and the
 * Helper tracks no selection — that stale assumption was the bug where clips
 * played on devices the user hadn't selected.)
 *
 * Helper uses command codes 0x30/0x31/0x32 for STREAM_BEGIN/DATA/END.
 * Default: PCM16 format (format=0), 512-sample chunks, paced at real-time.
 */

import type { ManagerMessage } from '@/types/manager'
import { markStreamClosed, markStreamOpen } from '@/utils/openStreams'

/** UDP payload は firmware の RX バッファ (MTU 1500B) を超えないよう制限する。
 *  frame_size (channels × 2B) で割って 1 チャンクあたりの frames を決める:
 *    mono  (2B/frame) → 512 frames
 *    stereo (4B/frame) → 256 frames
 *  Manager 側 (main_window.py の file streamer) と同じポリシー。 */
const MAX_PAYLOAD_BYTES = 1024
const PCM_CACHE_MAX_BYTES = 16 * 1024 * 1024

interface PreparedAudio {
  pcm16: Int16Array
  channels: number
}

interface PreparedCacheEntry {
  promise: Promise<PreparedAudio>
  bytes: number
}

const preparedPcmCache = new Map<string, PreparedCacheEntry>()
let preparedPcmCacheBytes = 0
let streamIdCounter = 0

/**
 * Live control surface for an in-flight stream. All hooks are pulled
 * once per chunk so React state can drive pause / seek / intensity /
 * progress without rebuilding the streamer.
 */
export interface StreamControl {
  /** Returns true while the user wants the stream paused. The streamer
   *  ends the stream (stream-session-v2 inactivity timeout: no session stays
   *  open without DATA), busy-waits in 50 ms increments until this flips back
   *  to false, then BEGINs a new stream (new stream_id) from the paused position. */
  isPaused?: () => boolean
  /** Returns a 0..1 fractional position when the user just released the
   *  seek bar, then null on subsequent calls. The streamer consumes the
   *  request, jumps the read offset, and re-anchors pacing. */
  consumeSeek?: () => number | null
  /** Live intensity multiplier (typically 0..2). Read each chunk and
   *  applied before send, so a slider above the player can boost or
   *  cut the haptic level mid-stream. When absent, falls back to the
   *  static `intensity` option (frozen at start). `atSec`: the chunk's position in the stream (seconds). */
  getIntensity?: (atSec: number) => number
  /** Live samples: the chunk at `atSec` (its position in the stream, seconds) as mono samples at the target rate,
   *  `frames` long, sent in place of the prepared PCM (L = R), so a source mixed again while it streams (a gain
   *  edited during a scene audition) reaches the device from the next chunk. Null (or another length) = the prepared PCM. */
  liveChunk?: (atSec: number, frames: number) => Float32Array | null
  /** Called after every chunk send with the current read position. */
  onProgress?: (currentFrames: number, totalFrames: number, sampleRate: number) => void
}

export interface StreamOptions {
  /** Target sample rate (default: 16000) */
  sampleRate?: number
  /** Intensity multiplier applied to PCM data before sending (default: 1.0) */
  intensity?: number
  /** Abort signal */
  signal?: AbortSignal
  /** Pause / seek / progress hooks */
  control?: StreamControl
  /** Stable logical source key. When supplied, decoded/resampled PCM is cached. */
  cacheKey?: string
  /** Helper messages. When supplied, the stream stops (StreamLostError) once the
   *  helper reports it lost its devices: `stream_displaced` by another client,
   *  or a `no_session` ack. */
  subscribe?: (listener: (message: ManagerMessage) => void) => () => void
}

/** The helper no longer routes this stream to any device (no auto re-BEGIN: the next play opens a new one). */
export class StreamLostError extends Error {
  constructor(readonly streamId: string, readonly reason: 'displaced' | 'no_session', readonly by?: string) {
    super(`Stream ${streamId} lost its devices (${reason}${by ? ` by ${by}` : ''})`)
    this.name = 'StreamLostError'
  }
}

/**
 * Stream audio via Manager WebSocket. Manager decides the routing destination.
 */
export async function streamClip(
  audioBlob: Blob,
  send: (msg: ManagerMessage) => void,
  options?: StreamOptions,
): Promise<void> {
  const signal = options?.signal
  const targetRate = options?.sampleRate ?? 16000
  // Hapbeat SDK の stream session は単一 format で固定 (rate+channels 共通)。
  // mono / stereo が混在する Kit を deploy / 同時 stream すると session mismatch で
  // reject されるので、Studio で **2ch に upmix して送る** ことで衝突回避する。
  // mono ソースは Web Audio の up-mix ルールで L=R duplicate される。
  const targetChannels = 2
  const intensity = options?.intensity ?? 1.0
  const control = options?.control
  let streamId = createStreamId()

  throwIfAborted(signal)
  const arrayBuffer = await audioBlob.arrayBuffer()
  throwIfAborted(signal)
  const prepared = await getPreparedAudio(
    arrayBuffer,
    targetRate,
    targetChannels,
    options?.cacheKey,
  )
  throwIfAborted(signal)
  const { channels, pcm16 } = prepared

  // Intensity is applied per-chunk inside the loop so a live slider
  // can boost / cut the haptic level mid-stream. The static
  // `intensity` option is the fallback when the caller hasn't wired
  // a live `control.getIntensity` callback.

  const totalFrames = Math.floor(pcm16.length / channels)
  const frameSize = channels * 2 // PCM16
  const chunkFrames = Math.max(1, Math.floor(MAX_PAYLOAD_BYTES / frameSize))

  // The helper's word that this stream reaches no device any more (a same-client
  // displacement is ignored here: its DATA then gets the `no_session` ack).
  let lost: StreamLostError | null = null
  const unsubscribe = options?.subscribe?.(message => {
    const p = message.payload ?? {}
    if (lost || p.stream_id !== streamId) return
    if (message.type === 'stream_displaced' && !p.same_client) lost = new StreamLostError(streamId, 'displaced', typeof p.by === 'string' ? p.by : undefined)
    else if (message.type === 'stream_ack' && p.status === 'no_session') lost = new StreamLostError(streamId, 'no_session')
  })
  // Send STREAM_BEGIN. Destination = whatever the caller-wrapped `send`
  // injects as `targets` (see module header); bare `send` broadcasts.
  const begin = () => {
    markStreamOpen(streamId)
    send({
      type: 'stream_begin',
      payload: {
        stream_id: streamId,
        sample_rate: targetRate,
        channels: channels,
        format: 'pcm16',
        total_samples: totalFrames,
      },
    })
  }
  try {
    begin()

    // Pacing anchors. We use a movable anchor so a pause-resume or
    // seek can re-zero the wall-clock vs. audio-position relationship
    // without drifting. After a seek to frame F, anchorFrame=F and
    // anchorTime=now, so subsequent expected times are
    //   anchorTime + (frameOffset - anchorFrame) / sampleRate * 1000.
    let anchorFrame = 0
    let anchorTime = performance.now()

    // Send data in chunks (PCM16 = 2 bytes per sample, interleaved when stereo)
    let frameOffset = 0
    while (frameOffset < totalFrames) {
      // No END: the helper holds no session for it any more.
      if (lost) throw lost
      if (signal?.aborted) {
        send({ type: 'stream_end', payload: { stream_id: streamId } })
        throw abortError()
      }

      // Pause: the device ends a session after 5 s without DATA
      // (contracts stream-session-v2 "Inactivity timeout"), so END now, spin
      // in 50 ms increments, and resume on a new stream (new stream_id). On
      // resume, re-anchor pacing so the next chunk isn't dispatched as fast
      // as possible to "catch up".
      if (control?.isPaused?.()) {
        send({ type: 'stream_end', payload: { stream_id: streamId } })
        markStreamClosed(streamId)
        while (control.isPaused?.() && !signal?.aborted) {
          await delay(50)
        }
        if (signal?.aborted) throw abortError() // already ended
        streamId = createStreamId()
        lost = null
        begin()
        anchorFrame = frameOffset
        anchorTime = performance.now()
      }

      // Seek: consume the latest request, jump the read offset, re-anchor.
      const seek = control?.consumeSeek?.() ?? null
      if (seek != null) {
        const target = Math.max(0, Math.min(totalFrames - 1, Math.floor(totalFrames * seek)))
        frameOffset = target - (target % chunkFrames) // align to chunk grid
        anchorFrame = frameOffset
        anchorTime = performance.now()
        if (frameOffset >= totalFrames) break
      }

      const endFrame = Math.min(frameOffset + chunkFrames, totalFrames)
      const live = control?.liveChunk?.(frameOffset / targetRate, endFrame - frameOffset)
      const chunk = live && live.length === endFrame - frameOffset ? monoToPcm16(live, channels) : pcm16.slice(frameOffset * channels, endFrame * channels)

      // Apply current intensity per-chunk. `slice` already returned a
      // new buffer so this mutation doesn't affect the source pcm16.
      const liveIntensity = control?.getIntensity?.(frameOffset / targetRate) ?? intensity
      if (liveIntensity !== 1.0) {
        for (let i = 0; i < chunk.length; i++) {
          let val = Math.round(chunk[i] * liveIntensity)
          if (val > 32767) val = 32767
          if (val < -32768) val = -32768
          chunk[i] = val
        }
      }

      // Convert Int16Array to bytes
      const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
      const base64 = uint8ArrayToBase64(bytes)

      const byteOffset = frameOffset * channels * 2 // 2 bytes/sample × channels
      send({
        type: 'stream_data',
        payload: {
          stream_id: streamId,
          offset: byteOffset,
          data: base64,
        },
      })

      frameOffset = endFrame
      control?.onProgress?.(frameOffset, totalFrames, targetRate)

      // Pace to real-time relative to the current anchor.
      const expectedTime = anchorTime + ((frameOffset - anchorFrame) / targetRate) * 1000
      const now = performance.now()
      if (expectedTime > now) {
        await delay(expectedTime - now)
      }
    }

    if (lost) throw lost
    // Send STREAM_END
    send({ type: 'stream_end', payload: { stream_id: streamId } })
  } finally {
    unsubscribe?.()
    markStreamClosed(streamId)
  }
}

// ---- Helpers ----

/** Mono float samples as interleaved PCM16 with every channel the same (as the prepared PCM is converted). */
function monoToPcm16(data: Float32Array, channels: number): Int16Array {
  const out = new Int16Array(data.length * channels)
  for (let i = 0; i < data.length; i++) {
    let val = Math.round(data[i] * 32767)
    if (val > 32767) val = 32767
    if (val < -32768) val = -32768
    for (let c = 0; c < channels; c++) out[i * channels + c] = val
  }
  return out
}

function createStreamId(): string {
  streamIdCounter = (streamIdCounter + 1) >>> 0
  return `studio-${Date.now().toString(36)}-${streamIdCounter.toString(36)}`
}

function abortError(): DOMException {
  return new DOMException('Streaming aborted', 'AbortError')
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError()
}

async function getPreparedAudio(
  arrayBuffer: ArrayBuffer,
  targetRate: number,
  targetChannels: number,
  sourceKey?: string,
): Promise<PreparedAudio> {
  if (!sourceKey) return prepareAudio(arrayBuffer, targetRate, targetChannels)

  // Include a content digest so replacing a clip under the same event ID can
  // never reuse stale PCM. Reading the Blob remains necessary, but the costly
  // Web Audio decode + offline resample is skipped on subsequent previews.
  const digest = await digestArrayBuffer(arrayBuffer)
  const key = `${sourceKey}:${targetRate}:${targetChannels}:${digest}`
  const cached = preparedPcmCache.get(key)
  if (cached) {
    preparedPcmCache.delete(key)
    preparedPcmCache.set(key, cached)
    return cached.promise
  }

  const entry: PreparedCacheEntry = {
    promise: prepareAudio(arrayBuffer, targetRate, targetChannels),
    bytes: 0,
  }
  preparedPcmCache.set(key, entry)
  try {
    const prepared = await entry.promise
    if (preparedPcmCache.get(key) === entry) {
      entry.bytes = prepared.pcm16.byteLength
      preparedPcmCacheBytes += entry.bytes
      trimPreparedPcmCache()
    }
    return prepared
  } catch (error) {
    if (preparedPcmCache.get(key) === entry) preparedPcmCache.delete(key)
    throw error
  }
}

async function prepareAudio(
  arrayBuffer: ArrayBuffer,
  targetRate: number,
  targetChannels: number,
): Promise<PreparedAudio> {
  const ctx = new OfflineAudioContext(1, 1, 44100)
  const decoded = await ctx.decodeAudioData(arrayBuffer)
  // Force channels to 2 so all Studio streams share one firmware session format.
  const resampled = await resample(decoded, targetRate, targetChannels)
  return {
    channels: resampled.numberOfChannels,
    pcm16: audioBufferToPcm16Interleaved(resampled),
  }
}

function trimPreparedPcmCache(): void {
  while (preparedPcmCacheBytes > PCM_CACHE_MAX_BYTES && preparedPcmCache.size > 1) {
    const oldest = preparedPcmCache.entries().next().value as
      | [string, PreparedCacheEntry]
      | undefined
    if (!oldest) break
    preparedPcmCache.delete(oldest[0])
    preparedPcmCacheBytes -= oldest[1].bytes
  }
}

async function digestArrayBuffer(buffer: ArrayBuffer): Promise<string> {
  if (globalThis.crypto?.subtle) {
    const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', buffer))
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
  }

  // Web Crypto is available in supported browsers. This deterministic
  // fallback keeps local/non-secure development contexts functional.
  let hash = 0x811c9dc5
  for (const byte of new Uint8Array(buffer)) {
    hash ^= byte
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function audioBufferToPcm16Interleaved(buffer: AudioBuffer): Int16Array {
  const channels = buffer.numberOfChannels
  const frames = buffer.length
  const pcm = new Int16Array(frames * channels)

  // getChannelData(ch) returns Float32Array for channel ch (planar).
  // Interleave: frame0_L, frame0_R, frame1_L, frame1_R, ...
  const channelData: Float32Array[] = []
  for (let c = 0; c < channels; c++) channelData.push(buffer.getChannelData(c))

  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channels; c++) {
      let val = Math.round(channelData[c][f] * 32767)
      if (val > 32767) val = 32767
      if (val < -32768) val = -32768
      pcm[f * channels + c] = val
    }
  }
  return pcm
}

async function resample(
  buffer: AudioBuffer,
  targetRate: number,
  targetChannels?: number,
): Promise<AudioBuffer> {
  const length = Math.ceil(buffer.length * targetRate / buffer.sampleRate)
  // targetChannels が指定されていれば up/down-mix される。Web Audio の標準ルール:
  //   mono → stereo: L = R = mono サンプル
  //   stereo → mono: L+R 平均
  const channels = targetChannels ?? buffer.numberOfChannels
  const offCtx = new OfflineAudioContext(channels, length, targetRate)
  const src = offCtx.createBufferSource()
  src.buffer = buffer
  src.connect(offCtx.destination)
  src.start()
  return offCtx.startRendering()
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
