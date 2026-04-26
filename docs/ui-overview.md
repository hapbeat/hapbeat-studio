---
title: 画面構成
description: Studio の Kit Manager / Library / Display Editor / LED Editor / Connection 等のパネル構成。
---

## 全体レイアウト

Studio は左サイドバーに各エディタタブが並ぶ構成です。

| タブ | 用途 |
|------|-----|
| **Kit** | Kit 一覧、Event 編集、Library、Deploy |
| **Display** | OLED 表示のブロック配置・ページ管理 |
| **LED** | LED 色・パターン・イベント連動 |
| **Connection** | Manager との WebSocket 接続状態 |

下部のステータスバーには接続中デバイス数・台数バッジ・Save 状態が表示されます。

## Kit Manager

Kit Manager は最も使うタブです。次のセクションに分かれています。

### Library パネル（左）

WAV / 触覚素材ファイルのツリー。Library フォルダから自動 import されます。

- **Built-in**: Studio に同梱の素材
- **My Clips**: ユーザー Library フォルダの素材
- 各クリップ行で個別の amp（音量基準）プリセットを保存可能

### Kit パネル（右）

選択中の Kit に含まれる Event 一覧。

- 列: ID / Mode / Intensity / Wiper / クリップ名 / Action
- 行クリックで選択、`Space` で再生
- **+ Event** で行追加、**Edit** で詳細モーダル
- **Save & Deploy** で Manager に転送

### モーダル編集

Edit ボタンや Event 名のクリックで開く詳細モーダル:

- クリップ選択
- 強度（intensity）と device_wiper（強度補正の左右バランス等）
- mode 切替（FIRE / CLIP / LIVE）
- mode ごとの追加パラメータ（CLIP のループ設定、LIVE のソース選択など）

## Display Editor

OLED 表示のブロック配置エディタ。

- グリッド上にテキスト / アイコン / バッテリーゲージ等のブロックを配置
- 複数ページを定義し、ボタン操作でページ遷移
- `display_layout.json` として export、Manager 経由でデバイスへ書き込み

## LED Editor

LED の色・パターンを編集します。

- 色: HSV / RGB
- パターン: 単色、点滅、グラデーション、Event 連動
- Event 発火時に LED もパルスさせる等の連動設定

## Connection

Manager との WebSocket 接続状態を表示。

- 緑: 接続中
- 灰: 未接続（Manager が起動していない or port 7703 が塞がっている）
- 接続中デバイスのリスト

## キーボードショートカット

詳細は [ショートカット一覧](/docs/studio/shortcuts/) を参照。

## データ永続化

すべてのデータはブラウザの **IndexedDB** に保存されます。

- Kit 設定、Library 参照
- 別のブラウザ / マシンに移行する場合は Library フォルダを共有 + Kit を JSON export / import

サーバーには何も保存されません。**完全クライアントサイド**です。
