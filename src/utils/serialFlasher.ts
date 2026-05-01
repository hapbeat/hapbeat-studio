/**
 * USB Serial firmware flasher (Web Serial API + esptool-js).
 *
 * Browser equivalent of Manager's `_serial_flash_worker` / `_serial_erase_worker`
 * (hapbeat-manager/src/hapbeat_manager/main_window.py:888-1040). Uses
 * esptool-js's ESPLoader on top of a Transport wrapping a SerialPort
 * obtained through `navigator.serial.requestPort()`.
 *
 * Address-mapping mirrors Manager:
 *   - merged binary (first byte 0xE9 + size > 0x10000) → write at 0x0
 *   - app-only fallback                                 → write at 0x10000
 *
 * The browser can't see sibling files (no directory access from a
 * single-file picker), so the "bootloader + partitions + app" path
 * Manager supports is unavailable here. Users with a non-merged build
 * should provide a merged firmware bin (PlatformIO emits `firmware.bin`
 * already merged when `merge_firmware.py` is in build_flags).
 */

import { ESPLoader, type FlashOptions, Transport } from 'esptool-js'

export interface FlashProgress {
  /** 0..100 */
  percent: number
  /** Phase / human-readable label for the UI. */
  phase: string
  /** Bytes written / total when known. */
  written?: number
  total?: number
  /** Optional per-region label during multi-file writes. */
  message?: string
}

export interface FlashOptionsExt {
  /** Override the auto-detected start address. */
  forceAddress?: number
  /** Erase entire flash before writing. */
  eraseAll?: boolean
  onProgress?: (p: FlashProgress) => void
  onLog?: (line: string) => void
  /**
   * Bootloader baud. Default 921600 to match `hapbeat-manager`'s
   * `esptool --baud 921600` invocation, which is the proven-working
   * configuration for these devices.
   */
  baudrate?: number
  /**
   * Use deflate compression on the wire. Default `true` because
   * esptool-js 0.6 does not implement the uncompressed write path
   * (throws "Yet to handle Non Compressed writes"). Setting this to
   * `false` is reserved for a future esptool-js upgrade.
   */
  compress?: boolean
}

export function isWebSerialSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serial' in navigator
}

// Note: there's deliberately NO `pickSerialPort` / `getMostRecentSerialPort`
// here anymore. Studio's single-master invariant (see serialMaster.ts)
// requires every Web Serial port acquisition to go through
// `pickConfigPort` / `master.openConfig` so the master is the only
// thing that can hold a SerialPort handle. `flashRegions` / `eraseFlash`
// below take an already-opened-by-master port as their first argument.

/**
 * Validate that the supplied `.bin` is the merged image layout this
 * project standardized on (PlatformIO post-build outputs `firmware.bin`
 * as bootloader 0x0 + partitions 0x8000 + app 0x10000 in one file).
 * Throws if the markers don't match — better than silently writing a
 * non-merged image to 0x0 and bricking the bootloader area.
 *
 * Required markers:
 *   - byte[0x0]      == 0xE9   (bootloader image header)
 *   - byte[0x8000]   == 0xAA   (partition table magic, low byte)
 *   - byte[0x8001]   == 0x50   (partition table magic, high byte)
 *   - byte[0x10000]  == 0xE9   (app image header inside the blob)
 */
export function assertMergedImage(bin: Uint8Array): void {
  if (
    bin.length < 0x10001
    || bin[0] !== 0xe9
    || bin[0x8000] !== 0xaa
    || bin[0x8001] !== 0x50
    || bin[0x10000] !== 0xe9
  ) {
    throw new Error(
      'firmware bin is not a merged image (expected bootloader@0x0 + '
      + 'partitions@0x8000 + app@0x10000). Build the firmware so '
      + 'PlatformIO emits the merged firmware.bin.',
    )
  }
}

/**
 * Erase the device's flash. Used when the user wants to reset before
 * a fresh provisioning. ESP32-S3 stock chip erase takes ~30 s on a
 * 16 MB part.
 */
export async function eraseFlash(
  port: SerialPort,
  opts: Pick<FlashOptionsExt, 'onLog' | 'baudrate' | 'onProgress'> = {},
): Promise<void> {
  const baudrate = opts.baudrate ?? 921600
  const transport = new Transport(port, false)
  try {
    const loader = new ESPLoader({
      transport,
      baudrate,
      terminal: makeTerminal(opts.onLog),
    })
    opts.onProgress?.({ phase: 'connect', percent: 0 })
    await loader.main('default_reset')
    opts.onProgress?.({ phase: 'erase', percent: 30 })
    await loader.eraseFlash()
    opts.onProgress?.({ phase: 'reset', percent: 95 })
    await loader.after('hard_reset')
    opts.onProgress?.({ phase: 'done', percent: 100 })
  } finally {
    await safeDisconnect(transport)
  }
}

