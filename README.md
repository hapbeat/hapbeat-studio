# Hapbeat Studio

Hapbeat デバイスのための Web ベース統合デザインツールです。触覚コンテンツのデザイン、OLED ディスプレイレイアウトの編集、LED 設定、Pack ファイルのビルド・エクスポートを行います。

## 機能一覧

| 機能 | 説明 |
|------|------|
| 波形エディタ | WAV ファイルの読み込み・波形表示・触覚パターンのデザイン |
| ディスプレイエディタ | OLED (128x64) のブロック配置・ページ管理・ボタン設定 |
| LED 設定 | 待機色・パターン（常時点灯/呼吸/パルス）・イベント連動色 |
| Pack ビルド | イベント定義・クリップ割り当て・Pack ファイルのエクスポート |
| テンプレート | 標準・シンプル・詳細の定義済みレイアウト |
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
2. `hapbeat-helper start --foreground` で常駐起動（WebSocket サーバーが
   `localhost:7703` で動作）
3. Hapbeat Studio をブラウザで開く
4. ヘッダー右上の接続ステータスが「Helper 接続中」に変わることを確認

### 連携でできること

- 接続中のデバイス一覧の取得（mDNS + UDP broadcast）
- ディスプレイレイアウト・LED 設定のデバイスへの書き込み
- Kit ファイルのデバイスへのデプロイ
- イベントのリアルタイムプレビュー（PLAY / STOP）

Helper が起動していない場合でも、Studio の編集・エクスポート機能は全て利用可能です。

> Web Serial API 経由の USB 書き込みは Helper を介さず Studio から直接行います
> （Phase 3 で実装予定）。

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
- **JSZip** — Pack ファイルのアーカイブ

## ライセンス

Hapbeat 社内プロジェクト
