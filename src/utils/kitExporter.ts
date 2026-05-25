/**
 * Kit → Pack 形式 ZIP エクスポーター
 *
 * hapbeat-contracts の kit-format.md (schema 2.0.0) に準拠した ZIP を生成する。
 * ZIP 内構造:
 *   <kit_id>/
 *     <kit_id>-manifest.json
 *     install-clips/      ← events (command) の WAV (device flash 用)
 *       <clip-file>.wav
 *     stream-clips/       ← stream_events の WAV (SDK import 用, device には焼かない)
 *       <clip-file>.wav
 *
 * manifest 構造 (schema 2.0.0, DEC-031):
 *   - `events` (required): schema 1.x 由来の単一 bucket を schema 2.0.0 で
 *     **command-mode 専用に narrow 化**。キーは PLAY/STOP packet の wire eventId
 *     に直接対応。device kit_loader は引き続き `doc["events"]` を読む。
 *   - `stream_events` (optional): SDK が UDP audio stream で送る event 辞書。
 *     device はこのキーを認識しない (STREAM_BEGIN に eventId が乗らないため)。
 *   - 同一 eventId が `events` と `stream_events` 双方に存在することは valid
 *     (Studio の BOTH モード)。
 *   - `mode` フィールド廃止: bucket で意味が決まる。
 *   - `stream_source` 廃止: stream_events.clip は required。
 *
 * Option C 命名: `events` を `command_events` に rename する案も検討したが、
 * device firmware の kit_loader が既に `doc["events"]` を参照しているため、
 * 名前を保つことで firmware 無変更で済むメリットを取った。将来別件で firmware
 * を更新する機会に rename を検討。詳細は DEC-031 参照。
 */

import JSZip from 'jszip'
import type { KitDefinition, KitEvent, KitEventMode } from '@/types/library'
import {
  loadEncodedWav,
  loadKitEventAudio,
  saveEncodedWav,
  sha1Hex,
  type EncodedMode,
  type EncodedWavEntry,
} from '@/utils/libraryStorage'
import { encodeStereoWavBlob, encodeWavBlob, parseWavInfo } from '@/utils/wavIO'

/** firmware は 16 kHz I2S 固定でパック内 WAV を resample しないため、
 *  Pack 化するすべての WAV は事前に 16 kHz PCM16 に normalize する。
 *  ref: hapbeat-device-firmware/src/audio_player.cpp:161 (warning only, no resample)
 *       hapbeat-studio/src/utils/audioStreamer.ts (streaming も同じ理由で 16 kHz 固定) */
const PACK_TARGET_SAMPLE_RATE = 16000

/** Event ID の正規表現 (hapbeat-contracts 準拠) */
const EVENT_ID_RE =
  /^([a-z][a-z0-9_-]{0,63}\/)?[a-z][a-z0-9_-]{0,63}(\.[a-z][a-z0-9_-]{0,63}){1,3}$/

/** 浮動小数点を小数点以下 2 桁に丸める (manifest.json の可読性向上) */
function round2(v: number): number {
  return Math.round(v * 100) / 100
}

/**
 * Resolve the on-disk manifest filename for a kit.
 *
 * Convention (2026-05-17, instructions-kitname-manifest-rename):
 * `<kit-id>-manifest.json` so multiple kits side-by-side stay
 * identifiable in OS Explorer / Unity SDK pickers. The Unity SDK
 * (`HapbeatManifestIntensity.FindKitManifest`) and Helper deploy
 * code follow the same convention with fallback to any
 * `*manifest*.json` for legacy kits.
 */
export function manifestFileName(packId: string): string {
  return `${packId}-manifest.json`
}

/** Kit 名 → kit_id (kebab-case, [a-z][a-z0-9-]*) */
export function toPackId(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/^[^a-z]+/, '')    // 先頭が英小文字になるよう除去
    .replace(/-+/g, '-')        // 連続ハイフンを1つに
    .replace(/-$/, '')           // 末尾ハイフン除去
    || 'unnamed-kit'
}

/** Event ID のバリデーション結果 */
export interface EventIdValidation {
  eventId: string
  valid: boolean
}

export function validateEventIds(
  kit: KitDefinition
): EventIdValidation[] {
  return kit.events.map((ev) => ({
    eventId: ev.eventId,
    valid: EVENT_ID_RE.test(ev.eventId),
  }))
}

/**
 * Resolve the kit-internal filename for a KitEvent. All data lives on
 * the event itself now (`clipName`, `clipSourceFilename`) — the kit
 * is independent of the library.
 *
 * Prefer the kit-side display name (`clipName`) so user renames inside
 * the kit show up in the install-clips/ folder. Fall back to the source
 * filename (the original drop) when the clipName is missing or trivial.
 *
 * Always normalised to a `.wav` extension; firmware accepts only WAV.
 */
