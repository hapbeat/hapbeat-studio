import type { DeviceCaps } from './deviceCaps'

/**
 * Firmware compatibility judged by major and the device's declared
 * capabilities (contracts `versioning.md` §3.4 / §5.1 / §5.4, DEC-096).
 *
 * Only majors are compared. This module deliberately holds no table of SDK /
 * firmware versions: the only compatibility table is `versioning.md` §9 and it
 * is linked, not copied (§5.5).
 */

const MAJOR = /^v?(\d+)\.\d+\.\d+/

/** `MAJOR` of a firmware version (`v` prefix and dev / pre-release suffixes ignored). */
export function firmwareMajor(fw: string | null | undefined): number | null {
  if (!fw) return null
  const m = MAJOR.exec(fw.trim())
  return m ? Number(m[1]) : null
}

/** The fields of a cached `get_info` reply this module reads. */
export interface StreamInfoFields {
  caps?: Pick<DeviceCaps, 'stream_gens'>
  stream_protocol?: number
}

/**
 * Stream generations a device accepts: `caps.stream_gens` (1.x) first, then
 * the 0.x `stream_protocol` integer. null when neither is present (Stream Gen 1
 * firmware, a node that does not take streams, or a helper that does not pass
 * the fields through).
 */
export function deviceStreamGens(info: StreamInfoFields | null | undefined): number[] | null {
  if (!info) return null
  if (Array.isArray(info.caps?.stream_gens)) return info.caps.stream_gens
  if (typeof info.stream_protocol === 'number') return [info.stream_protocol]
  return null
}

export interface FirmwareCompatNotice {
  /** The device's current major; null when its version is unknown. */
  fromMajor: number | null
  toMajor: number
  /** Stream generations the device accepts now, when it declared them. */
  currentStreamGens: number[] | null
}

/**
 * Notice to show before flashing `imageFw` onto `device` when the majors
 * differ. An image of unknown version (a local .bin without an app
 * descriptor) is not judged. A device of unknown version gets the notice with
 * `fromMajor: null`.
 */
export function firmwareCompatNotice(
  imageFw: string | null | undefined,
  device: { fw?: string | null; info?: StreamInfoFields | null },
): FirmwareCompatNotice | null {
  const toMajor = firmwareMajor(imageFw)
  if (toMajor === null) return null
  const fromMajor = firmwareMajor(device.fw)
  if (fromMajor === toMajor) return null
  return { fromMajor, toMajor, currentStreamGens: deviceStreamGens(device.info) }
}
