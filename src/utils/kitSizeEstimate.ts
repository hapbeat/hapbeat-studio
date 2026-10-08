/**
 * Kit size as the device will store it — not the size of the source files.
 *
 * Device clip storage is a raw audio partition (firmware tcp_server.cpp
 * writeClipData). Clips arrive as 16 kHz PCM16 WAV; the firmware encodes
 * 16-bit audio to IMA ADPCM on the way in (4 bit per sample) and starts each
 * clip on a 4-byte boundary. The kit manifest goes to LittleFS, not to the
 * audio partition.
 *
 * Identical clip audio is stored once: the exporter (kitExporter.ts) gives
 * events with the same encoded bytes (outputHash) one shared install-clips/
 * file, so sizes are counted per unique output clip, never per event.
 */
import type { KitEvent } from '@/types/library'
import { parseWavInfo } from '@/utils/wavIO'

/** How a clip is stored on the device. `ima_adpcm` is what current firmware
 *  does with 16-bit clips; `opus` is a placeholder for the planned Opus
 *  storage (per-clip codec selection). */
export type ClipCodec = 'pcm16' | 'ima_adpcm' | 'opus'

export const DEFAULT_CLIP_CODEC: ClipCodec = 'ima_adpcm'

/** Sample rate of every install clip (kitExporter PACK_TARGET_SAMPLE_RATE). */
export const STORED_SAMPLE_RATE = 16000

/** Each clip starts on a 4-byte boundary in the audio partition. */
export const CLIP_ALIGN_BYTES = 4

/** Opus placeholder parameters (the Opus storage format is not final). */
export const OPUS_DEFAULT_BITRATE_BPS = 24000
export const OPUS_FRAME_SECONDS = 0.02
export const OPUS_HEADER_BYTES = 16

/**
 * Hapbeat Helper's pack_normalize up-mixes every install clip to stereo
 * before sending it (TARGET_CHANNELS = 2, when ffmpeg is installed), so a
 * mono clip arrives on the device as stereo and takes twice the space.
 * The estimate follows what is actually sent.
 * TODO(install-clip channels): whether install clips should stay mono is a
 * separate decision (helper pack_normalize TARGET_CHANNELS, 2026-10-08
 * capacity investigation). When the helper keeps mono, set this to false.
 */
export const HELPER_UPMIXES_INSTALL_CLIPS_TO_STEREO = true

/** Channel count a clip with `channels` channels has once it reaches the device. */
export function deviceClipChannels(channels: number): number {
  return HELPER_UPMIXES_INSTALL_CLIPS_TO_STEREO ? Math.max(2, channels) : channels
}

export interface ClipShape {
  /** Sample frames at `sampleRate` (one frame = one sample per channel). */
  frames: number
  channels: number
  /** Defaults to STORED_SAMPLE_RATE. */
  sampleRate?: number
  /** Defaults to 16. Clips that are not 16-bit are stored as raw PCM. */
  bitsPerSample?: number
}

export interface StoredBytesOptions {
  /** Opus bitrate (bits/s), placeholder default OPUS_DEFAULT_BITRATE_BPS. */
  opusBitrateBps?: number
}

function alignUp(bytes: number, align = CLIP_ALIGN_BYTES): number {
  return Math.ceil(bytes / align) * align
}

/** Bytes one clip occupies in the audio partition, alignment included. */
export function storedClipBytes(
  clip: ClipShape,
  codec: ClipCodec = DEFAULT_CLIP_CODEC,
  options: StoredBytesOptions = {},
): number {
  const frames = Math.max(0, Math.ceil(clip.frames))
  const channels = Math.max(1, clip.channels)
  const bits = clip.bitsPerSample ?? 16
  if (frames === 0) return 0
  if (bits !== 16) {
    // Firmware only ADPCM-encodes 16-bit audio; anything else is copied as is.
    return alignUp(frames * channels * Math.ceil(bits / 8))
  }
  switch (codec) {
    case 'pcm16':
      return alignUp(frames * channels * 2)
    case 'ima_adpcm':
      // 4 bit per sample: mono packs 2 frames per byte, stereo 1 frame (L|R).
      return alignUp(Math.ceil((frames * channels) / 2))
    case 'opus': {
      const seconds = frames / (clip.sampleRate ?? STORED_SAMPLE_RATE)
      const bitrate = options.opusBitrateBps ?? OPUS_DEFAULT_BITRATE_BPS
      const packets = Math.ceil(seconds / OPUS_FRAME_SECONDS)
      // Payload + 1 length byte per packet + stream header.
      return alignUp(Math.ceil((bitrate / 8) * seconds) + packets + OPUS_HEADER_BYTES)
    }
  }
}

