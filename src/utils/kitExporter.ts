/**
 * Kit → Pack 形式 ZIP エクスポーター
 *
 * hapbeat-contracts の pack-format.md に準拠した ZIP を生成する。
 * ZIP 内構造:
 *   <pack_id>/
 *     manifest.json
 *     clips/
 *       <clip-file>.wav
 */

import JSZip from 'jszip'
import type { KitDefinition, LibraryClip } from '@/types/library'
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

/** Kit 名 → pack_id (kebab-case, [a-z][a-z0-9-]*) */
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
 *  ベース名のみ取り出し、Pack 内では常に clips/ 直下に配置する。
 *  （ファームは clips/ 直下にのみ音声ファイルを期待する） */
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

/**
 * Kit を Pack 形式の ZIP にエクスポートする。
 *
 * @param kit - Kit 定義
 * @param clips - ライブラリ内の全クリップ（kit.events.clipId で参照）
 * @returns ZIP の Blob とファイル名
 * @throws クリップの音声データ取得に失敗した場合
 */
export async function exportKitAsPack(
  kit: KitDefinition,
  clips: LibraryClip[]
): Promise<ExportResult> {
  const warnings: string[] = []
  const packId = toPackId(kit.name)
  const zip = new JSZip()
  const root = zip.folder(packId)!

  // Event ID → clip ファイルパスのマッピング
  const events: Record<string, unknown> = {}
  const clipsMeta: Record<string, unknown> = {}
  const usedFileNames = new Set<string>()

  for (const ev of kit.events) {
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

    // 16 kHz PCM16 に normalize してから pack に入れる（device 側に resampler がないため）
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

    // ファイル名の重複回避
    let fname = clipFileName(clip)
    if (usedFileNames.has(fname)) {
      const base = fname.replace(/\.wav$/, '')
      let n = 2
      while (usedFileNames.has(`${base}_${n}.wav`)) n++
      fname = `${base}_${n}.wav`
    }
    usedFileNames.add(fname)

    // ZIP 内では clips/ 配下に配置するが、manifest 内の clip 参照は
    // clips/ からの相対パス（= ファイル名のみ）で記録する (contracts 準拠)
    root.file(`clips/${fname}`, packBlob)

    events[ev.eventId] = {
      clip: fname,
      description: '',
      tags: [],
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
  }

  const manifest = {
    schema_version: '1.0.0',
    pack_id: packId,
    version: kit.version || '1.0.0',
    name: kit.name,
    description: kit.description,
    author: '',
    created_at: new Date().toISOString(),
    target_device: {
      firmware_version_min: '0.1.0',
    },
    events,
    clips: clipsMeta,
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
