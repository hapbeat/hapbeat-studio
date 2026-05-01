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
  /** BUILD_TAG baked into the binary at build time (currently a
   *  random `vNN` from `random_tag.py`; will be replaced by a real
   *  version string once we cut the first SDK release). */
  build_tag?: string
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
 * Fetch the merged firmware.bin for one env and return it as **two**
 * flash regions that skip the NVS + otadata gap (0x9000-0x10000).
 *
 * Why split: every Hapbeat build emits a merged firmware.bin
 * spanning [0x0, ~0x1C0000]. Writing the whole blob with
 * `write_flash 0x0` overwrites the NVS partition (`partitions.csv`:
 * `nvs @ 0x9000, 0x5000`), wiping Wi-Fi profiles / device name /
 * group ID on every flash. Distribution-wise we still want a single
 * binary, so the SOURCE FILE stays merged — the SPLIT happens here
 * at flash-time so the writer leaves [0x9000, 0x10000) untouched.
 *
 * Layout the split mirrors:
 *
 *   [0x0    , 0x9000 ) → bootloader (0x0) + partitions (0x8000)
 *   [0x9000 , 0x10000) → SKIPPED  (NVS @ 0x9000 + otadata @ 0xE000)
 *   [0x10000, end    ) → app (ota_0)
 *
 * Bootloader / partitions / app start markers are validated up front
 * so a non-merged image is rejected before any flash bytes are sent.
 */
const NVS_OTADATA_START = 0x9000
const APP_START = 0x10000
export async function fetchFirmwareRegions(
  entry: FirmwareLibraryEntry,
): Promise<FirmwareRegion[]> {
  const fw = await fetchRegion(entry.env, 'firmware')
  const b = fw.bytes
  const isMerged =
    b.length >= APP_START + 1
    && b[0] === 0xe9
    && b[0x8000] === 0xaa
    && b[0x8001] === 0x50
    && b[APP_START] === 0xe9
  if (!isMerged) {
    throw new Error(
      `firmware.bin for env="${entry.env}" is not a merged image. `
      + 'Hapbeat builds must emit merged firmware.bin '
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
