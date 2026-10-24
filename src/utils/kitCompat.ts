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
