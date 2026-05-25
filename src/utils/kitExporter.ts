/**
 * Kit → Pack 形式 ZIP エクスポーター
 *
 * hapbeat-contracts の kit-format.md に準拠した ZIP を生成する。
 * ZIP 内構造 (DEC-027: clips/ → install-clips/, manifest.clips → manifest.install_clips):
 *   <kit_id>/
 *     <kit_id>-manifest.json   ← 旧 manifest.json (kit 名前置で識別性 ↑)
 *     install-clips/      ← command mode events の WAV (device flash 用)
 *       <clip-file>.wav
 *     stream-clips/       ← stream_clip mode events の WAV (SDK import 用, device には焼かない)
 *       <clip-file>.wav
 *
 * mode フィールド (DEC-023):
 *   - command      : device に焼かれる WAV clip。install-clips/ に配置。manifest に mode 省略 or "command" で記録。
 *   - stream_clip  : SDK が UDP ストリームで流す WAV。stream-clips/ に配置。device binary 除外。
 *   - stream_source: live audio capture。clip 不要。device binary 除外。
 */

import JSZip from 'jszip'
import type { KitDefinition, KitEvent, KitEventMode } from '@/types/library'
import { KIT_EVENT_MODE_SUFFIX } from '@/types/library'
import { loadKitEventAudio } from '@/utils/libraryStorage'
import { encodeStereoWavBlob, encodeWavBlob } from '@/utils/wavIO'

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

export interface ExportResult {
  blob: Blob
  filename: string
  warnings: string[]
}

/** Modes selected on a KitEvent, with a `'command'` fallback when migration
 *  left the array empty (shouldn't normally happen post-migrateKit). */
function resolveModes(ev: KitEvent): KitEventMode[] {
  const ms = ev.modes
  return Array.isArray(ms) && ms.length > 0 ? ms : ['command']
}

/**
 * Compose the manifest JSON key for `(eventId, mode)`. When `eventId` already
 * ends with the suffix for `mode` (the user authored it manually), don't
 * double-append. Otherwise append `.<suffix>` so multiple modes on the same
 * base eventId emit unique JSON keys.
 *
 * Only invoked when `modes.length > 1` — single-mode events keep the bare
 * eventId so existing kits stay byte-identical on round-trip.
 */
function composeSuffixedEventId(baseEventId: string, mode: KitEventMode): string {
  const suffix = KIT_EVENT_MODE_SUFFIX[mode]
  const tail = `.${suffix}`
  return baseEventId.endsWith(tail) ? baseEventId : `${baseEventId}${tail}`
}

/**
 * Kit を Pack 形式の ZIP にエクスポートする。
 *
 * 各 KitEvent は `modes: KitEventMode[]` で複数 mode を選択可。
 *   - command      → install-clips/ に WAV 配置、manifest entry に clip フィールド (bare filename)
 *   - stream_clip  → stream-clips/ に WAV 配置、manifest entry に mode + clip (stream-clips/<filename>)
 *   - stream_source → WAV 不要 (clip 未設定時)、manifest entry に mode のみ
 *
 * 複数 mode 選択時: 同じ KitEvent から mode ごとに 1 entry ずつ emit。
 * JSON dict は key 重複できないので eventId に `.fire` / `.clip` suffix を付ける
 * (`KIT_EVENT_MODE_SUFFIX`)。単一 mode の event は suffix を付けない。
 *
 * @param kit - Kit 定義 (events は KitEvent[]、各 event が自前の clip data を保持)
 * @returns ZIP の Blob とファイル名
 */
