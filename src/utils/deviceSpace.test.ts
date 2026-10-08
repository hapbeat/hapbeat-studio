import { describe, it, expect } from 'vitest'
import {
  AUDIO_PARTITION_16MB_BYTES,
  AUDIO_PARTITION_8MB_BYTES,
  boardAudioPartitionBytes,
  findCapacityProblems,
  parseSpaceResult,
  summarizeTargetSpace,
  type SpaceEntry,
} from './deviceSpace'
import type { KitStorageEstimate } from './kitSizeEstimate'

const MB = 1024 * 1024

describe('parseSpaceResult', () => {
  it('reads total / used / free', () => {
    expect(parseSpaceResult({ device: 'x', total_bytes: 4 * MB, used_bytes: MB, free_bytes: 3 * MB }))
      .toEqual({ totalBytes: 4 * MB, usedBytes: MB, freeBytes: 3 * MB })
  })
  it('old firmware zeros and errors are unknown, not empty', () => {
    expect(parseSpaceResult({ device: 'x', total_bytes: 0, used_bytes: 0, free_bytes: 0 })).toBeNull()
    expect(parseSpaceResult({ device: 'x', error: 'query failed' })).toBeNull()
    expect(parseSpaceResult({ device: 'x' })).toBeNull()
    expect(parseSpaceResult({ device: 'x', total_bytes: 10, free_bytes: 20 })).toBeNull()
  })
  it('optional toc / LittleFS fields', () => {
    expect(parseSpaceResult({ total_bytes: 100, used_bytes: 40, free_bytes: 60, toc_count: 3, toc_max: 128, fs_free: 5000 }))
      .toEqual({ totalBytes: 100, usedBytes: 40, freeBytes: 60, tocCount: 3, tocMax: 128, fsFree: 5000 })
    // toc_count without toc_max is ignored
    expect(parseSpaceResult({ total_bytes: 100, free_bytes: 60, toc_count: 3 }))
      .toEqual({ totalBytes: 100, usedBytes: 40, freeBytes: 60 })
  })
})

describe('boardAudioPartitionBytes', () => {
  it('by board id', () => {
    expect(boardAudioPartitionBytes('duo_wl_v4')).toBe(AUDIO_PARTITION_16MB_BYTES)
    expect(boardAudioPartitionBytes('duo_wl_v3')).toBe(AUDIO_PARTITION_8MB_BYTES)
    expect(boardAudioPartitionBytes('band_wl_v4')).toBe(AUDIO_PARTITION_8MB_BYTES)
    expect(boardAudioPartitionBytes('atom_lite')).toBeNull()
    expect(boardAudioPartitionBytes(undefined)).toBeNull()
  })
})

const ok = (free: number, extra: Partial<{ tocCount: number; tocMax: number; fsFree: number }> = {}): SpaceEntry =>
  ({ state: 'ok', space: { totalBytes: 4 * MB, usedBytes: 4 * MB - free, freeBytes: free, ...extra } })
const targets = [{ ipAddress: '10.0.0.1', name: 'A' }, { ipAddress: '10.0.0.2', name: 'B' }]
const est = (clipBytes: number, clipCount = 2, manifestBytes = 1000): KitStorageEstimate =>
  ({ clipBytes, clipCount, manifestBytes, basis: 'metadata' })

describe('summarizeTargetSpace', () => {
  it('limits to the device with the least free space', () => {
    const s = summarizeTargetSpace(targets, { '10.0.0.1': ok(3 * MB), '10.0.0.2': ok(MB) }, () => undefined)
    expect(s.knownCount).toBe(2)
    expect(s.limiting?.name).toBe('B')
    expect(s.boardEstimate).toBeNull()
  })
  it('board estimate only when no device reported', () => {
    const s = summarizeTargetSpace(targets, { '10.0.0.1': { state: 'unknown' }, '10.0.0.2': { state: 'pending' } },
      (ip) => ip === '10.0.0.1' ? 'duo_wl_v4' : 'band_wl_v3')
    expect(s.limiting).toBeNull()
    expect(s.pendingCount).toBe(1)
    expect(s.boardEstimate).toEqual({ bytes: AUDIO_PARTITION_8MB_BYTES, board: 'band_wl_v3' })
  })
})

describe('findCapacityProblems', () => {
  it('blocks when clips exceed free on any target', () => {
    const p = findCapacityProblems(est(2 * MB), targets, { '10.0.0.1': ok(3 * MB), '10.0.0.2': ok(MB) }, () => undefined)
    expect(p).toEqual([{ kind: 'clips', device: 'B', needBytes: 2 * MB, freeBytes: MB }])
  })
  it('fits → no problems', () => {
    expect(findCapacityProblems(est(MB), targets, { '10.0.0.1': ok(3 * MB), '10.0.0.2': ok(2 * MB) }, () => undefined)).toEqual([])
  })
  it('clip table and LittleFS limits when reported', () => {
    const p = findCapacityProblems(est(100, 5, 6000), [targets[0]], { '10.0.0.1': ok(MB, { tocCount: 30, tocMax: 32, fsFree: 4000 }) }, () => undefined)
    expect(p).toEqual([
      { kind: 'toc', device: 'A', needEntries: 5, freeEntries: 2 },
      { kind: 'fs', device: 'A', needBytes: 6000, freeBytes: 4000 },
    ])
  })
  it('unknown device: only blocks beyond the whole board partition', () => {
    const entries = { '10.0.0.1': { state: 'unknown' } as SpaceEntry }
    expect(findCapacityProblems(est(MB), [targets[0]], entries, () => 'band_wl_v4')).toEqual([])
    expect(findCapacityProblems(est(5 * MB), [targets[0]], entries, () => 'band_wl_v4'))
      .toEqual([{ kind: 'board', device: 'A', needBytes: 5 * MB, capacityBytes: AUDIO_PARTITION_8MB_BYTES }])
    expect(findCapacityProblems(est(5 * MB), [targets[0]], entries, () => 'duo_wl_v4')).toEqual([])
    expect(findCapacityProblems(est(50 * MB), [targets[0]], entries, () => undefined)).toEqual([])
  })
})
