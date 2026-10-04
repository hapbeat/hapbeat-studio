/**
 * Reads the firmware version from an ESP32 image's app descriptor
 * (`esp_app_desc_t`), so a local .bin can be judged without booting it.
 *
 * Layout (ESP-IDF): the descriptor sits right after the image header + first
 * segment header, at app-image offset 0x20 (magic 0xABCD5432, LE); its
 * `version[32]` field is at 0x30. In a merged full-serial image the app
 * starts at 0x10000, so the same fields are at 0x10020 / 0x10030.
 *
 * Hapbeat device firmware stamps FIRMWARE_VERSION into `version` at build
 * time (hapbeat-device-firmware `scripts/app_desc_version.py`). Older builds
 * carry the prebuilt IDF's "esp-idf: v4.4.7 …" there; anything that is not a
 * Hapbeat version string is reported as null (unknown).
 */

const APP_DESC_MAGIC = 0xabcd5432
const APP_DESC_OFFSET = 0x20
const VERSION_OFFSET = 0x10
const VERSION_SIZE = 32
const MERGED_APP_START = 0x10000

/** `0.5.0`, `v0.5.0`, `0.5.0d7`, `0.5.0-d7`, `0.5.0-rc1`. */
const HAPBEAT_VERSION = /^v?\d+\.\d+\.\d+(?:-?[0-9A-Za-z][0-9A-Za-z.]*)?$/

function descVersionAt(bin: Uint8Array, descOffset: number): string | null {
  const end = descOffset + VERSION_OFFSET + VERSION_SIZE
  if (bin.length < end) return null
  const magic = new DataView(bin.buffer, bin.byteOffset + descOffset, 4).getUint32(0, true)
  if (magic !== APP_DESC_MAGIC) return null
  const field = bin.subarray(descOffset + VERSION_OFFSET, end)
  const nul = field.indexOf(0)
  return new TextDecoder('latin1').decode(nul < 0 ? field : field.subarray(0, nul))
}

/**
 * Version string from an app-only image or a merged full-serial image, or
 * null when there is no descriptor or it holds no Hapbeat version.
 */
export function readAppDescVersion(bin: Uint8Array): string | null {
  const raw = descVersionAt(bin, APP_DESC_OFFSET)
    ?? descVersionAt(bin, MERGED_APP_START + APP_DESC_OFFSET)
  return raw !== null && HAPBEAT_VERSION.test(raw) ? raw : null
}
