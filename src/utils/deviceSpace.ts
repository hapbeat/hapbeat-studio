/**
 * Device clip storage as reported by `space_result`, and whether a kit fits.
 *
 * Helper answers `query_space` for ONE device (the `target` IP) with
 * total / used / free bytes of the audio partition. Newer helper + firmware
 * also send `toc_count` / `toc_max` (clip table entries) and `fs_free`
 * (LittleFS bytes, where the manifest lives); each is optional.
 * Old firmware answers 0 for everything — that is "unknown", not "empty".
 */
import type { KitStorageEstimate } from '@/utils/kitSizeEstimate'

export interface DeviceSpace {
  totalBytes: number
  usedBytes: number
  freeBytes: number
  tocCount?: number
  tocMax?: number
  fsFree?: number
}

export type SpaceEntry =
  | { state: 'pending' }
  | { state: 'ok'; space: DeviceSpace }
  | { state: 'unknown' }

const finiteNonNegative = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined

/** A usable reading from a `space_result` payload, or null (error / old firmware). */
export function parseSpaceResult(payload: Record<string, unknown>): DeviceSpace | null {
  if (payload.error) return null
  const totalBytes = finiteNonNegative(payload.total_bytes)
  const freeBytes = finiteNonNegative(payload.free_bytes)
  if (!totalBytes || freeBytes === undefined || freeBytes > totalBytes) return null
  const usedBytes = finiteNonNegative(payload.used_bytes) ?? totalBytes - freeBytes
  const space: DeviceSpace = { totalBytes, usedBytes, freeBytes }
  const tocCount = finiteNonNegative(payload.toc_count)
  const tocMax = finiteNonNegative(payload.toc_max)
  if (tocCount !== undefined && tocMax) { space.tocCount = tocCount; space.tocMax = tocMax }
  const fsFree = finiteNonNegative(payload.fs_free)
  if (fsFree !== undefined) space.fsFree = fsFree
  return space
}

/**
 * Audio partition size by board (firmware partitions.csv / partitions_v4.csv,
 * minus the clip table). Only an estimate of the total — it says nothing
 * about how much is already used.
 */
export const AUDIO_PARTITION_8MB_BYTES = 4_186_112
export const AUDIO_PARTITION_16MB_BYTES = 7_790_592

export function boardAudioPartitionBytes(board: string | undefined): number | null {
  if (!board) return null
  if (board === 'duo_wl_v4') return AUDIO_PARTITION_16MB_BYTES
  if (board.startsWith('duo_wl') || board.startsWith('band_wl')) return AUDIO_PARTITION_8MB_BYTES
  return null
}

export interface SpaceTarget {
  ipAddress: string
  name: string
}

export interface TargetSpaceSummary {
  /** Devices the kit would go to. */
  targetCount: number
  /** Devices with a valid reading. */
  knownCount: number
  pendingCount: number
  /** The known device with the least free space (the one that limits the kit). */
  limiting: { ip: string; name: string; space: DeviceSpace } | null
  /** When no device has a reading: the smallest board partition among the
   *  targets whose board is known (labelled estimate, used bytes unknown). */
  boardEstimate: { bytes: number; board: string } | null
}

export function summarizeTargetSpace(
  targets: readonly SpaceTarget[],
  entries: Readonly<Record<string, SpaceEntry>>,
  boardOf: (ip: string) => string | undefined,
): TargetSpaceSummary {
  let knownCount = 0
  let pendingCount = 0
  let limiting: TargetSpaceSummary['limiting'] = null
  let boardEstimate: TargetSpaceSummary['boardEstimate'] = null
  for (const target of targets) {
    const entry = entries[target.ipAddress]
    if (entry?.state === 'ok') {
      knownCount++
      if (!limiting || entry.space.freeBytes < limiting.space.freeBytes) {
        limiting = { ip: target.ipAddress, name: target.name, space: entry.space }
      }
      continue
    }
    if (entry?.state === 'pending') pendingCount++
    const board = boardOf(target.ipAddress)
    const bytes = boardAudioPartitionBytes(board)
    if (bytes !== null && board && (!boardEstimate || bytes < boardEstimate.bytes)) {
      boardEstimate = { bytes, board }
    }
  }
  return {
    targetCount: targets.length,
    knownCount,
    pendingCount,
    limiting,
    boardEstimate: knownCount === 0 ? boardEstimate : null,
  }
}

export type CapacityProblem =
  /** Clip audio does not fit in the device's free partition space. */
  | { kind: 'clips'; device: string; needBytes: number; freeBytes: number }
  /** More clips than free clip-table entries. */
  | { kind: 'toc'; device: string; needEntries: number; freeEntries: number }
  /** Manifest does not fit in the device's free LittleFS space. */
  | { kind: 'fs'; device: string; needBytes: number; freeBytes: number }
  /** No reading, but the kit exceeds the board's whole partition. */
  | { kind: 'board'; device: string; needBytes: number; capacityBytes: number }

/**
 * Every reason the kit cannot be installed on one of the targets. Devices
 * without a reading are only checked against their board's partition size
 * (a kit that fits an empty device is not blocked on a guess).
 */
export function findCapacityProblems(
  estimate: KitStorageEstimate,
  targets: readonly SpaceTarget[],
  entries: Readonly<Record<string, SpaceEntry>>,
  boardOf: (ip: string) => string | undefined,
): CapacityProblem[] {
  const problems: CapacityProblem[] = []
  if (estimate.clipCount === 0 && estimate.manifestBytes === 0) return problems
  for (const target of targets) {
    const device = target.name || target.ipAddress
    const entry = entries[target.ipAddress]
    if (entry?.state !== 'ok') {
      const capacityBytes = boardAudioPartitionBytes(boardOf(target.ipAddress))
      if (capacityBytes !== null && estimate.clipBytes > capacityBytes) {
        problems.push({ kind: 'board', device, needBytes: estimate.clipBytes, capacityBytes })
      }
      continue
    }
    const { space } = entry
    if (estimate.clipBytes > space.freeBytes) {
      problems.push({ kind: 'clips', device, needBytes: estimate.clipBytes, freeBytes: space.freeBytes })
    }
    if (space.tocMax !== undefined && space.tocCount !== undefined
      && space.tocCount + estimate.clipCount > space.tocMax) {
      problems.push({ kind: 'toc', device, needEntries: estimate.clipCount, freeEntries: Math.max(0, space.tocMax - space.tocCount) })
    }
    if (space.fsFree !== undefined && estimate.manifestBytes > space.fsFree) {
      problems.push({ kind: 'fs', device, needBytes: estimate.manifestBytes, freeBytes: space.fsFree })
    }
  }
  return problems
}
