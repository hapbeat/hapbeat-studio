# Instructions: Wi-Fi scan を Helper fallback で補う

**発行日:** 2026-05-03
**起票:** mac 動作検証セッション (workspace)
**優先度:** 中（オンボーディング体験への影響大、ただし手入力で迂回可能）
**対象 repo:** `hapbeat-studio`

## 背景

Studio の Wi-Fi 設定フォームの SSID scan は、接続経路で実装が分岐:

- **USB Serial 接続時** (`device.ipAddress.startsWith('serial:')`):
  デバイス側の `WiFi.scanNetworks()` を呼ぶ (`serialMaster.scanWifi()` → 内部で
  `{cmd:"scan_wifi"}` を Serial に送る)
- **LAN 接続時**: Helper の WS `scan_wifi` メッセージ → OS 側 (netsh /
  airport / nmcli) で実行

実装は `src/components/devices/WifiProfilesForm.tsx` の `runScan()`:

```ts
if (isSerial) {
  const r = await masterScanWifi()  // 必ずデバイス side
  setScanResults(r)
  ...
} else {
  helperSend({ type: 'scan_wifi', payload: {} })  // 必ず Helper side
}
```

設計意図: 「デバイスが置かれる場所の電波環境を一番正確に知っているのは
デバイス自身の Wi-Fi 受信なので、Serial 接続中はそちらを優先する」。

## 報告された問題

mac 検証セッション (2026-05-03) でユーザー報告:

> wifi に接続した hapbeat 経由ならスキャンの結果が表示されるけど、
> wifi 未接続だと表示されない。helper 経由で studio が起動している PC から
> 取得になっていないのでは？

要するに **オンボーディング (USB Serial 接続) の段階で SSID scan が空配列**
になっているのを観測している。

### 推定原因

ESP32 の `WiFi.scanNetworks()` は **WIFI_STA モードに入っていて、かつ
radio が初期化されている**ことを要求する。出荷時 / 新規ファーム書込直後の
状態だとどちらも満たされていないことがあり、scan が 0 件で帰る。

## 期待する動作

PC (Studio が動いているホスト) は通常 Hapbeat と同じ Wi-Fi 環境に居る
ことを前提とできる (でないと LAN device と話せない)。よって PC の Helper
scan で SSID 候補を補えば、オンボーディング時のフォーム空白問題を実害
ゼロで救える。

## 修正案 (推奨: B = フォールバック)

### A. Serial も Helper も並行実行 → 結果をマージ

長所: 両方の SSID を見せられる。 / 短所: 表示が混乱する可能性 (RSSI 値が
2 系統で意味が違う)。

### B. デバイス scan が empty/error なら Helper scan に fallback **(推奨)**

```ts
const runScan = useCallback(async () => {
  setScanState('scanning')
  if (isSerial) {
    try {
      const r = await masterScanWifi()
      if (r && r.length > 0) {
        setScanResults(r)
        setScanState('done')
        return
      }
      // empty → fall through to Helper scan
      log('device scan returned empty; falling back to Helper OS scan')
    } catch (e) {
      log(`device scan failed: ${e}; falling back to Helper OS scan`)
    }
  }
  // LAN device or fallback
  helperSend({ type: 'scan_wifi', payload: {} })
}, [isSerial, masterScanWifi, helperSend])
```

副次変更:
- `useEffect` の `lastMessage` ハンドリングは現状で OK (scan_wifi_result 受信時
  に scanState===scanning なら反映)
- 注: Serial fallback パスに入った後も `scanState` は `'scanning'` のまま
  なので、Helper の result が来た時に正しく拾える

長所: 設計意図を残しつつ実害ゼロ。 / 短所: 実装が小さく素直。

### C. 全部 Helper scan に統一

設計意図を捨てる。実装は最小だが、デバイス側 scan の利点 (実機が見える
電波環境) を完全に放棄する。

## 完了条件

- [ ] B 案を実装 (`WifiProfilesForm.tsx`)
- [ ] mac で onboarding ウィザードから Wi-Fi 設定フォームに入った時、
      Helper scan の結果が SSID dropdown に出ることを確認
- [ ] LAN 接続時の従来動作 (Helper scan) が壊れていないことを確認
- [ ] 関連: log drawer に「device scan empty → Helper fallback」がデバッグ
      可能なメッセージで出ること
- [ ] 本ファイルを `instructions/completed/` に移動

## 関連ファイル

- `src/components/devices/WifiProfilesForm.tsx` (主対象)
- `src/stores/serialMaster.ts:scanWifi()` (Serial side scan)
- `src/utils/serialConfig.ts:cmd=scan_wifi` 周辺 (Serial protocol)
- `../hapbeat-helper/src/hapbeat_helper/server.py:_handle_scan_wifi`
  (OS scan 実装)

## 申し送り (firmware 側)

Serial scan が空になる根本原因 (出荷時 WIFI_STA 初期化問題) は別途
firmware で対処したい:
- `cmdScanWifi` 内で `WiFi.mode(WIFI_STA)` を確実に呼び、必要なら
  `WiFi.disconnect(false)` 後に scan を発行
- これは `hapbeat-device-firmware/instructions/` に切り出す候補

ただし Studio 側 fallback 実装が入っていれば実害は消えるので、firmware
修正は緊急度低 (Studio fix 後に切り出し)。
