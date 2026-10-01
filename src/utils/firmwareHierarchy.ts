/**
 * Firmware library hierarchy — device-oriented grouping.
 *
 * The library is browsed the way a user thinks about the hardware in
 * front of them: first the product family (DuoWL / BandWL / 周辺機器),
 * then the hardware revision (v3 / v4 …), and only then the firmware
 * variants that actually fit that board (Wi-Fi UDP / ESP-NOW / MQTT …).
 *
 * Everything here is pure so it can be unit-tested without React; the
 * component owns only state + JSX.
 */

import type { FirmwareLibraryEntry } from '@/utils/firmwareLibrary'
import { inferVariantFromEnv, isPwmEntry, matchesHapticOutput } from '@/utils/firmwareLibrary'
import { isHapbeatBoard, isKnownNonHapbeatBoard } from '@/utils/hapbeatBoard'

/**
 * Level-1 key.
 * - `duo` / `band`: Hapbeat wearables, split by product line.
 * - `peripheral`: every other node type (sensor / broker / transmitter).
 * - `other`: a Hapbeat-flagged entry whose board can't be parsed into a
 *   product line. Not expected with current data, but we surface it
 *   rather than silently dropping the firmware from the library.
 */
export type FirmwareFamily = 'duo' | 'band' | 'peripheral' | 'other'

export const FAMILY_ORDER: FirmwareFamily[] = ['duo', 'band', 'peripheral', 'other']

export const FAMILY_LABEL: Record<FirmwareFamily, string> = {
  duo: 'DuoWL',
  band: 'BandWL',
  peripheral: '周辺機器',
  other: 'その他',
}

/** The board a library entry expects (explicit manifest board, else inferred). */
export function entryBoard(e: FirmwareLibraryEntry): string | null {
  return e.board ?? inferVariantFromEnv(e.env).board ?? null
}

/**
 * Is this entry a Hapbeat wearable build?
 *
 * Keyed off the explicit `hapbeat` flag (variant.json), NOT role: a
 * 3rd-party MQTT node can also be role=receiver, so role isn't a
 * reliable "is Hapbeat" signal (user 2026-06-15). Falls back to the
 * board prefix when the flag is absent.
 */
export function isHapbeatEntry(e: FirmwareLibraryEntry): boolean {
  return e.hapbeat ?? isHapbeatBoard(entryBoard(e) ?? undefined)
}

/**
 * `duo_wl_v4` → `{ family: 'duo', hw: 'v4' }`.
 * Non-Hapbeat boards (`atom_s3`), unparsable ids and undefined → null.
 */
export function parseHapbeatBoard(
  board?: string | null,
): { family: 'duo' | 'band'; hw: string } | null {
  if (!board) return null
  const m = /^(duo|band)_wl_(v\d+)$/.exec(board)
  if (!m) return null
  return { family: m[1] as 'duo' | 'band', hw: m[2] }
}

/** Level-1 bucket for a library entry. */
export function familyOfEntry(e: FirmwareLibraryEntry): FirmwareFamily {
  if (!isHapbeatEntry(e)) return 'peripheral'
  return parseHapbeatBoard(entryBoard(e))?.family ?? 'other'
}

/** Level-2 key (hardware revision) for a library entry — null when it has none. */
export function hwOfEntry(e: FirmwareLibraryEntry): string | null {
  if (!isHapbeatEntry(e)) return null
  return parseHapbeatBoard(entryBoard(e))?.hw ?? null
}

/** Natural order for `vN` revisions: v2 < v3 < v10. */
function compareHw(a: string, b: string): number {
  const n = (s: string) => parseInt(s.replace(/^v/, ''), 10)
  const na = n(a)
  const nb = n(b)
  if (Number.isNaN(na) || Number.isNaN(nb)) return a.localeCompare(b)
  return na - nb
}

/** Families present in the library, in display order. */
export function listFamilies(entries: FirmwareLibraryEntry[]): FirmwareFamily[] {
  const seen = new Set<FirmwareFamily>()
  for (const e of entries) seen.add(familyOfEntry(e))
  return FAMILY_ORDER.filter((f) => seen.has(f))
}

/** Hardware revisions present for a family, ascending. Empty for `peripheral`. */
export function listHw(entries: FirmwareLibraryEntry[], family: FirmwareFamily): string[] {
  const seen = new Set<string>()
  for (const e of entries) {
    if (familyOfEntry(e) !== family) continue
    const hw = hwOfEntry(e)
    if (hw) seen.add(hw)
  }
  return [...seen].sort(compareHw)
}

/** What the library currently offers, as fed to `resolveDefaultSelection`. */
export interface FamilyAvailability {
  family: FirmwareFamily
  /** Hardware revisions, ascending. Empty for families without revisions. */
  hws: string[]
}

