# Instructions: Mac での動作検証

**発行日:** 2026-05-02
**起票:** 2026-05-02 OTA / UI overhaul セッション (workspace)
**優先度:** 即着手
**実施環境:** macOS (Apple Silicon または Intel いずれでも)

## 背景

これまでの主要開発は Windows 環境で行われてきた。次セッションで mac 環境での
動作検証を行い、OS 依存箇所の retrouflex を確認する。

## 検証項目

### 1. Web Serial API (USB Serial)

- Mac の USB シリアルデバイス命名 (`/dev/cu.usbmodem*` 系) で COM ポート選択
  ダイアログが正しく表示されるか
- esptool-js での USB Serial 書込み (download mode → `firmware_full_serial.bin`)
  が完走するか
- 書込み完了後の自動 reprobe (config conn 再オープン) が macOS でも動くか
- 関連ファイル: `src/utils/serialFlasher.ts`, `src/stores/serialMaster.ts`,
  `src/utils/serialConfig.ts`

### 2. Helper `scan_wifi` の macOS 経路

`hapbeat-helper/src/hapbeat_helper/server.py` の `_scan_macos_airport()` は
`airport -s` を呼ぶが、macOS 14 (Sonoma) 以降この CLI は deprecated。

- macOS 13 以下: `airport -s` で動作確認
- macOS 14+: 空 list が返ることを確認 → fallback 検討
  - 候補: `system_profiler SPAirPortDataType` の出力をパース
  - 候補: `wdutil scan` (要 admin、現実的でない)
  - 最終手段: macOS では Helper scan を諦め、ユーザーに手入力 + history 補助

### 3. Wi-Fi OTA 動作確認

**前提**: device-firmware の以下 instruction が適用済であること:
- `instructions-dual-artifact-output-202605021900.md` (2 ファイル別出力)
- `instructions-fw-version-display-v-prefix-202605021800.md` (OLED v prefix)
- `instructions-tcp-stale-client-keepalive-202605011700.md` (TCP keepalive)

確認手順:
1. `pio run -e necklace_v3_claude` でビルド → `firmware_app_ota.bin` と
   `firmware_full_serial.bin` の両方が `.pio/build/<env>/` に生成されていること
2. Studio のファームウェアタブが両ファイルを別行で表示
3. USB Serial で初期フラッシュ (full_serial)
4. `FIRMWARE_VERSION` を bump して再ビルド
5. Wi-Fi OTA 書込み → reboot 後に Studio log drawer に
   `verify OK — fw=<新バージョン>` が出ること
6. OLED に `v<新バージョン>` (6 文字) が表示されること

### 4. UI / レイアウト

- DevicesModal の z-index が macOS Safari / Chrome の両方で前面表示されるか
  (Display tab を開いた状態で問題ないか)
- SSID combobox の ▼ クリック動作 (macOS 特有のスクロール挙動が無いか)
- フォント表示 (3-tier color の差が macOS Retina ディスプレイで適切に判別できるか)

### 5. TCP 詰まり再現

Wi-Fi OTA / Display 書込みを連打して 詰まり が再発しないか確認:
- Helper retry timing (1.5s / 0.3s) が macOS で適切か
- firmware keepalive が効いて 5s 以内に stale s_client が解放されるか

## 完了条件

- [ ] mac で Wi-Fi OTA 書込みが `verify OK` で通る
- [ ] mac で USB Serial 書込みが完走する
- [ ] mac で `scan_wifi` の挙動が確認できている (動かないなら fallback 案を
      検討 instruction を切り出す)
- [ ] OS 依存の問題が発見されたら個別 instruction に切り出す
- [ ] 本ファイルを `instructions/completed/` に移動
