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
 *   Firmware artifacts are aggregated across multiple firmware repos
 *   into a single `manifest.json` (schema_version 2 — see contracts
 *   `firmware-distribution.md`, DEC-034). Each variant carries
 *   role/transport/board/label so Studio can present the right firmware
 *   for the node being flashed. The manifest's explicit artifact
 *   filenames are repo-prefixed to avoid collisions.
 *
 *   Back-compat: a legacy `{ envs: [...] }` manifest (or the dev
 *   plugin) is mapped to receiver/udp variants, with role/transport
 *   inferred from the env name as a best-effort fallback.
 */

import type { NodeRole, NodeTransport } from '@/types/manager'
import { isMergedImage } from '@/utils/serialFlasher'

/**
 * Human-facing board names — the device/module (M5Stack Basic, M5 ATOM
 * Lite, ...), not the MCU. Kept coarse: variants that share a module
 * share a label. Unknown ids fall through verbatim.
 */
const BOARD_LABELS: Record<string, string> = {
  duo_wl_v3: 'DuoWL v3',
  band_wl_v2: 'BandWL v2',
  band_wl_v3: 'BandWL v3',
  band_wl_v4: 'BandWL v4',
  atom_s3: 'M5 ATOM S3',
  atom_lite: 'M5 ATOM Lite',
  m5stack_basic: 'M5Stack Basic',
  // legacy ids emitted by older builds
  m5stack_core: 'M5Stack Basic',
  atom_s3_sensor: 'M5 ATOM S3',
  xiao_c6: 'XIAO ESP32-C6',
}

export function boardLabel(id?: string | null): string | null {
  if (!id) return null
  return BOARD_LABELS[id] ?? id
}

/** Per-artifact metadata. */
export interface FirmwareArtifact {
  /** Bytes on disk / in the release. */
  size: number
  /** Last-modified time (ms since epoch). 0 when unknown (GH releases). */
  mtime: number
  /** Fetch URL (prod) or display path (dev host). */
  path: string
}

/** One published version of a variant (latest or archive). */
export interface FirmwareVersionInfo {
  fwVersion: string
  /** GitHub Release tag this version came from (e.g. "v0.1.3"). */
  tag?: string
  appOta?: FirmwareArtifact
  fullSerial?: FirmwareArtifact
}

