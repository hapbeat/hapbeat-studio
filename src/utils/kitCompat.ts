import type { KitDefinition } from '@/types/library'
import type { DeviceCaps } from './deviceCaps'

/**
 * Whether a device accepts the Kit Studio writes, judged by the device's
 * capability declaration (contracts `versioning.md` §5.4 / §11,
 * `serial-config.md` §4.1 `caps.kit_schema` / `caps.kit_clip_formats`).
 * helper checks the same before it writes; Studio checks first so the user
 * learns before the deploy starts.
 */

/** `schema_version` of the manifest Studio writes (`kit-format.md`). */
export const KIT_SCHEMA_VERSION = '2.0.0'
/** Audio format of a Kit's `install-clips/` today (WAV PCM16). */
export const KIT_CLIP_FORMAT = 'pcm16'

export type KitCompatProblem =
  /** The manifest's schema major is outside the device's `kit_schema` range. */
  | { kind: 'schema'; device: string; major: number; min?: number; max?: number }
  /** The device's `kit_clip_formats` does not list the Kit's clip format. */
  | { kind: 'clipFormat'; device: string; format: string }

export interface KitCompatTarget { ipAddress: string; name?: string }

function schemaMajor(version: string): number | null {
  const m = /^(\d+)\./.exec(version.trim())
  return m ? Number(m[1]) : null
}

/**
 * Every reason a target does not accept the Kit. A device without `caps`
 * (0.x firmware: no declaration, no added features) is not checked; a device
 * whose `get_info` has not arrived yet is not checked either and is listed in
 * `unchecked`.
 */
export function findKitCompatProblems(
  targets: readonly KitCompatTarget[],
  infoOf: (ip: string) => { caps?: DeviceCaps } | undefined,
  kit: { schemaVersion: string; clipFormat: string } = { schemaVersion: KIT_SCHEMA_VERSION, clipFormat: KIT_CLIP_FORMAT },
): { problems: KitCompatProblem[]; unchecked: string[] } {
  const problems: KitCompatProblem[] = []
  const unchecked: string[] = []
  const major = schemaMajor(kit.schemaVersion)
  for (const target of targets) {
    const device = target.name || target.ipAddress
    const info = infoOf(target.ipAddress)
    if (!info) { unchecked.push(device); continue }
    const caps = info.caps
    if (!caps) continue
    const range = caps.kit_schema
    if (major !== null && range
      && ((range.min !== undefined && major < range.min) || (range.max !== undefined && major > range.max))) {
      problems.push({ kind: 'schema', device, major, min: range.min, max: range.max })
    }
    if (caps.kit_clip_formats && !caps.kit_clip_formats.includes(kit.clipFormat)) {
      problems.push({ kind: 'clipFormat', device, format: kit.clipFormat })
    }
  }
  return { problems, unchecked }
}

/** `target_device.firmware_version_min` for a major: `<major>.0.0`, and `0.1.0` for 0.x (the first 0.x release). */
function firmwareMinForMajor(major: number): string {
  return major === 0 ? '0.1.0' : `${major}.0.0`
}

/**
 * The lowest firmware major the Kit needs (`versioning.md` §11). A Kit that
 * uses only today's format (WAV audio) runs on 0.x firmware too, so this is
 * `0.1.0`. A Kit using a feature added in 1.x (e.g. a future Opus clip format)
 * would need `1.0.0`; none exists yet.
 */
export function kitRequiredFirmwareMin(_kit: Pick<KitDefinition, 'events'>): string {
  return firmwareMinForMajor(0)
}

/** The user's FW min rounded to its major (`0.5.3` → `0.1.0`, `1.2.0` → `1.0.0`); undefined when it is not a version. */
export function roundFirmwareMin(value: string | undefined): string | undefined {
  const m = value ? /^v?(\d+)(?:\.\d+){0,2}/.exec(value.trim()) : null
  return m ? firmwareMinForMajor(Number(m[1])) : undefined
}

/** What the manifest gets: the Kit's own need or the user's value, whichever major is higher. */
export function kitFirmwareVersionMin(kit: Pick<KitDefinition, 'events' | 'targetDevice'>): string {
  const required = kitRequiredFirmwareMin(kit)
  const user = roundFirmwareMin(kit.targetDevice?.firmware_version_min)
  if (!user) return required
  return Number(user.split('.')[0]) > Number(required.split('.')[0]) ? user : required
}
