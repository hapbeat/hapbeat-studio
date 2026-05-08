# applied: Serial flash で otadata を 0xFF erase する

**起点 repo:** workspace device-firmware セッション
**作成日:** 2026-05-09
**関連 commit:** hapbeat-studio `80a014b` / hapbeat-device-firmware `ae8f7ed`

## 背景

ユーザー報告: necklace を Web Serial 経由で v0.0.37 を書き込んでも、起動後の OLED が依然として旧バージョンを表示する。band では同じ操作で v0.0.37 になる (個体によって挙動が違う)。

## 真因

OTA 後の otadata は ota_1 (0x1F0000) を指している。Studio (esptool-js) の serial flash は NVS + otadata 領域 (0x9000-0x10000) を一括スキップしていたため:

1. ota_0 (0x10000) には v0.0.37 が書き込まれる ✓
2. otadata は OTA 直後の値のまま — ota_1 を指す ✗
3. bootloader は otadata に従い **ota_1 (旧 firmware) から boot**

OLED 表示・`get_info.fw` ともに旧版のままになる。band で「成功」したのは、たまたまその個体の otadata が ota_0 を指す状態だったため。

## 修正

`src/utils/firmwareLibrary.ts::fetchFirmwareSerialRegions` と `src/components/devices/FirmwareSubTab.tsx` (local file path) の両方を 3-region split に変更:

```
[0x0,    0x9000)  bootloader+partitions  → write
[0x9000, 0xE000)  NVS                    → skip (preserve Wi-Fi)
[0xE000, 0x10000) otadata                → write 0xFF × 8 KB (erase)
[0x10000, end  )  app (ota_0)            → write
```

otadata がオール 0xFF だと bootloader は OTA selection 未初期化と判定し ota_0 (今書いたばかりのスロット) から boot する。NVS は引き続き preserve されるので Wi-Fi profile / device name / group ID は失われない。

## 検証状況

- typecheck (`npx tsc --noEmit`) PASS
- 実機検証は未 — necklace で v0.0.37 が boot することをユーザー側で確認希望

## アクション

- review → completed/ へ移動
- device repo 側 (`merge_firmware.py::upload_split`) も同等修正済 (commit `ae8f7ed`) — pio run -t upload 経由でも同じ動作になる
