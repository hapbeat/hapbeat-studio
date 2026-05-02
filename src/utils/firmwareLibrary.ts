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

/** Per-artifact metadata returned by the dev plugin's `/list`. */
export interface FirmwareArtifact {
  /** Bytes on disk. */
  size: number
  /** Last-modified time (ms since epoch). */
  mtime: number
  /** Absolute filesystem path on the dev host (display only). */
  path: string
}

export interface FirmwareLibraryEntry {
  /** PlatformIO environment name, e.g. `necklace_v3_claude`. */
  env: string
  /** App-only image for **Wi-Fi OTA** (firmware_app_ota.bin). The
   *  ESP32 OTA mechanism (`Update.write` → ota_X partition) accepts
   *  this and only this — sending a merged image instead writes
   *  bootloader bytes into the OTA app slot and the device rolls back
   *  on next boot. */
  appOta?: FirmwareArtifact
  /** Merged image for **USB Serial download mode**
   *  (firmware_full_serial.bin) — bootloader 0x0 + partitions 0x8000
   *  + app 0x10000. Esptool-js writes each region to its own offset.
   *  Unused for OTA. */
  fullSerial?: FirmwareArtifact
  /** FIRMWARE_VERSION baked into the binary at build time (the semver
   *  string defined in `src/hapbeat_config.h`). Sole source of truth
   *  for "which firmware is this" — same value the OLED shows and the
   *  device returns in `get_info`'s `fw` field. */
  fwVersion?: string
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
 * Fetch the **app-only** binary (firmware_app_ota.bin) for Wi-Fi OTA.
 *
 * The ESP32 OTA mechanism (`Update.write` in firmware) writes the
 * supplied bytes into the next OTA app partition starting from
 * offset 0. It cannot update bootloader (lives at 0x0) or partition
 * table (0x8000) — those need USB Serial download mode. So OTA must
 * receive an app-only image, not the merged blob.
 */
export async function fetchFirmwareAppOta(
  env: string,
): Promise<{ bytes: Uint8Array; mtime: number; size: number; path: string }> {
  return fetchArtifact(env, 'firmware_app_ota')
}

const NVS_OTADATA_START = 0x9000
const APP_START = 0x10000
/**
 * Fetch the **merged** image (firmware_full_serial.bin) for USB Serial
 * download-mode flashing and return it as 2 regions that skip the
 * NVS + otadata gap (0x9000-0x10000) so reflashing preserves Wi-Fi
 * profiles / device name / group ID.
 *
 * Layout of the merged image:
 *   [0x0    , 0x9000 ) → bootloader (0x0) + partitions (0x8000)
 *   [0x9000 , 0x10000) → SKIPPED (NVS @ 0x9000 + otadata @ 0xE000)
 *   [0x10000, end    ) → app (ota_0)
 *
 * Bootloader / partitions / app start markers are validated up front
 * so a non-merged image is rejected before any flash bytes are sent.
 */
export async function fetchFirmwareSerialRegions(
  entry: FirmwareLibraryEntry,
): Promise<FirmwareRegion[]> {
  const fw = await fetchArtifact(entry.env, 'firmware_full_serial')
  const b = fw.bytes
  const isMerged =
    b.length >= APP_START + 1
    && b[0] === 0xe9
    && b[0x8000] === 0xaa
    && b[0x8001] === 0x50
    && b[APP_START] === 0xe9
  if (!isMerged) {
    throw new Error(
      `firmware_full_serial.bin for env="${entry.env}" is not a merged image. `
      + 'Hapbeat builds must emit a merged firmware_full_serial.bin '
      + '(bootloader 0x0 + partitions 0x8000 + app 0x10000).',
    )
  }
  return [
    {
      address: 0x0,
      bytes: b.slice(0, NVS_OTADATA_START),
      label: 'bootloader+partitions (0x0..0x9000)',
    },
    {
      address: APP_START,
      bytes: b.slice(APP_START),
      label: `app (0x10000..${(b.length).toString(16)})`,
    },
  ]
}

async function fetchArtifact(
  env: string,
  stem: 'firmware_app_ota' | 'firmware_full_serial' | 'firmware',
): Promise<{ bytes: Uint8Array; mtime: number; size: number; path: string }> {
  const tryStems = stem === 'firmware_full_serial'
    // Back-compat: older builds emit the merged image as `firmware.bin`
    // without the `_full_serial` suffix.
    ? ['firmware_full_serial', 'firmware']
    : [stem]
  let lastErr: Error | null = null
  for (const s of tryStems) {
    const r = await fetch(
      `${firmwareBaseUrl()}/${encodeURIComponent(env)}/${s}.bin`,
      { cache: 'no-store' },
    )
    if (r.ok) {
      const buf = await r.arrayBuffer()
      const bytes = new Uint8Array(buf)
      if (bytes.length === 0) {
        lastErr = new Error(`${s}.bin is empty for env="${env}"`)
        continue
      }
      const mtime = Number(r.headers.get('x-firmware-mtime') ?? '0')
      const size = Number(r.headers.get('x-firmware-size') ?? bytes.length)
      const path = r.headers.get('x-firmware-path') ?? ''
      return { bytes, mtime, size, path }
    }
    lastErr = new Error(
      `${s}.bin fetch failed (${r.status} ${r.statusText}) for env="${env}"`,
    )
  }
  throw lastErr ?? new Error(`fetch failed for env="${env}"`)
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
  // Match Windows Explorer / macOS Finder list views: KB for small
  // files, MB / GB only when crossing those thresholds. Two-decimal
  // MB matched our previous output but reads as more precision than
  // OS file managers actually offer (Explorer uses no decimals on
  // KB, one on MB). One decimal everywhere.
  if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  if (n >= 1024) return `${Math.round(n / 1024).toLocaleString()} KB`
  return `${n} B`
}