export interface FirmwareLibraryEntry {
  /** PlatformIO environment name, e.g. `band_v3` / `DuoWL_V3_STREAM_ESPNOW`. */
  env: string
  /** App-only image for **Wi-Fi OTA** (firmware_app_ota.bin). The
   *  ESP32 OTA mechanism (`Update.write` → ota_X partition) accepts
   *  this and only this — sending a merged image instead writes
   *  bootloader bytes into the OTA app slot and the device rolls back
   *  on next boot. Absent for serial-only nodes (transmitter /
   *  espnow_stream receiver) which never join Wi-Fi. */
  appOta?: FirmwareArtifact
  /** Merged image for **USB Serial download mode**
   *  (firmware_full_serial.bin) — bootloader 0x0 + partitions 0x8000
   *  + app 0x10000. Esptool-js writes each region to its own offset. */
  fullSerial?: FirmwareArtifact
  /** FIRMWARE_VERSION baked into the binary at build time. */
  fwVersion?: string
  // --- manifest v2 (node-roles, DEC-034) ---
  /** Unique id within the manifest (`<repo-short>/<env>`). */
  id?: string
  /** Source firmware repo. */
  repo?: string
  /** Node role this firmware implements. */
  role?: NodeRole
  /** Primary transport. */
  transport?: NodeTransport
  /** All supported transports (receiver may be udp+mqtt). */
  transports?: NodeTransport[]
  /** Hardware board id (for board-mismatch pre-flight). */
  board?: string
  /** Human-facing display label. */
  label?: string
  /** Optional one-line description. */
  description?: string
  /**
   * Dev-server source: "live" = present in .pio/build now; "cache" = a
   * snapshot of a previously-built env that .pio has since pruned (still
   * flashable, but possibly older). Absent in prod (always live release).
   */
  source?: 'live' | 'cache'
  /** Epoch ms the cache snapshot was taken (dev `source:"cache"` only). */
  cachedAt?: number
  /**
   * All published versions, newest first (archive support — users can
   * roll back to an older release). The top-level fwVersion/appOta/
   * fullSerial mirror versions[0]. Absent in dev mode (single build).
   */
  versions?: FirmwareVersionInfo[]
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

/** Base URL for production firmware distribution (served as static files from Studio). */
const PROD_FIRMWARE_BASE = `${import.meta.env.BASE_URL}firmware`

/**
 * Best-effort role/transport/board inference from a PlatformIO env name.
 * Used as a fallback when a manifest variant (or the dev plugin) does
 * not carry explicit role/transport — so multi-role firmware is still
 * grouped sensibly in dev and against legacy manifests. Explicit
 * manifest values always win over this.
 */
export function inferVariantFromEnv(env: string): {
  role: NodeRole
  transport: NodeTransport
  board?: string
} {
  const e = env.toLowerCase()
  let role: NodeRole = 'receiver'
  let transport: NodeTransport = 'udp'
  if (/broker/.test(e)) {
    role = 'broker'
    transport = 'mqtt'
  } else if (/sensor/.test(e)) {
    role = 'sensor'
    transport = 'mqtt'
  } else if (/(transmitter|sender|audio.*(tx|stream)|_tx\b)/.test(e)) {
    role = 'transmitter'
    transport = 'espnow_stream'
  } else if (/stream/.test(e) && /espnow/.test(e)) {
    role = 'receiver'
    transport = 'espnow_stream'
  } else if (/mqtt/.test(e)) {
    role = 'receiver'
    transport = 'mqtt'
  }
  // Board inference for the receiver necklace/band naming scheme.
  let board: string | undefined
  const m = e.match(/(necklace|duo|band)[_-]?(v\d+)/)
  if (m) {
    const family = m[1] === 'necklace' || m[1] === 'duo' ? 'duo' : 'band'
    board = `${family}_wl_${m[2]}`
  }
  return { role, transport, board }
}

/** Fill role/transport/board on an entry from explicit values, else infer. */
function withInferredRole(e: FirmwareLibraryEntry): FirmwareLibraryEntry {
  if (e.role && e.transport) return e
  const inferred = inferVariantFromEnv(e.env)
  return {
    ...e,
    role: e.role ?? inferred.role,
    transport: e.transport ?? inferred.transport,
    board: e.board ?? inferred.board,
  }
}

function isProdMode(): boolean {
  return import.meta.env.PROD
}

export async function listFirmwareBuilds(): Promise<FirmwareLibraryEntry[]> {
  if (isProdMode()) {
    return (await listFirmwareBuildsFromManifest()).map(withInferredRole)
  }
  // Dev: use Vite middleware
  const r = await fetch('/firmware-builds/list', { cache: 'no-store' })
  if (!r.ok) {
    throw new Error(`firmware list failed (${r.status} ${r.statusText})`)
  }
  const json = (await r.json()) as { envs: FirmwareLibraryEntry[] }
  return (json.envs ?? []).map(withInferredRole)
}

interface ManifestArtifact {
  filename: string
  size: number
  mtime?: number
}

interface ManifestVersionV2 {
  fwVersion: string
  tag?: string
  appOta?: ManifestArtifact
  fullSerial?: ManifestArtifact
}

interface ManifestVariantV2 {
  id?: string
  repo?: string
  env: string
  role?: NodeRole
  transport?: NodeTransport
  transports?: NodeTransport[]
  board?: string
  label?: string
  description?: string
  fwVersion?: string
  appOta?: ManifestArtifact
  fullSerial?: ManifestArtifact
  versions?: ManifestVersionV2[]
}

/** Legacy v1 env entry. */
interface ManifestEnvV1 {
  env: string
  fwVersion?: string
  appOta?: ManifestArtifact
  fullSerial?: ManifestArtifact
}

/**
 * Fetch `manifest.json` and parse v2 (`variants`) or legacy v1
 * (`envs`) into `FirmwareLibraryEntry[]`. v2 carries role/transport/
 * board/label per variant; v1 entries are mapped to receiver/udp with
 * role inferred from the env name.
 */
async function listFirmwareBuildsFromManifest(): Promise<FirmwareLibraryEntry[]> {
  const manifestUrl = `${PROD_FIRMWARE_BASE}/manifest.json`
  const r = await fetch(manifestUrl, { cache: 'no-store' })
  if (!r.ok) {
    throw new Error(
      `firmware manifest fetch failed (${r.status} ${r.statusText}) — `
      + `are firmware artifacts published?`,
    )
  }
  const json = (await r.json()) as {
    schema_version?: number
    variants?: ManifestVariantV2[]
    envs?: ManifestEnvV1[]
  }

  const toArtifact = (a?: ManifestArtifact): FirmwareArtifact | undefined =>
    a
      ? {
          size: a.size,
          mtime: a.mtime ?? 0,
          path: `${PROD_FIRMWARE_BASE}/${a.filename}`,
        }
      : undefined

  if (Array.isArray(json.variants)) {
    return json.variants.map((v) => ({
      env: v.env,
      id: v.id,
      repo: v.repo,
      role: v.role,
      transport: v.transport,
      transports: v.transports,
      board: v.board,
      label: v.label,
      description: v.description,
      fwVersion: v.fwVersion,
      appOta: toArtifact(v.appOta),
      fullSerial: toArtifact(v.fullSerial),
      versions: v.versions?.map((ver) => ({
        fwVersion: ver.fwVersion,
        tag: ver.tag,
        appOta: toArtifact(ver.appOta),
        fullSerial: toArtifact(ver.fullSerial),
      })),
    }))
  }

  // Legacy v1 fallback.
  return (json.envs ?? []).map((e) => ({
    env: e.env,
    fwVersion: e.fwVersion,
    appOta: toArtifact(e.appOta),
    fullSerial: toArtifact(e.fullSerial),
  }))
}

/**
 * Fetch the **app-only** binary (firmware_app_ota.bin) for Wi-Fi OTA.
 * Pass the resolved library entry so the explicit manifest URL is used
 * in prod (repo-prefixed filenames) and the dev plugin path in dev.
 */
export async function fetchFirmwareAppOta(
  entry: FirmwareLibraryEntry,
): Promise<{ bytes: Uint8Array; mtime: number; size: number; path: string }> {
  return fetchArtifact(entry, 'firmware_app_ota')
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
 * Bootloader / partitions / app start markers are validated up front
 * so a non-merged image is rejected before any flash bytes are sent.
 */
export async function fetchFirmwareSerialRegions(
  entry: FirmwareLibraryEntry,
): Promise<FirmwareRegion[]> {
  const fw = await fetchArtifact(entry, 'firmware_full_serial')
  const b = fw.bytes
  // Accepts both bootloader layouts (S3-class @0x0, classic ESP32 @0x1000
  // behind 0xFF padding) — see serialFlasher.isMergedImage.
  if (!isMergedImage(b)) {
    throw new Error(
      `firmware_full_serial.bin for env="${entry.env}" is not a merged image. `
      + 'Hapbeat builds must emit a merged firmware_full_serial.bin '
      + '(bootloader + partitions 0x8000 + app 0x10000).',
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
  entry: FirmwareLibraryEntry,
  stem: 'firmware_app_ota' | 'firmware_full_serial',
): Promise<{ bytes: Uint8Array; mtime: number; size: number; path: string }> {
  if (isProdMode()) {
    return fetchArtifactFromManifest(entry, stem)
  }
  return fetchArtifactFromDevPlugin(entry.env, stem)
}

async function fetchArtifactFromDevPlugin(
  env: string,
  stem: 'firmware_app_ota' | 'firmware_full_serial',
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
 * Fetch a firmware artifact in production using the explicit manifest
 * URL (`entry.appOta.path` / `entry.fullSerial.path`). Falls back to
 * the legacy reconstructed `<env>_<stem>.bin` name when the entry has
 * no explicit artifact path (e.g. a hand-rolled v1 manifest).
 */
async function fetchArtifactFromManifest(
  entry: FirmwareLibraryEntry,
  stem: 'firmware_app_ota' | 'firmware_full_serial',
): Promise<{ bytes: Uint8Array; mtime: number; size: number; path: string }> {
  const artifact = stem === 'firmware_app_ota' ? entry.appOta : entry.fullSerial
  const tryUrls: string[] = []
  if (artifact?.path) tryUrls.push(artifact.path)
  // Legacy fallbacks (reconstructed names).
  if (stem === 'firmware_full_serial') {
    tryUrls.push(`${PROD_FIRMWARE_BASE}/${entry.env}_firmware_full_serial.bin`)
    tryUrls.push(`${PROD_FIRMWARE_BASE}/${entry.env}_firmware.bin`)
  } else {
    tryUrls.push(`${PROD_FIRMWARE_BASE}/${entry.env}_${stem}.bin`)
  }

  let lastErr: Error | null = null
  for (const url of tryUrls) {
    const r = await fetch(url, { cache: 'no-store' })
    if (r.ok) {
      const buf = await r.arrayBuffer()
      const bytes = new Uint8Array(buf)
      if (bytes.length === 0) {
        lastErr = new Error(`${url} is empty for env="${entry.env}"`)
        continue
      }
      const size = Number(r.headers.get('content-length') ?? bytes.length)
      return { bytes, mtime: artifact?.mtime ?? 0, size, path: url }
    }
    lastErr = new Error(`${url} fetch failed (${r.status} ${r.statusText})`)
  }
  throw lastErr ?? new Error(`manifest artifact fetch failed for env="${entry.env}"`)
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
  if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  if (n >= 1024) return `${Math.round(n / 1024).toLocaleString()} KB`
  return `${n} B`
}
