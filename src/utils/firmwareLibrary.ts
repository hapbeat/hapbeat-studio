/**
 * Firmware library — discover and fetch official builds the dev server
 * relays from `hapbeat-device-firmware/.pio/build/<env>/firmware.bin`.
 *
 * The Vite plugin in `vite.config.ts` exposes:
 *   GET /firmware-builds/list                              → { envs: [...] }
 *   GET /firmware-builds/<env>/firmware.bin         → bytes
 *
 * Always sent with `cache: 'no-store'` so a fresh PlatformIO build is
 * picked up on the very next click — that was the *whole point* of
 * adding this layer (file-picker re-selection was missing rebuilds).
 *
 * Production: when devtools.hapbeat.com gets a CDN of canonical
 * firmware builds, replace `firmwareBaseUrl()` with that URL and the
 * rest of the file is unchanged.
 */

export interface FirmwareLibraryEntry {
  /** PlatformIO environment name, e.g. `necklace_v3_claude`. */
  env: string
  /** `firmware.bin` size in bytes. */
  size: number
  /** Last-modified time of `firmware.bin` (ms since epoch). */
  mtime: number
  /** Absolute filesystem path of `firmware.bin` on the dev host
   *  (display only). */
  path: string
}

/** A single region to write during a multi-file flash. */
export interface FirmwareRegion {
  /** Flash offset, e.g. 0x0 / 0x8000 / 0x10000. */
  address: number
  /** Raw bytes to write at `address`. */
  bytes: Uint8Array
  /** Source filename (display only). */
  label: string
}

/** Single source of truth for the dev-plugin URL prefix. Override at
 *  build time if a CDN is published. */
function firmwareBaseUrl(): string {
  return '/firmware-builds'
}

export async function listFirmwareBuilds(): Promise<FirmwareLibraryEntry[]> {
  const r = await fetch(`${firmwareBaseUrl()}/list`, { cache: 'no-store' })
  if (!r.ok) {
    throw new Error(`firmware list failed (${r.status} ${r.statusText})`)
  }
  const json = (await r.json()) as { envs: FirmwareLibraryEntry[] }
  return json.envs ?? []
}

/**
 * Fetch the app binary (firmware.bin only) for one env.
 *
 * For iterative app updates this is enough — the bootloader and
 * partition table from the previous flash stay in place. For full
 * provisioning (after a chip-erase, or first time) use
 * `fetchFirmwareRegions` which pulls all 3 files (bootloader 0x0 +
 * partitions 0x8000 + firmware 0x10000) so the device boots cleanly.
 */
export async function fetchFirmwareBinary(
  env: string,
): Promise<{ bytes: Uint8Array; mtime: number; size: number; path: string }> {
  const r = await fetch(
    `${firmwareBaseUrl()}/${encodeURIComponent(env)}/firmware.bin`,
    { cache: 'no-store' },
  )
  if (!r.ok) {
    throw new Error(
      `firmware fetch failed (${r.status} ${r.statusText}) for env="${env}"`,
    )
  }
  const buf = await r.arrayBuffer()
  const bytes = new Uint8Array(buf)
  const mtime = Number(r.headers.get('x-firmware-mtime') ?? '0')
  const size = Number(r.headers.get('x-firmware-size') ?? bytes.length)
  const path = r.headers.get('x-firmware-path') ?? ''
  return { bytes, mtime, size, path }
}

/**
 * Fetch the merged firmware.bin for one env and return it as a single
 * flash region pinned to 0x0.
 *
 * Project convention (2026-04-29 onwards): every Hapbeat firmware build
 * emits `firmware.bin` as a *merged* image (bootloader 0x0 + partitions
 * 0x8000 + app 0x10000 concatenated in one file). Studio writes the
 * whole blob to 0x0 in one shot — no app-only path, no
 * bootloader/partitions sibling fetching, no per-build address
 * detection. This matches PlatformIO's `pio run -t upload` behavior
 * for merged builds and removes a class of bricking bugs we hit when
 * the file layout was ambiguous.
 *
 * Throws if firmware.bin doesn't satisfy the merged-image markers,
 * because writing a non-merged blob to 0x0 corrupts the bootloader.
 */
export async function fetchFirmwareRegions(
  entry: FirmwareLibraryEntry,
): Promise<FirmwareRegion[]> {
  const fw = await fetchRegion(entry.env, 'firmware')
  const b = fw.bytes
  const isMerged =
    b.length >= 0x10001
    && b[0] === 0xe9
    && b[0x8000] === 0xaa
    && b[0x8001] === 0x50
    && b[0x10000] === 0xe9
  if (!isMerged) {
    throw new Error(
      `firmware.bin for env="${entry.env}" is not a merged image. `
      + 'Hapbeat builds must emit merged firmware.bin '
      + '(bootloader 0x0 + partitions 0x8000 + app 0x10000).',
    )
  }
  return [{
    address: 0x0,
    bytes: fw.bytes,
    label: 'firmware.bin (merged)',
  }]
}

async function fetchRegion(
  env: string,
  stem: 'firmware' | 'bootloader' | 'partitions',
): Promise<{ bytes: Uint8Array }> {
  const r = await fetch(
    `${firmwareBaseUrl()}/${encodeURIComponent(env)}/${stem}.bin`,
    { cache: 'no-store' },
  )
  if (!r.ok) {
    throw new Error(
      `${stem}.bin fetch failed (${r.status} ${r.statusText}) for env="${env}"`,
    )
  }
  const bytes = new Uint8Array(await r.arrayBuffer())
  if (bytes.length === 0) {
    throw new Error(`${stem}.bin is empty for env="${env}"`)
  }
  return { bytes }
}

export function formatMtime(ms: number): string {
  if (!ms) return '不明'
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + ` ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  )
}

export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${n} B`
}
