# 指示書: Manager 機能を Studio に統合する

**配置先:** `hapbeat-studio/instructions/`
**前提:** DEC-026 (Manager → Web UI + Helper Daemon 移行)、`hapbeat-helper` MVP 完了
**作成日:** 2026-04-25

## ゴール

`hapbeat-manager` (PySide6 デスクトップアプリ) を deprecate し、その全機能を `hapbeat-studio` (Web SPA) に統合する。Studio が `ws://localhost:7703` 経由で `hapbeat-helper` と通信し、Helper が UDP/TCP/mDNS を中継してデバイスにアクセスする。

**最終的なユーザー体験**:

1. ユーザーが `pipx install hapbeat-helper` で daemon を一度インストール
2. `hapbeat-helper start` で常駐起動
3. ブラウザで `https://devtools.hapbeat.com` を開く
4. Studio 内のすべての機能（Kit 編集、Manager（デバイス管理）、Live Audio）が単一の SPA で動作

## 統合する Manager 機能

現 `hapbeat-manager` の各タブを Studio の新セクション（`/manager` または既存 Studio の Devices タブ）に移植する：

| 元 Manager タブ | Studio 移植先 | 実装方針 |
|----------------|------------|---------|
| **設定タブ** | Studio に新規 `Devices` セクション | デバイス選択 + Wi-Fi / 名前 / アドレス / グループ設定 |
| **Kit タブ** (転送・一覧) | 既存 Kit Manager を拡張 | 「Deploy to device」ボタン追加（既存実装あり、UI 整理のみ） |
| **再生テストタブ** | Devices セクション内 or 独立 Test タブ | Event ID 入力 + PLAY / STOP / PING |
| **Live Audio タブ** | Studio に新規 `Live Audio` セクション | Windows: getDisplayMedia / Mac: getUserMedia + BlackHole |
| **ファームウェアタブ** | Studio に新規 `Firmware` セクション | esptool-js (Web Serial) で USB 書込 |
| デバイスリスト (左側) | Studio 共通 sidebar に統合 | Helper からの device_list を購読 |

## 主要技術選定

### Web Serial API (esptool-js)

- ファーム書込・初期 Wi-Fi 設定は **Helper を介さず Web Serial で直接デバイスへ**
- `esptool-js` (v0.5.x) を npm install
- Chrome / Edge 限定。Safari / Firefox には警告表示

### getDisplayMedia (Live Audio - Windows)

```ts
const stream = await navigator.mediaDevices.getDisplayMedia({
  audio: { suppressLocalAudioPlayback: false },
  video: true,  // 仕様上 true 必須、video track は破棄
});
const audioTrack = stream.getAudioTracks()[0];
// AudioContext で 16kHz リサンプル → WS 経由 Helper の stream_data へ
```

### getUserMedia (Live Audio - Mac)

- BlackHole 検出: `enumerateDevices()` で `kind === 'audioinput'` から `BlackHole` を探す
- 未検出時: 「BlackHole をインストールしてください」案内 + `brew install blackhole-2ch` リンク表示
- 検出後: `getUserMedia({ audio: { deviceId: blackholeId } })` で取得

## Helper 連携

### 既存の `useManagerConnection` を流用

`src/hooks/useManagerConnection.tsx` の WS URL は `ws://localhost:7703` のまま（Helper も同じポートを使う）。

変更点:
- 接続先名称を「Manager」→「Helper」に rename（変数名・コメント・UI 表示）
- 未接続時の案内文言を「Manager を起動してください」→「`hapbeat-helper start` で起動してください + インストールリンク」

### 新規メッセージ実装

Helper との WS protocol は現 Manager の ws_server.py と互換。Studio 側で新規購読すべきイベント:

- `volume_changed` (push) — デバイスのボリュームノブ変化を UI に反映
- `device_list` (push) — デバイス追加/削除を sidebar に反映

## 実装フェーズ

### Phase 1: Helper 接続まわりの再ラベル (1 セッション)

- `useManagerConnection` → `useHelperConnection` に rename
- 未接続時の UI 文言・インストール案内更新
- README に Helper 必要性を追記

### Phase 2: Devices セクション新規実装 (3-5 セッション)

- ルート: `/manager/devices` または `/devices`
- コンポーネント:
    - `DeviceList.tsx` — sidebar
    - `DeviceDetail.tsx` — 右側ペイン
    - `WifiConfigForm.tsx`
    - `IdentityConfigForm.tsx`
    - `UiConfigForm.tsx`
- ストア: `useDeviceStore.ts` (Zustand)
- WS バインディング: list_devices / write_ui_config / set_wifi etc.

### Phase 3: Firmware セクション新規実装 (2-3 セッション)

- esptool-js 統合
- Web Serial port 選択 UI
- `.bin` ファイル選択 (drag&drop)
- Flash 書き込み + Erase Flash
- 進捗バー

### Phase 4: 再生テスト統合 (1-2 セッション)

- Event ID 入力 + PLAY/STOP ボタン (preview_event 経由)
- Stream begin/data/end の UI（既存 audioStreamer 流用）

### Phase 5: Live Audio セクション (3-4 セッション)

- OS 検出 + ブランチ分岐
- Windows: getDisplayMedia
- Mac: BlackHole 検出 + getUserMedia
- AudioContext + 16kHz resampler
- WS stream_begin / stream_data / stream_end

### Phase 6: Manager deprecation (1 セッション)

- `hapbeat-manager` の README に「deprecated, use Studio + Helper」追記
- `_RECOVERY_ENABLED` 等のレガシーコード整理
- archive 候補としてマーク

## 完了条件

1. Studio 単体（+ Helper）で現 `hapbeat-manager` の全機能が動作
2. デバイス発見・設定・Kit 転送・ファーム書込・Live Audio (Windows) のフル E2E が成功
3. Mac で BlackHole 経由の Live Audio が動作
4. README に Helper のインストール手順記載
5. Helper 未起動時の UI フォールバック（Web Serial だけで設定/書込可能なモード）が動作

## 注意事項

- **既存の Studio 機能を壊さない**: Kit Manager / Display Editor / LED Editor は無改修で動作させる
- **コンポーネント分離を厳守**: 現 Studio の UI パターン（カード型・モーダル編集・サイドバー）を踏襲
- **モバイル/タブレット非対応で OK**: Manager 機能はデスクトップブラウザ前提
- **HTTPS 必須**: Web Serial / getDisplayMedia は secure context のみ動作。`devtools.hapbeat.com` (HTTPS) で運用
- **localhost WS 接続の特例**: HTTPS Web app から ws://localhost への接続は Chrome/Edge は許可、Firefox は要設定。README に注記

## 参考ファイル

- DEC-026: `../docs/decision-log.md`
- Helper 仕様: `../docs/instructions-hapbeat-helper-mvp-202604251800.md`
- 現 Manager UI 参考: `../hapbeat-manager/src/hapbeat_manager/widgets/*.py`
- 現 WS protocol: `../hapbeat-manager/src/hapbeat_manager/ws_server.py`
- 既存 Studio Manager 接続: `src/hooks/useManagerConnection.tsx`
