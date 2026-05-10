# Hapbeat Studio

Hapbeat デバイスのための Web ベース統合デザインツールです。触覚コンテンツのデザイン、OLED ディスプレイレイアウトの編集、LED 設定、Kit ファイルのビルド・デプロイを行います。

## 機能一覧

| 機能 | 説明 |
|------|------|
| Kit エディタ | WAV ファイルの読み込み・Event 定義・Kit のビルド・デバイスへのデプロイ |
| UI エディタ | OLED (128x64) のブロック配置・ページ管理・ボタン設定・LED カラー設定 |
| Manage タブ | デバイス検出・Wi-Fi 設定・ファームウェア OTA・Kit デプロイ管理 |
| 初期セットアップ | USB Serial 接続 → ファームウェア書き込み → Wi-Fi 設定のウィザード |
| プロジェクト管理 | IndexedDB への自動保存・JSON インポート/エクスポート |
| Helper 連携 | WebSocket 経由でデバイスへの書き込み・プレビュー（`hapbeat-helper` daemon が必要） |

## 開発環境セットアップ

### 前提条件

- Node.js 18 以上
- npm 9 以上

### インストール

```bash
cd hapbeat-studio
npm install
bash scripts/install-git-hooks.sh   # WAV メタデータ自動 strip 用 pre-commit フック
```

### 開発サーバー起動

```bash
npm run dev
```

ブラウザで http://localhost:5173 が自動的に開きます。

### リント

```bash
npm run lint
```

### テスト

```bash
npm test
```

## ビルド・デプロイ

### プロダクションビルド

```bash
npm run build
```

`dist/` ディレクトリに静的ファイルが生成されます。

### プレビュー

```bash
npm run preview
```

### デプロイ

`dist/` ディレクトリの内容を任意の静的ホスティングサービスに配置してください。

- **Xserver**: `dist/` 内のファイルを FTP でアップロード
- **GitHub Pages**: `gh-pages` ブランチに `dist/` の内容をプッシュ
- **Netlify**: リポジトリを接続し、ビルドコマンドに `npm run build`、公開ディレクトリに `dist` を指定

バックエンドは不要です。全ての処理はブラウザ上で完結します。

## hapbeat-helper との連携

Hapbeat Studio は [`hapbeat-helper`](../hapbeat-helper/) (Python CLI daemon) と
WebSocket で連携します。Helper はブラウザができない処理（mDNS browse / UDP
broadcast / TCP raw socket）を中継するローカルデーモンで、`pipx` 経由で
Mac / Win / Linux にインストールできます。

> 旧 PySide6 デスクトップアプリ `hapbeat-manager` は DEC-026 で deprecated。
> Studio + Helper の構成に移行中です。

### 接続方法

1. `pipx install hapbeat-helper`（初回のみ）
2. `hapbeat-helper install-service` で自動起動を登録（推奨）、または `hapbeat-helper start` で手動起動
3. Hapbeat Studio をブラウザで開く
4. ヘッダー右上の接続ステータスが「Helper 接続中」に変わることを確認

### 連携でできること

- 接続中のデバイス一覧の取得（mDNS + UDP broadcast）
- ディスプレイレイアウト・LED 設定のデバイスへの書き込み
- Kit ファイルのデバイスへのデプロイ
- イベントのリアルタイムプレビュー（PLAY / STOP）

Helper が起動していない場合でも、Studio の編集・エクスポート機能は全て利用可能です。

> Web Serial API 経由の USB 書き込みは Helper を介さず Studio から直接行います（Manage タブ内 Firmware サブタブ）。

### ブラウザ別の注意

- Chrome / Edge: HTTPS Studio から `ws://localhost:7703` への接続を許可
- Firefox: `network.websocket.allowInsecureFromHTTPS = true` を `about:config` で有効化が必要

## 技術スタック

- **React 18** + **TypeScript** — UI フレームワーク
- **Vite** — ビルドツール
- **Zustand** — 状態管理
- **react-grid-layout** — ドラッグ＆ドロップによるレイアウト編集
- **WaveSurfer.js** — 波形表示
- **idb** — IndexedDB ラッパー
- **JSZip** — Kit ファイルのアーカイブ

## サウンド素材クレジット

本プロジェクトのライブラリやテンプレートに同梱されているサウンドファイルには、以下のフリー効果音サイトの素材を触覚信号生成用に加工して使用しているものが含まれる場合があります（全てのファイルが下記由来というわけではありません）。

- 効果音ラボ — https://soundeffect-lab.info/
- 魔王魂 — https://maou.audio/
- 効果音辞典（小森平） — https://taira-komori.net/
- OtoLogic — https://otologic.jp/
- 音人 — https://on-jin.com/

各素材は触覚デバイス向けに編集（リサンプル・トリミング・ゲイン調整等）した上で再配布しています。配布前に作者・著作権関連のメタデータは除去しています。

なお、上記以外のサイト由来の素材が混入している可能性も完全には否定できません。出典が明確でないファイルについても、権利者・配布元からご連絡をいただければ整合を確認の上、削除・差し替え・クレジット追記など適宜対応いたします。Issue または GitHub の連絡先までお知らせください。

## ライセンス

Hapbeat 社内プロジェクト