export interface KitStorageEstimate {
  /** Bytes the kit's clips take in the audio partition. */
  clipBytes: number
  /** Unique install clips (= TOC entries the kit adds). */
  clipCount: number
  /** Manifest size in LittleFS (exact when built, approximate otherwise). */
  manifestBytes: number
  /** 'built' = read from the exported 16 kHz files; 'metadata' = from the
   *  events' duration / channel snapshots (before a build exists). */
  basis: 'built' | 'metadata'
}

const EMPTY_ESTIMATE: KitStorageEstimate = { clipBytes: 0, clipCount: 0, manifestBytes: 0, basis: 'metadata' }

/** Events that put a clip on the device: FIRE (command) mode. CLIP
 *  (stream_clip) audio is streamed by the SDK and never stored. */
function isInstalledOnDevice(ev: Pick<KitEvent, 'modes'>): boolean {
  return ev.modes?.length ? ev.modes.includes('command') : true // legacy: no modes[] = command
}

/** Rough manifest size before a build exists (header + one entry per event). */
const MANIFEST_BASE_BYTES = 600
const MANIFEST_BYTES_PER_EVENT = 220

/**
 * Estimate from event metadata (no audio access). Clips are de-duplicated by
 * source file — events that use the same source export to the same bytes.
 * Two different source files with identical audio are counted twice, which
 * only errs towards "does not fit".
 */
export function estimateKitStorageFromEvents(
  events: readonly Pick<KitEvent, 'id' | 'modes' | 'clipSourceFilename' | 'clipDuration' | 'clipChannels'>[],
  codec: ClipCodec = DEFAULT_CLIP_CODEC,
): KitStorageEstimate {
  const installed = events.filter(isInstalledOnDevice)
  if (installed.length === 0) return EMPTY_ESTIMATE
  const seen = new Set<string>()
  let clipBytes = 0
  for (const ev of installed) {
    const key = ev.clipSourceFilename || ev.id
    if (seen.has(key)) continue
    seen.add(key)
    // Same frame count as the exporter's resample (ceil(duration × 16 kHz)).
    const frames = Math.ceil(Math.max(0, ev.clipDuration || 0) * STORED_SAMPLE_RATE)
    clipBytes += storedClipBytes({ frames, channels: deviceClipChannels(ev.clipChannels || 1) }, codec)
  }
  return {
    clipBytes,
    clipCount: seen.size,
    manifestBytes: MANIFEST_BASE_BYTES + MANIFEST_BYTES_PER_EVENT * events.length,
    basis: 'metadata',
  }
}

/** A file from `exportKitAsPack` (structurally typed to keep this module light). */
export interface BuiltKitFile {
  path: string
  blob: Blob
  outputHash: string | null
}

/**
 * Exact estimate from the exported files: every `install-clips/*.wav` is
 * parsed for its 16 kHz frame count. Identical outputs (same outputHash) are
 * counted once, as the device stores them once.
 */
export async function estimateKitStorageFromFiles(
  files: readonly BuiltKitFile[],
  codec: ClipCodec = DEFAULT_CLIP_CODEC,
): Promise<KitStorageEstimate> {
  const seen = new Set<string>()
  let clipBytes = 0
  let manifestBytes = 0
  for (const file of files) {
    if (file.path.endsWith('manifest.json')) {
      manifestBytes += file.blob.size
      continue
    }
    if (!file.path.startsWith('install-clips/')) continue
    const key = file.outputHash ?? file.path
    if (seen.has(key)) continue
    seen.add(key)
    const info = await parseWavInfo(file.blob)
    if (!info) {
      // Unparseable → assume the bytes go over as they are.
      clipBytes += storedClipBytes({ frames: file.blob.size, channels: 1, bitsPerSample: 8 }, codec)
      continue
    }
    const bytesPerFrame = info.channels * Math.ceil(info.bitsPerSample / 8)
    const frames = Math.floor(info.dataBytes / bytesPerFrame)
    clipBytes += storedClipBytes({
      frames,
      channels: deviceClipChannels(info.channels),
      sampleRate: info.sampleRate,
      bitsPerSample: info.bitsPerSample,
    }, codec)
  }
  return { clipBytes, clipCount: seen.size, manifestBytes, basis: 'built' }
}
