/**
 * Kit → Pack 形式 ZIP エクスポーター
 *
 * hapbeat-contracts の kit-format.md に準拠した ZIP を生成する。
 * ZIP 内構造 (DEC-027: clips/ → install-clips/, manifest.clips → manifest.install_clips):
 *   <kit_id>/
 *     manifest.json
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
import type { KitDefinition, KitEventMode, LibraryClip } from '@/types/library'
import { loadClipAudio } from '@/utils/libraryStorage'
import { encodeWavBlob } from '@/utils/wavIO'

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

/** クリップファイル名を安全な形にする。
 *  sourceFilename が "HandDemo/foo.wav" のようにサブフォルダを含む場合でも
 *  ベース名のみ取り出し、Pack 内では常に install-clips/ 直下に配置する。
 *  （ファームは install-clips/ 直下にのみ音声ファイルを期待する） */
function clipFileName(clip: LibraryClip): string {
  const srcBase = (clip.sourceFilename || '').split('/').pop() || ''
  const base = srcBase || `${clip.name}.wav`
  // 拡張子が .wav でなければ付ける（元ファイルが mp3 等でも保存時は WAV blob）
  return base.endsWith('.wav') ? base : base.replace(/\.[^.]+$/, '.wav')
}

export interface ExportResult {
  blob: Blob
  filename: string
  warnings: string[]
}

/** Resolve the effective mode of a KitEvent, defaulting to "command". */
function resolveMode(mode: KitEventMode | undefined): KitEventMode {
  return mode ?? 'command'
}

/**
 * Kit を Pack 形式の ZIP にエクスポートする。
 *
 * mode=command  → install-clips/ に WAV 配置、manifest に clip フィールドあり (bare filename)
 * mode=stream_clip → stream-clips/ に WAV 配置、manifest に mode + clip フィールド (stream-clips/<filename>)
 *                    ただし device binary の install-clips/ には含めない
 * mode=stream_source → WAV 不要、manifest に mode フィールドのみ
 *
 * @param kit - Kit 定義
 * @param clips - ライブラリ内の全クリップ（kit.events.clipId で参照）
 * @returns ZIP の Blob とファイル名
 */
export async function exportKitAsPack(
  kit: KitDefinition,
  clips: LibraryClip[]
): Promise<ExportResult> {
  const warnings: string[] = []
  const packId = toPackId(kit.name)
  const zip = new JSZip()
  const root = zip.folder(packId)!

  // manifest に書き込む events / clips テーブル
  const events: Record<string, unknown> = {}
  const clipsMeta: Record<string, unknown> = {}

  // ファイル名の重複回避（command / stream_clip それぞれ独立した namespace）
  const usedCommandNames = new Set<string>()
  const usedStreamNames = new Set<string>()

  for (const ev of kit.events) {
    const mode = resolveMode(ev.mode)

    // --- stream_source で clip なし: WAV 省略、manifest に mode のみ記録 ---
    // clip が設定されていれば stream_clip と同様に stream-clips/ に配置する。
    // Unity SDK は clip フィールドを参照して AudioSource のデフォルトクリップに使用する。
    const hasClip = !!ev.clipId && clips.some((c) => c.id === ev.clipId)
    if (mode === 'stream_source' && !hasClip) {
      events[ev.eventId] = {
        mode: 'stream_source',
        description: '',
        parameters: {
          intensity: round2(ev.intensity),
        },
      }
      continue
    }

    // --- command / stream_clip / stream_source(clip あり): WAV が必要 ---
    const clip = clips.find((c) => c.id === ev.clipId)
    if (!clip) {
      warnings.push(`クリップが見つかりません: eventId="${ev.eventId}", clipId="${ev.clipId}"`)
      continue
    }

    // 音声データを IndexedDB から取得
    const audioBlob = await loadClipAudio(clip.id)
    if (!audioBlob) {
      warnings.push(`音声データが見つかりません: "${clip.name}" (${clip.id})`)
      continue
    }

    // command は 16 kHz PCM16 に normalize（device 側に resampler なし）
    // stream_clip も同じ normalize を適用しておく（SDK が decode しやすいように）
    let packBlob: Blob
    let packSampleRate: number
    let packChannels: number
    let packDuration: number
    try {
      const arrayBuffer = await audioBlob.arrayBuffer()
      const ctx = new OfflineAudioContext(1, 1, 44100)
      const decoded = await ctx.decodeAudioData(arrayBuffer.slice(0))
      packBlob = await encodeWavBlob(decoded, PACK_TARGET_SAMPLE_RATE)
      packSampleRate = PACK_TARGET_SAMPLE_RATE
      packChannels = decoded.numberOfChannels
      packDuration = decoded.duration
      if (decoded.sampleRate !== PACK_TARGET_SAMPLE_RATE) {
        warnings.push(`"${clip.name}" を ${decoded.sampleRate}Hz → ${PACK_TARGET_SAMPLE_RATE}Hz に変換しました`)
      }
    } catch (err) {
      warnings.push(`"${clip.name}" のデコードに失敗。元バイトをそのまま格納します (${err instanceof Error ? err.message : err})`)
      packBlob = audioBlob
      packSampleRate = clip.sampleRate
      packChannels = clip.channels
      packDuration = clip.duration
    }

    if (mode === 'command') {
      // ファイル名の重複回避 (command namespace)
      let fname = clipFileName(clip)
      if (usedCommandNames.has(fname)) {
        const base = fname.replace(/\.wav$/, '')
        let n = 2
        while (usedCommandNames.has(`${base}_${n}.wav`)) n++
        fname = `${base}_${n}.wav`
      }
      usedCommandNames.add(fname)

      // ZIP に配置（install-clips/ = device binary 対象, DEC-027）
      root.file(`install-clips/${fname}`, packBlob)

      // manifest: mode=command は mode フィールドを省略（後方互換、firmware の default=command と一致）
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
        duration_ms: round2(packDuration * 1000),
        sample_rate: packSampleRate,
        channels: packChannels,
        format: 'pcm_s16le',
      }
    } else {
      // stream_clip / stream_source(clip あり): SDK import 用に stream-clips/ に配置。
      // stream_source の clip は Unity SDK が AudioSource のデフォルトクリップとして使用する。
      // device binary の install-clips/ には含めない点は stream_clip と同じ。
      let fname = clipFileName(clip)
      if (usedStreamNames.has(fname)) {
        const base = fname.replace(/\.wav$/, '')
        let n = 2
        while (usedStreamNames.has(`${base}_${n}.wav`)) n++
        fname = `${base}_${n}.wav`
      }
      usedStreamNames.add(fname)

      // ZIP に配置（stream-clips/ = device binary 対象外）
      root.file(`stream-clips/${fname}`, packBlob)

      // manifest: mode フィールドは実際の mode 値を使用、clip パスは stream-clips/ 相対
      events[ev.eventId] = {
        mode,  // 'stream_clip' or 'stream_source'
        clip: `stream-clips/${fname}`,
        description: '',
        parameters: {
          intensity: round2(ev.intensity),
        },
      }
      // stream-clips の metadata は install_clips テーブルではなく将来的に stream-clips テーブルで管理。
      // 現時点は manifest.install_clips には含めない（device binary には不要なため）。
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

  const manifest = {
    schema_version: '1.0.0',
    kit_id: packId,
    version: kit.version || '1.0.0',
    name: kit.name,
    description: kit.description,
    author: '',
    created_at: new Date().toISOString(),
    target_device: targetDevice,
    events,
    install_clips: clipsMeta,
  }

  root.file('manifest.json', JSON.stringify(manifest, null, 2))

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
