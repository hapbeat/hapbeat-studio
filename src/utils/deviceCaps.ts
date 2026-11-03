/**
 * Device capability declaration (`caps`) and the storage / stream fields that
 * travel with it in `get_info` (contracts `serial-config.md` §4.1, DEC-096).
 *
 * Studio decides what a device can do from these declarations, never from
 * comparing firmware versions (`versioning.md` §3.4 / §5.4). A device without
 * `caps` (0.x firmware, or a helper that does not pass it through) is treated
 * as generation 0 with no added features. Unknown fields are dropped: readers
 * ignore what they do not understand (`versioning.md` §7.1).
 */
export interface DeviceCaps {
  caps_version?: number
  /** Firmware major. */
  generation?: number
  /** Stream generations the receiver accepts. `[]` for non-stream nodes. */
  stream_gens?: number[]
  stream_formats?: string[]
  lease_ttl_s?: number
  lease_slots?: number
  inactivity_timeout_s?: number
  /** Number of motors the device drives (1 = mono, 2 = left/right). */
  haptic_channels?: number
  address_max_len?: number
  features?: string[]
  /** Accepted range of the Kit manifest `schema_version` major. */
  kit_schema?: { min?: number; max?: number }
  /** Audio formats accepted for a Kit's `install-clips/`. */
  kit_clip_formats?: string[]
  ui_elements?: string[]
}

/** Storage areas a device can report in `storage_incompatible` (§4.1). */
export type StorageArea = 'audio_partition' | 'kit_manifest' | 'ui_config' | 'nvs'

export const STORAGE_AREAS: readonly StorageArea[] = ['audio_partition', 'kit_manifest', 'ui_config', 'nvs']

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const numArray = (v: unknown): number[] | undefined =>
  Array.isArray(v) ? v.filter(isNum) : undefined
const strArray = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined
const num = (v: unknown): number | undefined => (isNum(v) ? v : undefined)

/** Keep the known `caps` fields with the right types; anything else is dropped. */
export function parseDeviceCaps(raw: unknown): DeviceCaps | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  const ks = r.kit_schema
  const kitSchema = ks && typeof ks === 'object' && !Array.isArray(ks)
    ? { min: num((ks as Record<string, unknown>).min), max: num((ks as Record<string, unknown>).max) }
    : undefined
  return {
    caps_version: num(r.caps_version),
    generation: num(r.generation),
    stream_gens: numArray(r.stream_gens),
    stream_formats: strArray(r.stream_formats),
    lease_ttl_s: num(r.lease_ttl_s),
    lease_slots: num(r.lease_slots),
    inactivity_timeout_s: num(r.inactivity_timeout_s),
    haptic_channels: num(r.haptic_channels),
    address_max_len: num(r.address_max_len),
    features: strArray(r.features),
    kit_schema: kitSchema,
    kit_clip_formats: strArray(r.kit_clip_formats),
    ui_elements: strArray(r.ui_elements),
  }
}

/** `storage_incompatible` limited to the areas the contract defines. */
export function parseStorageIncompatible(raw: unknown): StorageArea[] | undefined {
  const list = strArray(raw)
  if (!list) return undefined
  return list.filter((a): a is StorageArea => (STORAGE_AREAS as readonly string[]).includes(a))
}

/** The `get_info` fields this module owns, parsed from a raw reply. */
export function parseCapsFields(r: Record<string, unknown>): {
  caps?: DeviceCaps
  stream_protocol?: number
  stream_formats?: string[]
  storage_incompatible?: StorageArea[]
} {
  return {
    caps: parseDeviceCaps(r.caps),
    stream_protocol: num(r.stream_protocol),
    stream_formats: strArray(r.stream_formats),
    // Absent = no mismatch (§4.1). An explicit [] so a cached list from before a
    // reset is replaced: the info cache merge keeps fields a reply leaves undefined.
    storage_incompatible: parseStorageIncompatible(r.storage_incompatible) ?? [],
  }
}