export interface HierarchySelection {
  family: FirmwareFamily
  /** null for families without hardware revisions (周辺機器 / その他). */
  hw: string | null
}

/** Build the availability table straight from the library entries. */
export function listAvailability(entries: FirmwareLibraryEntry[]): FamilyAvailability[] {
  return listFamilies(entries).map((family) => ({ family, hws: listHw(entries, family) }))
}

/** Entries belonging to one selection (the variants actually shown). */
export function entriesForSelection(
  entries: FirmwareLibraryEntry[],
  selection: HierarchySelection | null,
): FirmwareLibraryEntry[] {
  if (!selection) return []
  return entries.filter((e) => {
    if (familyOfEntry(e) !== selection.family) return false
    if (!selection.hw) return true
    return hwOfEntry(e) === selection.hw
  })
}

/** True when the selection exists in the current library. */
export function isSelectionAvailable(
  selection: HierarchySelection | null,
  available: FamilyAvailability[],
): boolean {
  if (!selection) return false
  const entry = available.find((a) => a.family === selection.family)
  if (!entry) return false
  if (entry.hws.length === 0) return !selection.hw
  return !!selection.hw && entry.hws.includes(selection.hw)
}

function pickFamily(
  available: FamilyAvailability[],
  family: FirmwareFamily,
  preferHw?: string | null,
): HierarchySelection | null {
  const entry = available.find((a) => a.family === family)
  if (!entry) return null
  if (entry.hws.length === 0) return { family, hw: null }
  const hw = preferHw && entry.hws.includes(preferHw) ? preferHw : entry.hws[0]
  return { family, hw }
}

export interface ResolveDefaultInput {
  /** Caller-forced group (onboarding wizard). */
  groupFilter?: 'hapbeat' | 'peripheral'
  /** Board reported by the connected device, when known. */
  knownBoard?: string | null
  /** Last selection the user made explicitly (localStorage). */
  saved?: HierarchySelection | null
  available: FamilyAvailability[]
}

/**
 * Default level-1/level-2 selection, device-oriented:
 *   1. forced `groupFilter`
 *   2. the connected device's board
 *   3. the user's last saved pick
 *   4. the first family present
 *
 * Returns null only when the library is empty.
 */
export function resolveDefaultSelection({
  groupFilter,
  knownBoard,
  saved,
  available,
}: ResolveDefaultInput): HierarchySelection | null {
  if (available.length === 0) return null

  const hapbeatFamilies = available.filter((a) => a.family !== 'peripheral')
  const pool = groupFilter === 'hapbeat'
    ? hapbeatFamilies
    : groupFilter === 'peripheral'
      ? available.filter((a) => a.family === 'peripheral')
      : available
  if (pool.length === 0) return null

  // 2. Device board.
  const parsed = parseHapbeatBoard(knownBoard)
  if (parsed) {
    const hit = pickFamily(pool, parsed.family, parsed.hw)
    if (hit) return hit
  } else if (isKnownNonHapbeatBoard(knownBoard ?? undefined)) {
    const hit = pickFamily(pool, 'peripheral')
    if (hit) return hit
  }

  // 3. Saved user pick.
  if (saved && isSelectionAvailable(saved, pool)) return saved
  if (saved) {
    const hit = pickFamily(pool, saved.family, saved.hw)
    if (hit) return hit
  }

  // 4. First family present.
  return pickFamily(pool, pool[0].family) ?? null
}

/**
 * Default variant within the shown set for a device. The PWM-output image
 * (band_v4_pwm) is never picked for a device that does not report
 * `haptic_pwm`; a PWM device gets the PWM image when the set has one, else
 * the first plain image (flashing it is still guarded by a confirm).
 */
export function pickDefaultEntry(
  shown: FirmwareLibraryEntry[],
  devicePwm: boolean,
): FirmwareLibraryEntry | null {
  return shown.find((e) => matchesHapticOutput(e, devicePwm))
    ?? shown.find((e) => !isPwmEntry(e))
    ?? shown[0]
    ?? null
}

/**
 * Pre-flight for an explicit flash of a library image onto targets whose
 * `haptic_pwm` status is `targetsPwm` (true = reports haptic_pwm):
 *   - `'pwm-image'`: the PWM image onto a target not known to be a PWM board
 *   - `'removes-pwm'`: a plain image onto a target that runs PWM drive
 *   - null: nothing to confirm
 */
export function hapticOutputFlashWarning(
  entry: FirmwareLibraryEntry,
  targetsPwm: boolean[],
): 'pwm-image' | 'removes-pwm' | null {
  if (isPwmEntry(entry)) return targetsPwm.every(Boolean) ? null : 'pwm-image'
  return targetsPwm.some(Boolean) ? 'removes-pwm' : null
}
