/**
 * ESP32 firmware image (.bin) のプリフライト検証。
 *
 * Wi-Fi OTA で送る直前に呼んで、明らかに不正なファイルを書込み前に弾く。
 * これがあると「壊れた image を flash → bootloader が SHA256 で弾いて
 * 旧スロットに rollback → 古い版で起動」という固有のバグを未然に防げる。
 *
 * ESP32 application image header (image_header_t):
 *   offset 0:  magic byte (must be 0xE9)
 *   offset 1:  segment count
 *   offset 4:  entry point address
 *   offset 12: chip ID (ESP32-S3 = 0x09, ESP32 = 0x00, ESP32-S2 = 0x02, ...)
 *   offset 23: hash_appended flag (0x01 if image is followed by SHA-256)
 *
 * 参考: esp-idf/components/bootloader_support/include/esp_app_format.h
 */

export const ESP_IMAGE_MAGIC = 0xe9
export const ESP_CHIP_ID_ESP32_S3 = 0x09

/** App パーティションの実用最小値。bootloader / partition table を除く本体だけで
 *  100 KB 未満なら明らかに不正 (空ファイル / 切れ端) と見なす。 */
const MIN_APP_BYTES = 100 * 1024

/** App パーティションの推定上限。Hapbeat は 1.5 MB の OTA slot を 2 個切っている。 */
const MAX_APP_BYTES = 2 * 1024 * 1024

export interface OtaValidationResult {
  ok: boolean
  /** 失敗時の人間向けメッセージ。Studio のダイアログに表示する想定。 */
  reason?: string
  /** 成功時に header から読み取れたメタ情報 (ログ・診断用) */
  info?: {
    magic: number
    segments: number
    chipId: number
    chipName: string
    hashAppended: boolean
    sizeBytes: number
  }
}

function chipIdToName(chipId: number): string {
  switch (chipId) {
    case 0x00: return 'ESP32'
    case 0x02: return 'ESP32-S2'
    case 0x05: return 'ESP32-C3'
    case 0x09: return 'ESP32-S3'
    case 0x0c: return 'ESP32-C2'
    case 0x0d: return 'ESP32-C6'
    case 0x10: return 'ESP32-H2'
    default:   return `unknown (0x${chipId.toString(16)})`
  }
}

/**
 * OTA 用 .bin の妥当性を検査する。
 *
 * 検証項目:
 * 1. 最低限のサイズ (空ファイル / 短すぎる切れ端を弾く)
 * 2. Magic byte (0xE9) — ESP32 image でない場合は即停止
 * 3. Chip ID — Hapbeat は ESP32-S3 固定なので 0x09 以外は警告
 * 4. ファイル先頭が "merged image" (= bootloader を含む完全 image) でないか確認
 *    (merged を OTA で送ると bootloader 領域も書き込むことになり deadly)
 *
 * @param bytes 送信予定の生バイト
 * @param expectedChipId target デバイスの chip ID (default: ESP32-S3)
 */
export function validateOtaImage(
  bytes: Uint8Array,
  expectedChipId: number = ESP_CHIP_ID_ESP32_S3,
): OtaValidationResult {
  // 1) サイズ
  if (bytes.length < MIN_APP_BYTES) {
    return {
      ok: false,
      reason:
        `ファイルが小さすぎます (${bytes.length.toLocaleString()} bytes)。`
        + ` 100 KB 以上の app image を選択してください。空ファイル / 一部しか`
        + ` ダウンロードできていない可能性があります。`,
    }
  }
  if (bytes.length > MAX_APP_BYTES) {
    return {
      ok: false,
      reason:
        `ファイルが大きすぎます (${bytes.length.toLocaleString()} bytes)。`
        + ` OTA partition の上限を超えています。merged image (bootloader 含む)`
        + ` を誤って選択している可能性があります — Serial flash で書き込むか、`
        + ` app-only の .bin を指定してください。`,
    }
  }

  // 2) Magic byte
  const magic = bytes[0]
  if (magic !== ESP_IMAGE_MAGIC) {
    return {
      ok: false,
      reason:
        `先頭バイトが 0x${magic.toString(16).padStart(2, '0').toUpperCase()} です`
        + ` (期待 0xE9)。これは ESP32 application image ではありません — `
        + ` ファームウェアの .bin を選び直してください。`,
    }
  }

  // 3) merged image 検出 (bootloader が 0x0 にあり、partition table が 0x8000 にある形)
  //    OTA で送るのは「app のみ」(0x10000 以降を切り出した部分) なので、もし
  //    第 0x8000 byte 周辺に partition table magic (AA 50) があったら merged。
  if (bytes.length > 0x8002 && bytes[0x8000] === 0xaa && bytes[0x8001] === 0x50) {
    return {
      ok: false,
      reason:
        `これは merged image (bootloader + partition + app) です。OTA では`
        + ` app パートだけを送る必要があります — 「firmware_app_ota.bin」`
        + ` または app-only の .bin を選び直してください。`,
    }
  }

  // 4) Chip ID
  const segments = bytes[1]
  const chipId = bytes[12]
  const hashAppended = (bytes[23] & 0x01) === 0x01
  const chipName = chipIdToName(chipId)
  if (chipId !== expectedChipId) {
    return {
      ok: false,
      reason:
        `Chip ID が一致しません: image=${chipName} (0x${chipId.toString(16)}), `
        + `device 期待値=${chipIdToName(expectedChipId)} (0x${expectedChipId.toString(16)})。`
        + ` 別チップ向けにビルドされた .bin を選択している可能性があります。`,
    }
  }
  if (segments === 0 || segments > 16) {
    return {
      ok: false,
      reason:
        `image header の segment 数が不正です (${segments})。`
        + ` ファイルが破損している可能性があります — 再ダウンロードして再試行してください。`,
    }
  }

  return {
    ok: true,
    info: {
      magic,
      segments,
      chipId,
      chipName,
      hashAppended,
      sizeBytes: bytes.length,
    },
  }
}