export async function exportKitAsPack(
  kit: KitDefinition
): Promise<ExportResult> {
  const warnings: string[] = []
  const packId = toPackId(kit.name)
  const zip = new JSZip()
  const root = zip.folder(packId)!

  // manifest に書き込む events / clips テーブル
  const events: Record<string, unknown> = {}
  const clipsMeta: Record<string, unknown> = {}

  // ファイル名の重複回避（install-clips / stream-clips それぞれ独立した namespace）
  const usedCommandNames = new Set<string>()
  const usedStreamNames = new Set<string>()

  // Cache the *decoded* AudioBuffer per kit event so a multi-mode
  // (FIRE+CLIP) event decodes once but encodes per output format —
  // command preserves the source channel count (mono stays mono),
  // stream forces stereo 16 kHz. Keeping the decode cached but the
  // encode per-mode is what enables both behaviours without a second
  // round trip through the AudioContext.
  type DecodedAudio = {
    /** Decoded AudioBuffer ready to be re-encoded. `null` only when
     *  decode failed — in that case `fallback` is the raw bytes the
     *  caller can write as-is (best effort). */
    buffer: AudioBuffer | null
    fallback: Blob | null
    duration: number
    /** Source sample rate / channel count — for metadata reporting,
     *  not the on-wire output (which is always normalised to
     *  PACK_TARGET_SAMPLE_RATE). */
    sourceSampleRate: number
    sourceChannels: number
  }
  const decodeCache = new Map<string, DecodedAudio | null>()
  // Warning de-dup: a multi-mode event would otherwise log the same
  // "16 kHz に変換" notice twice (once per mode).
  const warnedSampleRate = new Set<string>()
  const warnedDecodeFail = new Set<string>()

  const ensureDecode = async (ev: KitEvent): Promise<DecodedAudio | null> => {
    const cached = decodeCache.get(ev.id)
    if (cached !== undefined) return cached
    const audioBlob = await loadKitEventAudio(ev.id)
    if (!audioBlob) {
      decodeCache.set(ev.id, null)
      return null
    }
    let result: DecodedAudio
    try {
      const arrayBuffer = await audioBlob.arrayBuffer()
      const ctx = new OfflineAudioContext(1, 1, 44100)
      const decoded = await ctx.decodeAudioData(arrayBuffer.slice(0))
      result = {
        buffer: decoded,
        fallback: null,
        duration: decoded.duration,
        sourceSampleRate: decoded.sampleRate,
        sourceChannels: decoded.numberOfChannels,
      }
      if (decoded.sampleRate !== PACK_TARGET_SAMPLE_RATE && !warnedSampleRate.has(ev.id)) {
        warnings.push(`"${ev.clipName}" を ${decoded.sampleRate}Hz → ${PACK_TARGET_SAMPLE_RATE}Hz に変換しました`)
        warnedSampleRate.add(ev.id)
      }
    } catch (err) {
      if (!warnedDecodeFail.has(ev.id)) {
        warnings.push(`"${ev.clipName}" のデコードに失敗。元バイトをそのまま格納します (${err instanceof Error ? err.message : err})`)
        warnedDecodeFail.add(ev.id)
      }
      result = {
        buffer: null,
        fallback: audioBlob,
        duration: ev.clipDuration || 0,
        sourceSampleRate: ev.clipSampleRate || PACK_TARGET_SAMPLE_RATE,
        sourceChannels: ev.clipChannels || 1,
      }
    }
    decodeCache.set(ev.id, result)
    return result
  }

  for (const ev of kit.events) {
    const modes = resolveModes(ev)
    const isMulti = modes.length > 1

    for (const mode of modes) {
      const manifestKey = isMulti ? composeSuffixedEventId(ev.eventId, mode) : ev.eventId

      // --- stream_source で clip なし: WAV 省略、manifest に mode のみ記録 ---
      // Event with no clip data set is treated as "no audio" (consistent
      // with previous behaviour for stream_source kits authored without
      // a backing clip).
      const hasClip = ev.clipName !== '' && ev.clipName !== undefined && ev.clipFileSize > 0
      if (mode === 'stream_source' && !hasClip) {
        events[manifestKey] = {
          mode: 'stream_source',
          description: '',
          parameters: {
            intensity: round2(ev.intensity),
          },
        }
        continue
      }

      // --- command / stream_clip / stream_source(clip あり): WAV が必要 ---
      const decoded = await ensureDecode(ev)
      if (!decoded) {
        warnings.push(`音声データが見つかりません: "${ev.clipName}" (event ${ev.id})`)
        continue
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

        // install-clips/ preserves the source channel count — mono
        // stays mono (device flash is happy with either), stereo
        // stays stereo. This is the cheaper / smaller-on-flash form
        // and is the only thing the device firmware reads.
        const cmdBlob = decoded.buffer
          ? await encodeWavBlob(decoded.buffer, PACK_TARGET_SAMPLE_RATE)
          : decoded.fallback!
        const cmdChannels = decoded.buffer ? decoded.buffer.numberOfChannels : decoded.sourceChannels
        root.file(`install-clips/${fname}`, cmdBlob)

        // manifest: command 単独時は mode フィールド省略 (firmware の default=command と一致)。
        //   - 単一 mode (modes=['command']): mode 省略
        //   - multi mode (modes=['command', 'stream_clip']): 明示的に mode='command' を出力
        //     (suffix 付き key だけだと UI / SDK が mode を foldable しにくいため)
        events[manifestKey] = {
          ...(isMulti ? { mode: 'command' } : {}),
          clip: fname,
          description: '',
          parameters: {
            intensity: round2(ev.intensity),
            loop: ev.loop,
            ...(ev.deviceWiper !== null ? { device_wiper: ev.deviceWiper } : {}),
          },
        }

        clipsMeta[fname] = {
          duration_ms: round2(decoded.duration * 1000),
          sample_rate: PACK_TARGET_SAMPLE_RATE,
          channels: cmdChannels,
          format: 'pcm_s16le',
        }
      } else {
        // stream_clip / stream_source(clip あり): SDK import 用に stream-clips/ に配置。
        // **Always emit at stereo 16 kHz** — the SDK's streaming
        // pipeline assumes a fixed format so it can pre-allocate
        // buffers and dispatch L/R to per-side haptic actuators.
        // Mono sources are upmixed by duplicating to both channels
        // (encodeStereoWavBlob handles that). Decode failures fall
        // back to the raw input bytes; that path warns above but
        // can't itself guarantee stereo, so downstream may complain.
        let fname = eventFileName(ev)
        if (usedStreamNames.has(fname)) {
          const base = fname.replace(/\.wav$/, '')
          let n = 2
          while (usedStreamNames.has(`${base}_${n}.wav`)) n++
          fname = `${base}_${n}.wav`
        }
        usedStreamNames.add(fname)

        const streamBlob = decoded.buffer
          ? await encodeStereoWavBlob(decoded.buffer, PACK_TARGET_SAMPLE_RATE)
          : decoded.fallback!
        root.file(`stream-clips/${fname}`, streamBlob)

        // parameters: stream モード自体は loop / device_wiper を解釈しないが、
        // multi-mode 出力時は **command 側と同じ parameters** を書き出す。
        // import 時の bucket-merge 判定が「loop / deviceWiper 完全一致」を
        // 要求するため、片側だけ field を落とすと re-import で merge が
        // 壊れて KitEvent が分裂する round-trip regression が起きる
        // (self-review 2026-05-17)。single-mode の stream は従来通り
        // intensity のみで構わない (merge 判定対象にならないため)。
        events[manifestKey] = {
          mode,  // 'stream_clip' or 'stream_source'
          clip: `stream-clips/${fname}`,
          description: '',
          parameters: {
            intensity: round2(ev.intensity),
            ...(isMulti ? {
              loop: ev.loop,
              ...(ev.deviceWiper !== null ? { device_wiper: ev.deviceWiper } : {}),
            } : {}),
          },
        }
        // stream-clips の metadata は将来的に独立テーブルで管理 (device binary には不要)。
      }
    }
  }

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
    schema_version: '1.0.0',
    version: kit.version || '1.0.0',
    name: packId,
    description: kit.description,
    author: '',
    created_at: new Date().toISOString(),
    target_device: targetDevice,
    events,
    install_clips: clipsMeta,
  }

  root.file(manifestFileName(packId), JSON.stringify(manifest, null, 2))

  const blob = await zip.generateAsync({ type: 'blob' })
  const filename = `${packId}.hapbeat-kit`

  return { blob, filename, warnings }
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
