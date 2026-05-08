/**
 * Firmware library — discover and fetch official builds.
 *
 * Dev mode (Vite dev server):
 *   The `firmwareDevPlugin` in vite.config.ts exposes:
 *     GET /firmware-builds/list         → { envs: [...] }
 *     GET /firmware-builds/<env>/<stem>.bin → bytes
 *   Always fetched with `cache: 'no-store'` so a fresh PlatformIO build
 *   is picked up on the very next click.
 *
 * Production (deployed devtools.hapbeat.com):
 *   Firmware artifacts are hosted on GitHub Releases for
 *   `hapbeat/hapbeat-device-firmware`. A `manifest.json` at the release
 *   root lists available envs and artifact filenames. Artifact files use
 *   the naming convention `<env>_<stem>.bin` to avoid name collisions
 *   across environments in the same release.
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

/** GitHub Releases base URL for production firmware distribution. */
const PROD_FIRMWARE_RELEASE_BASE =
  'https://github.com/Hapbeat/hapbeat-device-firmware/releases/latest/download'

/**
 * In development (Vite dev server) the `firmwareDevPlugin` serves
 * `/firmware-builds/…` locally. In production we fetch from GitHub Releases.
 */
function isProdMode(): boolean {
  return import.meta.env.PROD
}

export async function listFirmwareBuilds(): Promise<FirmwareLibraryEntry[]> {
  if (isProdMode()) {
    return listFirmwareBuildsFromGitHubReleases()
  }
  // Dev: use Vite middleware
  const r = await fetch('/firmware-builds/list', { cache: 'no-store' })
  if (!r.ok) {
    throw new Error(`firmware list failed (${r.status} ${r.statusText})`)
  }
  const json = (await r.json()) as { envs: FirmwareLibraryEntry[] }
  return json.envs ?? []
}

/**
 * Fetch the `manifest.json` from the latest GitHub Release and parse it
 * into the same `FirmwareLibraryEntry[]` shape the dev plugin returns.
 *
 * Expected manifest shape:
 * ```json
 * {
 *   "envs": [
 *     {
 *       "env": "necklace_v3_claude",
 *       "fwVersion": "v0.5.1",
 *       "appOta":     { "filename": "necklace_v3_claude_firmware_app_ota.bin",     "size": 1234567, "mtime": 1714723200000 },
 *       "fullSerial": { "filename": "necklace_v3_claude_firmware_full_serial.bin", "size": 1556789, "mtime": 1714723200000 }
 *     }
 *   ]
 * }
 * ```
 */
async function listFirmwareBuildsFromGitHubReleases(): Promise<FirmwareLibraryEntry[]> {
  const manifestUrl = `${PROD_FIRMWARE_RELEASE_BASE}/manifest.json`
  const r = await fetch(manifestUrl, { cache: 'no-store' })
  if (!r.ok) {
    throw new Error(
      `firmware manifest fetch failed (${r.status} ${r.statusText}) — `
      + `are firmware artifacts published to GitHub Releases?`,
    )
  }

  interface ManifestEnv {
    env: string
    fwVersion?: string
    appOta?: { filename: string; size: number; mtime: number }
    fullSerial?: { filename: string; size: number; mtime: number }
  }
  const json = (await r.json()) as { envs: ManifestEnv[] }

  return (json.envs ?? []).map((e) => ({
    env: e.env,
    fwVersion: e.fwVersion,
    appOta: e.appOta
      ? {
          size: e.appOta.size,
          mtime: e.appOta.mtime,
          // Expose the GH release download URL as `path` so display components
          // can show it (they currently show `path` as a tooltip / label).
          path: `${PROD_FIRMWARE_RELEASE_BASE}/${e.appOta.filename}`,
        }
      : undefined,
    fullSerial: e.fullSerial
      ? {
          size: e.fullSerial.size,
          mtime: e.fullSerial.mtime,
          path: `${PROD_FIRMWARE_RELEASE_BASE}/${e.fullSerial.filename}`,
        }
      : undefined,
  }))
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

const NVS_GAP_START = 0x9000
const OTADATA_START = 0xE000
const APP_START = 0x10000
const OTADATA_SIZE = APP_START - OTADATA_START  // 8 KB

/**
 * Fetch the **merged** image (firmware_full_serial.bin) for USB Serial
 * download-mode flashing and return it as 3 regions:
 *   1. bootloader + partitions      (write)
 *   2. otadata erase (8 KB of 0xFF) (write — forces ota_0 boot)
 *   3. app                          (write to ota_0)
 * NVS (0x9000-0xE000) is skipped so Wi-Fi profiles / device name / group
 * ID survive across reflashes.
 *
 * Layout of the merged image:
 *   [0x0    , 0x9000 ) → bootloader (0x0) + partitions (0x8000)        ← write
 *   [0x9000 , 0xE000 ) → NVS                                            ← SKIP
 *   [0xE000 , 0x10000) → otadata                                        ← erase (write 0xFF)
 *   [0x10000, end    ) → app (ota_0)                                    ← write
 *
 * Why otadata is reset (2026-05-09 fix):
 *   After a successful OTA, otadata points at ota_1. If we serial-flash
 *   only ota_0 and skip otadata, the bootloader still picks ota_1 and
 *   boots the OLD firmware — symptom: OLED shows old version, get_info.fw
 *   mismatches the bin we just flashed. Writing 0xFF to otadata makes
 *   the bootloader treat OTA selection as uninitialized → boot ota_0
 *   (the slot we just wrote).
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
      bytes: b.slice(0, NVS_GAP_START),
      label: 'bootloader+partitions (0x0..0x9000)',
    },
    {
      address: OTADATA_START,
      bytes: new Uint8Array(OTADATA_SIZE).fill(0xff),
      label: 'otadata erase (0xE000..0x10000)',
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
  if (isProdMode()) {
    return fetchArtifactFromGitHubReleases(env, stem)
  }
  return fetchArtifactFromDevPlugin(env, stem)
}

async function fetchArtifactFromDevPlugin(
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
      `/firmware-builds/${encodeURIComponent(env)}/${s}.bin`,
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

/**
 * Fetch a firmware artifact from GitHub Releases.
 * Artifact naming: `<env>_<stem>.bin` (e.g. `necklace_v3_claude_firmware_app_ota.bin`).
 * Falls back to `<env>_firmware.bin` for full_serial (legacy back-compat).
 */
async function fetchArtifactFromGitHubReleases(
  env: string,
  stem: 'firmware_app_ota' | 'firmware_full_serial' | 'firmware',
): Promise<{ bytes: Uint8Array; mtime: number; size: number; path: string }> {
  const tryFilenames =
    stem === 'firmware_full_serial'
      ? [`${env}_firmware_full_serial.bin`, `${env}_firmware.bin`]
      : [`${env}_${stem}.bin`]

  let lastErr: Error | null = null
  for (const filename of tryFilenames) {
    const url = `${PROD_FIRMWARE_RELEASE_BASE}/${filename}`
    const r = await fetch(url, { cache: 'no-store' })
    if (r.ok) {
      const buf = await r.arrayBuffer()
      const bytes = new Uint8Array(buf)
      if (bytes.length === 0) {
        lastErr = new Error(`${filename} is empty for env="${env}"`)
        continue
      }
      // GitHub Releases does not return custom headers; use Content-Length
      const size = Number(r.headers.get('content-length') ?? bytes.length)
      return { bytes, mtime: 0, size, path: url }
    }
    lastErr = new Error(
      `${filename} fetch failed (${r.status} ${r.statusText})`,
    )
  }
  throw lastErr ?? new Error(`GitHub Releases fetch failed for env="${env}"`)
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