function eventFileName(event: KitEvent): string {
  const candidate = event.clipName?.trim() || event.clipSourceFilename || 'clip'
  // Strip any existing extension, then re-append .wav. Sanitise stray
  // slashes / OS-illegal chars so the user-edited name can't escape
  // the folder.
  const stem = candidate.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '_')
  return `${stem || 'clip'}.wav`
}

/**
 * One file emitted by `exportKitAsPack`. The `path` is relative to
 * `<outRoot>/<packId>/` (e.g. `install-clips/foo.wav`, `<packId>-manifest.json`).
 *
 * `outputHash` is the SHA-1 hex of `blob` bytes — the hash the
 * on-disk file *would have* after writing this entry. The
 * skip-write decision compares this against the on-disk file's
 * recorded hash (from `<packId>/.studio-cache.json`); match → disk
 * is already what we'd write → skip the createWritable call.
 *
 * For files that aren't WAVs (manifest.json), `outputHash` is `null`
 * and the file is always rewritten — manifests are tiny and their
 * parameters change on every edit.
 *
 * `cached` is `true` when `blob` came from the IDB encoded-wavs cache
 * (no fresh decode + encode this turn) — telemetry only; the
 * skip-write decision uses `outputHash` against the disk cache file,
 * not this flag.
 */
export interface ExportFile {
  path: string
  blob: Blob
  outputHash: string | null
  cached: boolean
}

export interface ExportResult {
  files: ExportFile[]
  packId: string
  warnings: string[]
}

/** Modes selected on a KitEvent, with a `'command'` fallback when migration
 *  left the array empty (shouldn't normally happen post-migrateKit). */
function resolveModes(ev: KitEvent): KitEventMode[] {
  const ms = ev.modes
  return Array.isArray(ms) && ms.length > 0 ? ms : ['command']
}

/**
 * Kit を Pack 形式の **ファイル配列** に展開する (schema 2.0.0)。
 *
 * 各 KitEvent は `modes: KitEventMode[]` で複数 mode を選択可。
 *   - command     → install-clips/ に WAV 配置、`events` に bare filename で記録
 *   - stream_clip → stream-clips/ に WAV 配置、`stream_events` に bare filename で記録
 *
 * BOTH モード (modes=['command','stream_clip']) は同じ base eventId を両 bucket に
 * emit する。JSON dict 重複キー問題は bucket 分離で解消したため suffix 不要。
 *
 * **ZIP 不使用**: 旧版はここで JSZip を組み上げて Blob を返していたが、
 * Save Folder ごとに全 WAV を zip → unzip → write する round-trip が
 * 大きなオーバーヘッドになっていた。zip 化が必要な経路 (Deploy) は
 * `buildKitZip(files, packId)` を経由する遅延生成に切り替えた。
 *
 * @param kit - Kit 定義 (events は KitEvent[]、各 event が自前の clip data を保持)
 * @returns 書き出すファイル列 + packId + warnings
 */
