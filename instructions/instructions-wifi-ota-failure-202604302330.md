# Instructions: Wi-Fi OTA 書込み失敗 → 電源再起動で復旧する事象の究明

**発行日:** 2026-04-30
**起票:** Onboarding 改善セッション末尾
**優先度:** 即着手

## 症状

ユーザー報告 (実機検証済み):

1. Studio から **Wi-Fi OTA 書き込み** ボタンを押す
2. 書込み失敗 (詳細メッセージ未確認 — Studio log drawer / Helper logs に
   `0/1 ok` 系の write_result が出ている可能性)
3. **デバイスの電源を OFF→ON すると書き込めるようになる**

加えて: OTA 経由の書込みでデバイスが **古いバージョンのまま動作** する
ケースがある (デバイスの BUILD_TAG が更新されない)。

## 調査の出発点

### A. Wi-Fi OTA 失敗の経路

Studio `FirmwareSubTab.tsx` の `submit()` (line ~360) は:

```ts
sendTo({
  type: 'ota_data',
  payload: { bin_base64: bytesToBase64(bin.bytes) },
})
```

helper `server.py` の `ota_data` 処理 → `_do_ota_to_device` (server.py:967-)
が TCP 7701 に `ota_begin` → 4 KB チャンク送信 → reply 待ちの 3 段。

考えられる失敗点:
1. **デバイス側 TCP server がハングしている**: 前セッションで `checkWifiServices`
   の TCP/UDP/mDNS 個別再試行を入れたが、それでも Wi-Fi 切替直後など
   socket バインドが完了していない短時間がある。電源 OFF/ON で完全
   再起動 → サービス確実に立ち上がる、で復旧
2. **ota_begin への nack** (`{status: "error"}` を返す状態): 直前の OTA が
   未完了で otadata パーティションが中途半端な値、 もしくは LittleFS が
   占有中
3. **Helper 側 connection.connect() 失敗**: 別タスクが TCP 7701 を握っている
   (まれ)

ログを取るには Studio の log drawer で:
- `helper ✗ ota_data: ...` の詳細メッセージ
- `helper ✗ phase=connect/io/no_reply` のいずれか

### B. OTA で「古いバージョンのまま」現象

partitions.csv:
```
ota_0,      app,  ota_0,   0x10000,  0x1E0000,
ota_1,      app,  ota_1,   0x1F0000, 0x1E0000,
```

OTA は ota_0 / ota_1 の片方に書き込んで otadata を切替えるダブルバッファ。
仮説:
- 書込み完了後の reboot で **otadata の切替が反映されていない**
- otadata パーティションが破損している (= NVS と同じく flash 書込みで
  0xFF にされた可能性 → partitions.csv では `otadata @ 0xE000`、これは
  merged image flash で 0xFF 上書きされる) → OTA が常に ota_0 に書き
  続けている可能性

→ NVS 保護で入れた **0x9000-0x10000 スキップ** で otadata も保護済み
(0xE000 は範囲内)。pio upload 後の動作はこれで改善するはず。

ただし **OTA-only の状況** (LAN 経由で OTA を 2 回実行): 1 回目の OTA は
ota_1 に書く → reboot で ota_1 起動。2 回目は ota_0 に書く → reboot で
ota_0 起動。... と本来切り替わるが、**otadata partition が 0xFF (未初期化)
のままだと bootloader は default の ota_0 にしか戻らない** ため「古い
バージョンになる」現象が説明できる。

## タスク

### 1. 失敗時のログ収集
- ユーザー側で Wi-Fi OTA 失敗を再現してもらい、Studio の log drawer の
  `helper ✗ ota_data: ...` 全文を取得
- Helper 側 `_do_ota_to_device` (server.py:967) の `ota_begin` 応答 / chunk
  送信中の OSError をログに残す (現状 traceback だけ)

### 2. デバイス側の TCP server 状態を冒頭で確認
- Studio `FirmwareSubTab.submit()` の最初に `ping_device` を投げて、
  デバイスが 7701 で応答するかを事前確認
- 応答なければ「デバイスが応答しません — 電源 OFF/ON してから再試行
  してください」をユーザーに先に提示 (盲撃ちで失敗するより親切)

### 3. otadata 初期化の保証
- 現状 NVS 保護 (`0x9000-0x10000` スキップ) で otadata は保護されているが、
  **新品デバイス (otadata = 0xFF)** は OTA 1 回目で ota_0/ota_1 がどう
  decide されるか firmware-side で要確認
- ESP-IDF の `esp_ota_get_next_update_partition(NULL)` 動作確認
- 必要なら setup() で otadata が 0xFF なら ota_0 を current にマークする
  defensive 初期化を追加 (firmware repo 側で実施)

### 4. OTA 書込み完了後の verify
- 書込み完了後、Studio が `get_info` を投げて返ってきた `fw` / BUILD_TAG
  が想定通りかチェック → 一致しなければ「OTA 後の起動 partition が
  期待と違う」を toast 表示

## 完了条件

- [ ] Wi-Fi OTA が「電源 OFF/ON 不要」で書き込める
- [ ] 古いバージョン残留の再現条件を特定 + fix
- [ ] OTA 失敗ログが phase 別 (connect / ota_begin nack / chunk send / verify)
      で Studio に出る
- [ ] 本ファイルを `instructions/completed/` に移動

## 依存関係

- **Required**: Helper の log 強化 (前セッションで適用済)
- **Downstream**: device-firmware に otadata defensive init を入れる場合は
  firmware repo の instructions/ にも別途 issue を起こす
