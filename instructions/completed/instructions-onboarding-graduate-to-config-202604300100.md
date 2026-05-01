# Instructions: onboarding 画面で Serial 接続成功後に Config UI へ自動遷移

**発行日:** 2026-04-30
**起票:** 2026-04-29 device-tab セッション (end-session 持ち越し)
**優先度:** 即着手

## 背景

未接続状態の onboarding 画面 (`DeviceDetail.tsx` の早期 return) は
現在 `<SerialConfigSection />` + `<FirmwareSubTab serialOnly />` の
2 セクションを並べているだけで、Serial 接続が成功してデバイス情報が
取得できた後も画面は onboarding のまま留まる。

ユーザー要件: **「正しく Hapbeat に Serial 接続できたら、その時点で
通常の設定画面に遷移する導線」** が欲しい。

つまり:

1. ユーザーが onboarding で `Serial 接続` ボタンを押す
2. `openConfigConnection` が成功 → `get_info` が返る
3. その情報を使って **そのまま Identity / WiFi profiles / UiConfig /
   DebugDump の本体 UI に切り替わる** (Config sub-tab と同じ画面)
4. ユーザーは引き続き Serial 経由で Wi-Fi 設定や名前変更を行える

現状: onboarding は SerialConfigSection 内で接続/コマンド送信が完結
しており、本体 UI への遷移ロジックが無い。

## 関連ファイル

- `src/components/devices/DeviceDetail.tsx` (early return / onboarding section)
- `src/components/devices/SerialConfigSection.tsx` (現状の Serial 接続パネル)
- `src/components/devices/IdentityForm.tsx`, `WifiProfilesForm.tsx`,
  `UiConfigForm.tsx`, `DebugDumpSection.tsx` (本体 Config UI)
- `src/utils/serialConfig.ts` (`openConfigConnection` の実体)
- `src/stores/deviceStore.ts` (`selectDevice`, `selectedIp`)

## タスク

### 案 A: Serial 接続を「仮想デバイス」として deviceStore に登録
1. `openConfigConnection` で `get_info` 成功時、レスポンスから name /
   mac / fw / address を取り、`useHelperConnection` の devices に
   pseudo-device を inject (例: ipAddress を `serial:<mac>` 等の
   特殊形式にする)
2. `selectDevice(<pseudo ip>)` で primary を切替 → `DeviceDetail` の
   早期 return が抜けて通常 UI を描画
3. 通常 UI の `sendTo` を Helper-WS から Serial 経路に差し替えるための
   abstraction (例: SerialDeviceContext) を導入。IdentityForm /
   WifiProfilesForm 等は `sendTo` の中身を意識しない
4. SerialConfigSection の役割は「接続/切断 status panel + raw コマンド
   送信」程度に縮小。実体の Identity / WiFi 操作は通常 form に統一

### 案 B: onboarding 内に「接続後フォーム」を追加表示
1. SerialConfigSection の現状の form (set_name / set_group / set_wifi /
   profile 一覧) を拡充して Config UI と同等の機能を備える
2. 通常 UI とのコード重複が発生するので、共通化のためのコンポーネント
   抽出が必要

### 推奨

**案 A** を推奨。Serial / WiFi の通信経路を抽象化することで以下の利点:

- onboarding の特殊画面はほぼ不要になり、通常の Devices タブと
  同じ UI で Serial 接続デバイスも操作できる
- 将来 Helper 経由 OTA を Serial 経由に拡張する場合も同じ
  abstraction で対応可能
- Manager の挙動 (Serial 接続デバイスがそのまま device list に出る)
  と整合

### 実装手順 (案 A)

1. `deviceStore` に `serialDevice: DeviceInfo | null` を追加。
   `serial:<mac>` を ipAddress とする pseudo entry。
2. `useHelperConnection` の `devices` プロパティを拡張して
   `serialDevice` がある場合は配列の先頭に merge。
3. `SerialConfigSection` の `openConfigConnection` 成功時に
   `setSerialDevice({...})` を呼んで pseudo を作成 + `selectDevice`。
4. `sendTo` 系を抽象化: `useDeviceTransport(ip)` フックを作成し、
   `serial:` prefix なら conn.send で JSON コマンド、それ以外は
   通常の WS 経由。
5. `DeviceDetail` の早期 return 条件を見直し: 通常 device か serial
   device があれば本体 UI を描画。
6. `SerialConfigSection` を「接続/切断 + 簡易 status」のみに整理。
   form 部分は IdentityForm / WifiProfilesForm に置き換え。

## 完了条件

- [ ] onboarding で Serial 接続 → 接続成功と同時に通常の
      Identity / WiFi / UiConfig / DebugDump タブが表示される
- [ ] その状態から Wi-Fi 設定して reboot → device が LAN に乗ったら
      自動的に通常の WS 経路に切り替わる (or ユーザーが切断 → 再 select)
- [ ] FirmwareSubTab の serialOnly モードは温存 (Serial 接続不可時の
      初期書き込み路として onboarding 下段に残す)
- [ ] 本ファイルを `instructions/completed/` に移動

## 依存関係

- **Required**: 現状の `SerialConfigSection.tsx` のコマンド呼び出し
  ロジックを transport abstraction に移植可能なこと
- **Downstream**: `useDeviceTransport` を導入すると将来の SDK side や
  Bridge 経由ルートにも転用できる
