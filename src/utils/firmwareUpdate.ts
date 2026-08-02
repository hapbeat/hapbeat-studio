/**
 * 「このデバイスのファームは最新か」を判定する軽量ヘルパー。
 *
 * デバイスファームは release feed の対象外 — Studio は既に統合 firmware
 * manifest (最新 + アーカイブ) をローカルに持っており、そちらの方が確実で
 * オフラインでも動くため (hapbeat-contracts specs/release-feed.md §1)。
 *
 * 誤報を出さないことを最優先にしている: board / transport から候補を絞っても
 * 版が一意に決まらない場合は **通知しない**。「更新があります」と言われて
 * Firmware タブを開いたら同じ版だった、という体験の方が害が大きい。
 */
import { useEffect, useState } from 'react'
import {
  compareVersions,
  listFirmwareBuilds,
  normalizeVersion,
  type FirmwareLibraryEntry,
} from './firmwareLibrary'
import type { NodeTransport } from '@/types/manager'

// デバイスを切り替えるたびに manifest を取り直さないようモジュール単位で
// キャッシュする。Firmware タブの「⟳ 更新」は従来どおり自前で読み直すので、
// 明示的な再取得の導線はそちらが持つ。
let cache: Promise<FirmwareLibraryEntry[]> | null = null

function loadLibraryCached(): Promise<FirmwareLibraryEntry[]> {
  if (!cache) cache = listFirmwareBuilds().catch(() => [] as FirmwareLibraryEntry[])
  return cache
}

/**
 * board (+ transport) に対応するファームの最新版。
 * 判定できない場合は null (= 何も表示しない)。
 */
export function resolveLatestFirmware(
  entries: FirmwareLibraryEntry[],
  board: string | undefined,
  transport: NodeTransport | undefined,
): string | null {
  if (!board) return null

  const byBoard = entries.filter((e) => e.board && e.board === board)
  if (byBoard.length === 0) return null

  // 同じ board でも transport 違いの env が並ぶ (udp / mqtt / espnow_stream)。
  // DEC-035 で env ごとに独立採番になったため、transport が分かるなら必ず絞る。
  const byTransport = transport
    ? byBoard.filter((e) => e.transport === transport || e.transports?.includes(transport))
    : []
  const pool = byTransport.length > 0 ? byTransport : byBoard

  const versions = new Set(
    pool.map((e) => normalizeVersion(e.fwVersion)).filter((v) => v.length > 0),
  )
  // 候補が複数版に割れる = どれが「この個体の最新」か決められない → 黙る。
  if (versions.size !== 1) return null
  return [...versions][0]
}

/**
 * このデバイスに対して新しいファームが出ているか。
 * 戻り値は最新版の文字列 (更新あり) か null (最新 / 判定不能)。
 */
export function useFirmwareUpdate(
  board: string | undefined,
  transport: NodeTransport | undefined,
  currentFw: string | null | undefined,
): string | null {
  const [entries, setEntries] = useState<FirmwareLibraryEntry[] | null>(null)

  useEffect(() => {
    let cancelled = false
    loadLibraryCached().then((e) => { if (!cancelled) setEntries(e) })
    return () => { cancelled = true }
  }, [])

  if (!entries || !currentFw) return null
  const latest = resolveLatestFirmware(entries, board, transport)
  if (!latest) return null
  // compareVersions は「新しい方が前に来る」降順比較 (< 0 なら a が新しい)。
  return compareVersions(latest, currentFw) < 0 ? latest : null
}
