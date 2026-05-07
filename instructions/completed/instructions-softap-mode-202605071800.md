# Studio: SoftAP モード対応

**作成日:** 2026-05-07
**起点セッション:** workspace `stoic-mirzakhani-fe72b1` worktree (device-firmware v0.1.0 で SoftAP 実装完了)
**優先度:** 高 (device-firmware v0.1.0 が出てから新しい command を Studio が叩けないと feature が宙に浮く)
**関連 DEC:** DEC-030 (workspace docs/decision-log.md, 別途追記予定)

---

## 背景

device-firmware v0.1.0 で SoftAP モードを実装した。デバイスはボタン combo か TCP コマンドで AP / STA を切り替えられる。Studio 側はまだ:
- 現在 AP モードかどうか判定していない
- AP モード関連コマンド（`enter_ap_mode` / `set_ap_pass` 等）を叩く UI がない
- 「設定したい→ AP モードに切替→ Wi-Fi に繋ぎ直し」のフロー案内がない

**ユーザー要件**: Studio から
1. デバイスを AP モードに切り替えられる
2. AP password を設定 / 解除できる
3. 現在 AP モードの場合に専用 UI を出す（接続中クライアント数表示など）
4. AP に繋ぎながら Wi-Fi 設定 → STA に戻すオンボーディング案内

---

## 仕様

### 確定した SoftAP 仕様（device 側）

| 項目 | 値 |
|---|---|
| SSID | `Hapbeat-XXXXXX`（MAC 末尾 6 桁 hex 自動生成、Studio からは変更不可） |
| Password | デフォルトなし（open AP）。`set_ap_pass` で WPA2 設定可（8-63 chars）。空文字で open に戻る |
| Channel | `ESPNOW_DEFAULT_CHANNEL=1`（固定） |
| IP | `192.168.4.1`（softAP デフォルト） |
| mDNS | STA と同じ `_hapbeat._tcp` |
| 自動 timeout | クライアント未接続が **10 分続いたら** 自動 STA 復帰 |
| 切替方式 | NVS フラグ + `ESP.restart()`（hot switch しない） |

### device 側コマンド（v0.1.0 で追加済）

TCP 7701 / Serial 共通:

| cmd | 引数 | 動作 |
|---|---|---|
| `enter_ap_mode` | なし | NVS `boot_mode = "ap"` 書込 → restart |
| `enter_sta_mode` | なし | NVS `boot_mode = "sta"` 書込 → restart |
| `set_ap_pass` | `{ "pass": "<8-63 chars>" }` または `""` | NVS `ap_pass` 書込（空で open） |
| `clear_ap_pass` | なし | `ap_pass` 削除 → open |
| `get_ap_status` | なし | `{mode, boot_mode, has_pass, ssid?, ip?, client_count?}` |

`get_info` の拡張フィールド:
```jsonc
{
  "status": "ok",
  // ... 既存フィールド ...
  "mode": "sta" | "ap",
  // AP モード時のみ:
  "ap_ssid": "Hapbeat-A1B2C3",
  "ap_ip": "192.168.4.1",
  "ap_has_pass": false,
  "ap_client_count": 1
}
```

---

## Studio 側 変更点

### 1. デバイスモード判定（必須）

`get_info` のレスポンスに `mode` フィールドが追加された。

**変更ファイル候補:**
- `src/store/devicesStore.ts`（または同等のデバイス state 管理）
- `src/types/Device.ts` (型定義に `mode: "sta" | "ap"` 追加)

**振る舞い:**
- `mode === "ap"` のデバイスはカード／一覧でバッジ `AP MODE` を表示（色は magenta 推奨、device LED と一致）
- `mode === "ap"` のデバイスでは Wi-Fi プロファイル管理 UI は **「Wi-Fi 設定」フローへ誘導するボタンに置換**（Wi-Fi STA 関係の機能はモード違いで動かないため）
- `ap_client_count` を OLED と同様に表示（"1 client connected" 等）

### 2. AP モード切替ボタン（必須）

Devices タブ → Settings カード（既存）に「AP モード切替」ボタン追加。

**STA → AP へ切替** ボタン:
```
[ AP モードに切り替え ]
  押下 → 確認モーダル表示
    "デバイスを AP モードに切り替えます。
     現在の Wi-Fi 接続が切断され、
     Hapbeat-XXXXXX という SSID で
     直接接続できるようになります。
     [Cancel] [Switch to AP]"
  → enter_ap_mode コマンド送信
  → デバイス再起動 ~5 秒
  → 再起動後 Studio はデバイスを mDNS で再検知（IP は新 AP の 192.168.4.1）
```

**AP → STA へ切替** ボタン:
```
[ 通常モード（STA）に戻す ]
  → 確認モーダル
  → enter_sta_mode コマンド送信
  → デバイス再起動 → STA で復帰
```

### 3. AP password 設定 UI（必須）

Devices タブ → Settings カード → 「AP password」セクション。

**UI:**
```
AP password:  [ ******** ] [Set] [Clear (open AP)]
              ⓘ オープン状態だと、誰でも AP に接続して
                 デバイスを操作できる可能性があります。
                 Studio 等のツールが必要なので
                 一般のスマホユーザーは何もできませんが、
                 公共 LAN では設定を推奨します。
```

**バリデーション:**
- 8-63 chars（device 側で reject される）
- 空文字 → `clear_ap_pass` を呼ぶ