/**
 * Flash a merged firmware bin via USB serial. The complete sequence:
 *   1. open the SerialPort + Transport
 *   2. ESPLoader.main() → auto-detect chip, sync, upload stub
 *   3. writeFlash() at 0x0 (the merged image carries
 *      bootloader/partitions/app at canonical offsets internally)
 *   4. ESPLoader.after('hard_reset') to reboot into the new firmware
 *
 * Throws when `bin` doesn't pass `assertMergedImage` so a bad input
 * is rejected before the chip is touched.
 */
export async function flashFirmware(
  port: SerialPort,
  bin: Uint8Array,
  opts: FlashOptionsExt = {},
): Promise<{ address: number; merged: boolean }> {
  assertMergedImage(bin)
  const address = opts.forceAddress ?? 0x0
  await flashRegions(
    port,
    [{ address, bytes: bin, label: 'firmware.bin (merged)' }],
    opts,
  )
  return { address, merged: true }
}

/**
 * Flash an arbitrary set of regions in one esptool-js session.
 *
 * Use this for the PlatformIO-equivalent multi-file flash:
 *
 *   bootloader.bin  → 0x0
 *   partitions.bin  → 0x8000
 *   firmware.bin    → 0x10000
 *
 * esptool-js writes the regions in array order in a single
 * write_flash call so the bootloader region is committed before the
 * app, which is the same order esptool-py uses. `reportProgress` is
 * fired per region with `fileIndex` matching the array index.
 */
export async function flashRegions(
  port: SerialPort,
  regions: ReadonlyArray<{ address: number; bytes: Uint8Array; label: string }>,
  opts: FlashOptionsExt = {},
): Promise<void> {
  if (regions.length === 0) {
    throw new Error('flashRegions: no regions to write')
  }
  const baudrate = opts.baudrate ?? 921600
  const transport = new Transport(port, false)
  try {
    const loader = new ESPLoader({
      transport,
      baudrate,
      terminal: makeTerminal(opts.onLog),
    })

    opts.onProgress?.({ phase: 'connect', percent: 0 })
    await loader.main('default_reset')

    if (opts.eraseAll) {
      opts.onProgress?.({ phase: 'erase', percent: 5 })
      await loader.eraseFlash()
    }

    const totalBytes = regions.reduce((s, r) => s + r.bytes.length, 0)
    const cumBefore: number[] = []
    {
      let acc = 0
      for (const r of regions) {
        cumBefore.push(acc)
        acc += r.bytes.length
      }
    }

    // esptool-js 0.6's `writeFlash` works with raw Uint8Array directly:
    // it pads to 4-byte alignment, calls `pako.deflate(image)` which
    // wants a Uint8Array, and then iterates the deflated output as a
    // typed array. Earlier wrappers in this file converted to a binary
    // string for an even older esptool-js, but with 0.6 that triggers
    // `ESP_TOO_MUCH_DATA (status 201,0)` mid-stream because passing a
    // string to pako.deflate UTF-8-encodes it, doubling every byte
    // ≥128. The compsize advertised by `flashDeflBegin` then no longer
    // matches the actual deflated stream length and the stub aborts.
    const fileArray = regions.map((r) => ({
      data: r.bytes,
      address: r.address,
    }))

    const flashOpts: FlashOptions = {
      fileArray,
      flashMode: 'keep',
      flashFreq: 'keep',
      flashSize: 'keep',
      eraseAll: false, // explicit eraseFlash above when requested
      compress: opts.compress ?? false,
      reportProgress: (fileIndex, written, _total) => {
        // Roll per-region progress up into a single 0..100 bar across
        // the full multi-region write. Without this, the bar resets to
        // 0% three times during a full provisioning pass.
        const cumWritten = (cumBefore[fileIndex] ?? 0) + written
        const pct = totalBytes > 0
          ? Math.round((cumWritten / totalBytes) * 90) + 5
          : 0
        const label = regions[fileIndex]?.label ?? `region ${fileIndex}`
        opts.onProgress?.({
          phase: 'write',
          percent: Math.min(95, pct),
          message: `${label} (${fileIndex + 1}/${regions.length})`,
          written: cumWritten,
          total: totalBytes,
        } as FlashProgress & { message?: string })
      },
    }
    await loader.writeFlash(flashOpts)

    opts.onProgress?.({ phase: 'reset', percent: 96 })
    await loader.after('hard_reset')
    opts.onProgress?.({ phase: 'done', percent: 100 })
  } finally {
    await safeDisconnect(transport)
  }
}

// ---- helpers ----

function makeTerminal(onLog?: (line: string) => void) {
  if (!onLog) return undefined
  // Buffer until we see a newline so log entries arrive whole.
  let buf = ''
  return {
    clean: () => { buf = '' },
    write: (data: string) => {
      buf += data
      let i: number
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i).replace(/\r$/, '')
        buf = buf.slice(i + 1)
        if (line.trim()) onLog(line)
      }
    },
    writeLine: (data: string) => {
      const line = (buf + data).replace(/\r$/, '')
      buf = ''
      if (line.trim()) onLog(line)
    },
  }
}

async function safeDisconnect(transport: Transport): Promise<void> {
  try { await transport.disconnect() } catch { /* ignore */ }
}
