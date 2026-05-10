---
title: 画面構成
description: Studio の Kit / UI / Manage 各タブとパネル構成。
---

## 全体レイアウト

Studio は上部の 3 タブで機能が切り替わります。

| タブ | 副題 | 用途 |
|------|------|-----|
| **Kit** | Vibration Clips | Kit 一覧、Event 編集、Library、Deploy |
| **UI** | Display etc. | OLED 表示レイアウト・LED 設定・UI 設定 |
| **Manage** | Config | デバイス検出・Wi-Fi 設定・ファームウェア OTA・Kit デプロイ管理 |

ヘッダー右側には Helper 接続ステータス（緑: 接続中 / 灰: 未接続）と接続中デバイス数が表示されます。

---

## Kit タブ

Studio で最もよく使うタブです。左右 2 ペインに分かれています。

### Library パネル（左）

WAV / 触覚素材ファイルのツリー。Library フォルダから自動 import されます。

- **Built-in**: Studio に同梱の素材
- **My Clips**: ユーザー Library フォルダの素材
- 各クリップ行で個別の Amp（音量基準）プリセットを保存可能
- クリップをドラッグして Kit Event 行にドロップするか、`Enter` でアクティブ Kit に追加

### Kit パネル（右）

選択中の Kit に含まれる Event 一覧。

- 列: Event ID / Mode / Intensity / クリップ名 / Action
- 行クリックで選択、`Space` で再生
- **+ Event** で行追加、**Edit** で詳細モーダル
- Kit の保存は自動（600 ms debounce）。**Deploy** ボタンで接続中デバイスに転送

### モーダル編集

Edit ボタンまたは Event 名をクリックで開く詳細モーダル:

- クリップ選択
- 強度（intensity）と device_wiper（強度補正の左右バランス等）
- mode 切替（FIRE / CLIP / LIVE）

---

## UI タブ

### Display Editor（OLED レイアウト）

OLED (128×64) 表示のブロック配置エディタ。

- グリッド上にテキスト / アイコン / バッテリーゲージ等のブロックを配置
- 複数ページを定義し、ボタン操作でページ遷移
- ページ名のインライン rename 対応
- Deploy ボタンで選択中デバイスへ書き込み

### UI 設定（OLED 輝度 / Hold タイミング等）

OLED 輝度・Hold フィードバックのタイミング・Hold 予告 LED 設定などをデバイスごとに変更できます。

### LED 設定

LED の待機色・パターン・接続状態連動色を編集します。

---

## Manage タブ

デバイス管理の中枢。左サイドバーでデバイスを選択すると右ペインに詳細が表示されます。

### サイドバー（デバイス一覧）

mDNS + UDP broadcast で検出したデバイスが自動表示されます。

- Refresh ボタン（Helper rescan）で即時再検出
- 接続中アプリ名（app_name）を pill で表示

### 設定サブタブ

選択デバイスの Wi-Fi プロファイル管理・デバイス識別（名前 / グループ）・UI 設定を行います。

### Kit サブタブ

デバイスにインストール済みの Kit 一覧、イベント発火テスト（FIRE ▶ / CLIP ♪）。

### Firmware サブタブ

ファームウェア書き込みと OTA 更新。

- **USB Serial**: Necklace / Band の種別を選んで書き込み（初期セットアップ / ダウングレード用）
- **OTA**: Helper 経由で Wi-Fi を通して最新版に更新
- GitHub Releases から最新ファームを自動取得（prod 環境）
- 複数デバイス選択時は順次 OTA

### Streaming Test サブタブ

WAV / Live Audio（システム音、マイク）のストリーミングテスト。

---

## データ永続化

すべてのデータはブラウザの **IndexedDB** に保存されます。

- Kit 設定、Library 参照
- 別ブラウザ / 別マシンへの移行は Library フォルダを共有 + Kit の JSON export / import で対応

サーバーには何も保存されません。**完全クライアントサイド**です。

## キーボードショートカット

詳細は [ショートカット一覧](/docs/studio/shortcuts/) を参照。
