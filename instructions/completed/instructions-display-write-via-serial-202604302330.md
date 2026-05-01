# Instructions: Serial 接続中の Display 書込みは仕様か挙動確認

**発行日:** 2026-04-30
**起票:** Onboarding 改善セッション末尾
**優先度:** 即着手

## 症状

Serial pseudo-device (`ipAddress: "serial:..."`) を選択した状態で
**Display タブから「書き込み」**(`write_ui_config`) を実行すると失敗する。
仕様か未実装か未確認。

## 経路の現状

`DisplayEditor.handleDeploy` (前セッションで修正済み):

```ts
managerSend({
  type: 'write_ui_config',
  payload: { config: uiConfig, targets },  // ← targets は selectedIps
})
```

`useDeviceTransport` を経由していない (Display は LAN 専用の前提で書かれた)。
`managerSend` は Helper の WS に直接投げるので、`targets` が `serial:xxx`
だと helper の `_send_tcp_to_many` → `connect failed` (TCP 7701 への接続が
serial: address では成立しない)。

## 修正方針

### 案 A: Display も `useDeviceTransport` 経由にする
- LAN device (IPv4) → 既存通り Helper WS
- Serial pseudo-device → `master.sendConfigCmd({cmd: 'write_ui_config', config})`
- firmware 側 `serial_config.cpp` の dispatch に `write_ui_config` の case を
  追加する必要あり (現状 TCP 7701 のみ実装、Serial 未対応の可能性 — 要確認)
  → **firmware 編集が必要なら instruction を別途起こす**

### 案 B: Serial pseudo-device 選択時は Display 書込みボタンを disabled
- Display は LAN 経由のみ動作、Serial では灰色化 + tooltip
- 「Wi-Fi に乗ってからやってください」でユーザーを誘導
- 実装コスト最小

ユーザーの言う「仕様？」を確認する意図に対しては:
- **答え**: 現状は LAN 専用。Serial では動作しない。
- **対応**: 仕様として固定するなら案 B、機能拡張するなら案 A。

## タスク

1. `serial_config.cpp` で `write_ui_config` cmd を受け付けているか確認 (実装
   済みなら案 A 直行、未実装なら firmware repo に instruction)
2. ユーザーと相談: どちらの方針にするか
3. 選んだ方針で実装 (案 A または案 B)
4. UI Config だけでなく **Kit deploy** (`deploy_kit_data`) も同じ問題を
   抱えるかチェック (Kit ZIP は 100 KB+ あって Serial でも投げられる構造を
   firmware が持っているかは別調査)

## 完了条件

- [ ] Serial pseudo-device 選択時の Display 書込みの動作が決まる
- [ ] 案 A 採用なら Serial 経由でも書込み完了
- [ ] 案 B 採用なら disabled 表示 + tooltip
- [ ] 本ファイルを `instructions/completed/` に移動

## 依存関係

- 案 A の場合: device-firmware に `serial_config.cpp` の cmd 追加
  instruction が必要 (要確認)