export async function exportKitAsPack(
  kit: KitDefinition
): Promise<ExportResult> {
  const warnings: string[] = []
  const packId = toPackId(kit.name)
  const files: ExportFile[] = []

  // manifest に書き込む 2 bucket + install-clips metadata
  // 注: `events` bucket は command-mode 専用 (schema 2.0.0)
  const events: Record<string, unknown> = {}
  const streamEvents: Record<string, unknown> = {}
  const clipsMeta: Record<string, unknown> = {}

  // Per-event SHA-1 source hash — recorded as we encode so we can stamp
  // each ExportFile with the same hash later. Keys are `${ev.id}|${mode}`
  // to mirror the encoded-WAV cache layout, even though command and
  // stream of the same event share the underlying source hash (the
  // *source* audio is identical; what differs is the encoded output).
  const fileHashByPath = new Map<string, string>()

  // ファイル名の重複回避（install-clips / stream-clips それぞれ独立した namespace）
  const usedCommandNames = new Set<string>()
  const usedStreamNames = new Set<string>()

  // Per-event lazy decode. When every mode of this event hits the IDB
  // encoded-WAV cache (sourceHash unchanged since the last save), the
  // decoder is never touched — the dominant cost of Save Folder /
  // Deploy when the user only adjusts amp / intensity. The decode is
  // shared across modes (command + stream_clip) so multi-mode events
  // decode at most once.
  type DecodedAudio = {
    /** Decoded AudioBuffer ready to be re-encoded. `null` only when
     *  decode failed — in that case `fallback` is the raw bytes the
     *  caller can write as-is (best effort). */
    buffer: AudioBuffer | null
    fallback: Blob | null
    duration: number
    sourceChannels: number
  }
  // Warning de-dup: a multi-mode event would otherwise log the same
  // "16 kHz に変換" notice twice (once per mode).
  const warnedSampleRate = new Set<string>()
  const warnedDecodeFail = new Set<string>()

  const decodeSource = async (ev: KitEvent, sourceBlob: Blob): Promise<DecodedAudio> => {
    try {
      const arrayBuffer = await sourceBlob.arrayBuffer()
      const ctx = new OfflineAudioContext(1, 1, 44100)
      const decoded = await ctx.decodeAudioData(arrayBuffer.slice(0))
      if (decoded.sampleRate !== PACK_TARGET_SAMPLE_RATE && !warnedSampleRate.has(ev.id)) {
        warnings.push(`"${ev.clipName}" を ${decoded.sampleRate}Hz → ${PACK_TARGET_SAMPLE_RATE}Hz に変換しました`)
        warnedSampleRate.add(ev.id)
      }
      return {
        buffer: decoded,
        fallback: null,
        duration: decoded.duration,
        sourceChannels: decoded.numberOfChannels,
      }
    } catch (err) {
      if (!warnedDecodeFail.has(ev.id)) {
        warnings.push(`"${ev.clipName}" のデコードに失敗。元バイトをそのまま格納します (${err instanceof Error ? err.message : err})`)
        warnedDecodeFail.add(ev.id)
      }
      return {
        buffer: null,
        fallback: sourceBlob,
        duration: ev.clipDuration || 0,
        sourceChannels: ev.clipChannels || 1,
      }
    }
  }

  for (const ev of kit.events) {
    const modes = resolveModes(ev)

    // Event without backing clip is invalid in schema 2.0.0 (clip required
    // in both `events` and `stream_events`). Warn and skip.
    const hasClip = ev.clipName !== '' && ev.clipName !== undefined && ev.clipFileSize > 0
    if (!hasClip) {
      warnings.push(`"${ev.clipName || ev.eventId}" に音声が設定されていません (schema 2.0.0 では clip 必須)`)
      continue
    }

    // Load source blob + compute hash up front. We always need the
    // hash (cache key) and the blob serves as decode input on cache
    // miss / fallback bytes on decode failure.
    const sourceBlob = await loadKitEventAudio(ev.id)
    if (!sourceBlob) {
      warnings.push(`音声データが見つかりません: "${ev.clipName}" (event ${ev.id})`)
      continue
    }
    let sourceHash: string
    try {
      sourceHash = await sha1Hex(sourceBlob)
    } catch {
      // Insecure context / SubtleCrypto unavailable. Fall back to an
      // identity-marker that never matches cache; we still re-encode
      // every time but at least don't crash.
      sourceHash = `nohash-${ev.id}-${sourceBlob.size}`
    }

    // Lazy decode — only triggered when at least one mode misses the
    // encoded-WAV cache. Shared across modes of the same event.
    let decoded: DecodedAudio | null = null
    const ensureDecoded = async (): Promise<DecodedAudio> => {
      if (!decoded) decoded = await decodeSource(ev, sourceBlob)
      return decoded
    }

    for (const mode of modes) {
      const cacheMode: EncodedMode = mode === 'command' ? 'command' : 'stream_clip'

      // ---- Encoding for this mode ----
      //
      // Three paths in priority order. Each one assigns `encodedBlob`,
      // `encodedChannels`, `encodedDuration`, `outputHash`, and (for
      // telemetry only) `cachedThisTurn` exactly once.
      //
      // [A] Pass-through: source is **already** PCM16 at the target
      //     sample rate with the matching channel count. Use bytes
      //     verbatim. This is what saves hard-reload + re-pick scenarios:
      //     re-import of the on-disk WAV gives us a source identical
      //     to what's already on disk, and pass-through emits the same
      //     bytes back so outputHash matches the disk cache → skip.
      //     The float ⇄ int16 round trip (decode `/32768`, encode
      //     `*0x7fff`) costs ~1 ULP / sample of error, so the standard
      //     path is NOT bit-exact even when nothing changed.
      //
      // [B] IDB encoded-wavs hit: we encoded this exact source before
      //     (sourceHash match). Reuse the cached encoded blob.
      //
      // [C] Decode + encode: standard path. Decodes via AudioContext,
      //     resamples to 16 kHz, encodes to PCM16. Caches result.
      //
      // Pass-through eligibility (path A):
      //   - PCM (formatTag === 1), 16-bit, 16 kHz
      //   - command mode: any channel count (output preserves source ch)
      //   - stream_clip mode: stereo only (mono inputs need duplication)
      const wavInfo = await parseWavInfo(sourceBlob)
      const isPCM16AtTargetRate =
        !!wavInfo
        && wavInfo.formatTag === 1
        && wavInfo.bitsPerSample === 16
        && wavInfo.sampleRate === PACK_TARGET_SAMPLE_RATE
      const eligibleForPassThrough =
        isPCM16AtTargetRate
        && (mode === 'command' || (mode === 'stream_clip' && wavInfo!.channels === 2))

      let encodedBlob: Blob
      let encodedChannels: number
      let encodedDuration: number
      let outputHash: string
      let cachedThisTurn = false

      if (eligibleForPassThrough) {
        // [A] Pass-through — bytes-identical to source.
        encodedBlob = sourceBlob
        encodedChannels = wavInfo!.channels
        encodedDuration = wavInfo!.duration
        outputHash = await sha1Hex(encodedBlob)
        cachedThisTurn = true // CPU-equivalent to a cache hit
      } else {
        const cached = await loadEncodedWav(ev.id, cacheMode, sourceHash)
        if (cached) {
          // [B] IDB cache hit — reuse the encoded blob we built before.
          encodedBlob = cached.encodedBlob
          encodedChannels = cached.channels
          encodedDuration = cached.duration
          // Older cache entries may pre-date the outputHash field.
          // Hash the cached blob lazily + back-fill so next save is fast.
          if (cached.outputHash) {
            outputHash = cached.outputHash
          } else {
            outputHash = await sha1Hex(encodedBlob)
            try {
              await saveEncodedWav(ev.id, cacheMode, { ...cached, outputHash })
            } catch (err) {
              console.warn('[kitExporter] backfill outputHash failed', err)
            }
          }
          cachedThisTurn = true
        } else {
          // [C] Miss — decode (lazy, shared across modes) + encode for
          // this mode, then persist for the next save.
          const dec = await ensureDecoded()
          if (mode === 'command') {
            // install-clips/ preserves the source channel count — mono
            // stays mono (device flash is happy with either), stereo
            // stays stereo. This is the cheaper / smaller-on-flash
            // form and is the only thing the device firmware reads.
            encodedBlob = dec.buffer
              ? await encodeWavBlob(dec.buffer, PACK_TARGET_SAMPLE_RATE)
              : dec.fallback!
            encodedChannels = dec.buffer ? dec.buffer.numberOfChannels : dec.sourceChannels
            encodedDuration = dec.duration
          } else {
            // stream-clips/ は SDK 側が必ず stereo 16 kHz を仮定 (UDP
            // stream pipeline で L/R を per-side actuator に dispatch する
            // ため)。Mono は encodeStereoWavBlob が duplicate して 2ch
            // にする。
            encodedBlob = dec.buffer
              ? await encodeStereoWavBlob(dec.buffer, PACK_TARGET_SAMPLE_RATE)
              : dec.fallback!
            encodedChannels = 2
            encodedDuration = dec.duration
          }

          outputHash = await sha1Hex(encodedBlob)

          // Only cache successful decodes. Fallback bytes (= raw source
          // blob passed through unchanged on decode failure) aren't
          // worth caching because they'd reduce to a copy of the audio
          // store entry, doubling IDB size for no compute saving.
          if (dec.buffer) {
            const entry: EncodedWavEntry = {
              sourceHash,
              encodedBlob,
              outputHash,
              sampleRate: PACK_TARGET_SAMPLE_RATE,
              channels: encodedChannels,
              duration: encodedDuration,
            }
            try {
              await saveEncodedWav(ev.id, cacheMode, entry)
            } catch (err) {
              // IDB save failure shouldn't fail the export — log + carry on.
              console.warn('[kitExporter] encoded-WAV cache save failed', err)
            }
          }
        }
      }

      if (mode === 'command') {
        let fname = eventFileName(ev)
        if (usedCommandNames.has(fname)) {
          const base = fname.replace(/\.wav$/, '')
          let n = 2
          while (usedCommandNames.has(`${base}_${n}.wav`)) n++
          fname = `${base}_${n}.wav`
        }
        usedCommandNames.add(fname)
        const filePath = `install-clips/${fname}`
        files.push({ path: filePath, blob: encodedBlob, outputHash, cached: cachedThisTurn })
        fileHashByPath.set(filePath, outputHash)

        events[ev.eventId] = {
          clip: fname,
          description: '',
          parameters: {
            intensity: round2(ev.intensity),
            loop: ev.loop,
            ...(ev.deviceWiper !== null ? { device_wiper: ev.deviceWiper } : {}),
          },
        }

        clipsMeta[fname] = {
          duration_ms: round2(encodedDuration * 1000),
          sample_rate: PACK_TARGET_SAMPLE_RATE,
          channels: encodedChannels,
          format: 'pcm_s16le',
        }
      } else {
        let fname = eventFileName(ev)
        if (usedStreamNames.has(fname)) {
          const base = fname.replace(/\.wav$/, '')
          let n = 2
          while (usedStreamNames.has(`${base}_${n}.wav`)) n++
          fname = `${base}_${n}.wav`
        }
        usedStreamNames.add(fname)
        const filePath = `stream-clips/${fname}`
        files.push({ path: filePath, blob: encodedBlob, outputHash, cached: cachedThisTurn })
        fileHashByPath.set(filePath, outputHash)

        // stream_events の parameters は SDK 側のみが参照する。device_wiper
        // は stream モードでは無意味なので含めない (schema 2.0.0 仕様)。
        // loop は SDK 側ループ判断に使うので常に含める。
        streamEvents[ev.eventId] = {
          clip: fname,
          description: '',
          parameters: {
            intensity: round2(ev.intensity),
            loop: ev.loop,
          },
        }
      }
      // 他 mode (旧 stream_source 等) は schema 2.0.0 で削除済。
    }
  }
  // fileHashByPath は今は ExportFile.sourceHash で持っているので未使用。
  // 将来 path-base de-dup ロジックを足す場合に流用するため残置。
  void fileHashByPath

  // Author tuning context. We always emit firmware_version_min (the
  // schema requires it) but only keep extra hardware fields when the
  // user supplied them — keeps manifest.json clean for new kits.
  const td = kit.targetDevice ?? {}
  const targetDevice: Record<string, unknown> = {
    firmware_version_min: td.firmware_version_min || '0.1.0',
  }
  if (td.firmware_version_max) targetDevice.firmware_version_max = td.firmware_version_max
  if (td.board) targetDevice.board = td.board
  if (typeof td.volume_level === 'number') targetDevice.volume_level = td.volume_level
  if (typeof td.volume_wiper === 'number') targetDevice.volume_wiper = td.volume_wiper
  if (typeof td.volume_steps === 'number') targetDevice.volume_steps = td.volume_steps

  // The on-disk folder name IS the kit's identity. Keeping a
  // separate `kit_id` field next to `name` was just two ways to
  // spell the same string — they always carried the identical
  // value and nothing read both. Collapsed to a single `name`.
  // device firmware reads manifest["name"] (kit_loader.cpp) and
  // wire payloads carry the directory name in their `kit_id`
  // field (set by the caller, not pulled from manifest).
  const manifest = {
    schema_version: '2.0.0',
    version: kit.version || '1.0.0',
    name: packId,
    description: kit.description,
    author: '',
    created_at: new Date().toISOString(),
    target_device: targetDevice,
    events,
    ...(Object.keys(streamEvents).length > 0 ? { stream_events: streamEvents } : {}),
    install_clips: clipsMeta,
  }

  // manifest.json is always emitted as a fresh blob — it's tiny (<= a
  // few KB) and its content (parameters / intensity / target_device)
  // can change on any kit edit, so flushKitFolderNow writes it on
  // every save regardless of WAV-skip logic.
  const manifestJson = JSON.stringify(manifest, null, 2)
  files.push({
    path: manifestFileName(packId),
    blob: new Blob([manifestJson], { type: 'application/json' }),
    outputHash: null,
    cached: false,
  })

  return { files, packId, warnings }
}

/**
 * Build a Pack-format ZIP blob from `exportKitAsPack` output.
 *
 * Save Folder doesn't need this — it writes the files directly to the
 * kit folder. Deploy *does* need a single ZIP blob to ship to Helper
 * over the WebSocket, so we keep the ZIP path but make it lazy.
 *
 * Layout inside the ZIP: `<packId>/<file.path>` (mirrors the on-disk
 * folder under `<outRoot>/<packId>/`).
 */
export async function buildKitZip(
  files: ExportFile[],
  packId: string,
): Promise<{ blob: Blob; filename: string }> {
  const zip = new JSZip()
  const root = zip.folder(packId)!
  for (const f of files) {
    root.file(f.path, f.blob)
  }
  const blob = await zip.generateAsync({ type: 'blob' })
  return { blob, filename: `${packId}.hapbeat-kit` }
}

/** Blob をダウンロードさせるヘルパー */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  setTimeout(() => {
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }, 100)
}