**API:**
- WS protocol via Helper: `device_command` action with `cmd: "set_ap_pass", pass: "<value>"`
- 成功時: AP モード中なら「次回 AP 起動時に有効になります」とメッセージ
  - 注: 現在の AP セッション中は pass 変更が即時反映されない（restart が必要）。これは device 側の仕様

### 4. オンボーディング: AP → Wi-Fi 設定 → STA フロー（推奨）

新規ユーザー向けに「Wi-Fi 接続できなくなった時の救済 UX」を作る。

**シナリオ:**
1. ユーザーがデバイスでボタン combo を 3 秒押下 → AP モードに切替（OLED に SSID 表示）
2. PC を `Hapbeat-XXXXXX` SSID に接続
3. Studio を開く → デバイスが AP モードで自動検出される
4. Studio が「AP モード検出。Wi-Fi 設定して STA モードに戻りますか？」とウィザード表示
5. Wi-Fi profile を追加（既存の `set_wifi` フロー流用）
6. Wi-Fi 接続成功確認後「STA モードに戻す」ボタンが有効化
7. ユーザーが押すと `enter_sta_mode` で再起動 → 元に戻る

**実装ポイント:**
- 既存の `OnboardingWizard` を拡張するか、別 wizard `ApRecoveryWizard` を作る
- AP 検出は `mode === "ap"` で判定（mDNS から取得）
- Wi-Fi 接続成功は `get_wifi_status` で確認（ただし AP モード中は STA 切断状態なので、`set_wifi` してから一定時間待ち、`get_info` で `wifi_connected: true` を確認するロジックが必要）

> 注: AP モード中も `set_wifi` は受け付ける仕様（device 側で reject していない）。プロファイル登録だけして STA 切替で実際に接続する流れになる。

### 5. AP モード中の機能制限警告（推奨）

AP モード中は以下が動作しない／意味をなさない:

| 機能 | AP モード時の挙動 | UI 推奨 |
|---|---|---|
| Wi-Fi profile 管理 (add/connect/remove) | 登録は可だが繋がらない | 「STA モードで使用してください」灰色表示 |
| ESP-NOW 受信 | 無効（MVP では disable） | バッジ "ESP-NOW: off in AP mode" |
| Live Audio (UDP streaming) | 動く（AP 経由 PC → device 直接） | ✓ そのまま使える |
| Kit deploy (TCP 7701) | 動く | ✓ そのまま使える |
| 触覚再生（PC → UDP 7700） | 動く | ✓ そのまま使える |
| OTA update | 動く | ✓ そのまま使える |

---

## 実装順序の推奨

1. **Phase 1（最小）**: get_info の `mode` フィールド読み取り + AP MODE バッジ表示 + AP→STA 戻りボタンのみ
2. **Phase 2（中核）**: STA→AP 切替ボタン + AP password 設定 UI
3. **Phase 3（UX）**: ApRecoveryWizard + 機能制限警告
4. **Phase 4（仕上げ）**: docs/ 配下のユーザー向け使い方ドキュメント追加

Phase 1+2 で機能要件は満たせる。Phase 3 は UX の仕上げ。

---

## Helper 側の変更（参考）

Helper は基本的に WebSocket でコマンドを透過するだけなので追加実装不要。ただし以下を確認:

- mDNS browse で AP モードのデバイス（IP `192.168.4.1` でリッスン）も拾えるか
  - PC が AP に接続済みなら mDNS は同 LAN として機能するはず
- `_send_tcp_to_many` で AP IP もカバーされているか
- AP モードへの切替コマンド送信後、デバイスが再起動して mDNS から消える → 再 advertise されるまでの期間（~3-5 s）を Helper が offline 扱いしないように既存の offline detection を確認

→ 大きな変更は不要だが、AP モード時の IP `192.168.4.1` を含む device entry が他のデバイス検出と混在しないように、device id で識別すること（既存の MAC ベース ID で問題ないはず）。

---

## 検証

### 単体動作（Studio）

1. 既存デバイスを STA 接続中に Studio で確認 → mode: "sta" バッジなし
2. デバイス側でボタン combo（SW0+SW2 / SW0+SW4 を 3 秒）→ AP モードに切替
3. PC を `Hapbeat-XXXXXX` SSID に接続
4. Studio 再読み込み → デバイスが AP モード badge 付きで表示される
5. 「STA モードに戻す」ボタンで元に戻れる
6. AP password を設定 → AP モード再起動 → SSID にロックがかかっている確認

### Edge cases

- AP モード中に Wi-Fi profile を追加 → 接続未確立だが NVS には保存される → STA 切替で接続される
- AP モード中の OTA update → 動作する（device は同 AP 上の PC から OTA 受信）
- AP password を 7 文字で送信 → device が reject → Studio 側でエラー表示
- 10 分 idle で自動 STA 復帰 → Studio が新 IP で device を再検知できるか

---

## 関連参考

- `hapbeat-device-firmware/src/wifi_ap_mode.h` — API 定義
- `hapbeat-device-firmware/src/wifi_ap_mode.cpp` — 実装本体
- `hapbeat-device-firmware/CHANGELOG.md` — v0.1.0 変更履歴
- `hapbeat-sdk-workspace/docs/agent-memory/project_range_scaling_espnow_vs_wifi.md` — SoftAP の位置付け（メイン経路は ESP-NOW、AP は setup 用途）
- `hapbeat-sdk-workspace/CLAUDE.md` 接続シナリオ A: Hapbeat SoftAP（ルーターなし）
