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
| Manager 連携 | WebSocket 経由でデバイスへの書き込み・プレビュー |

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

## Hapbeat Manager との連携

Hapbeat Studio は [Hapbeat Manager](../hapbeat-manager/) と WebSocket で連携します。

### 接続方法

1. Hapbeat Manager を起動する（WebSocket サーバーが `localhost:7703` で自動起動）
2. Hapbeat Studio をブラウザで開く
3. ヘッダー右上の接続ステータスが「Manager 接続中」に変わることを確認

### 連携でできること

- 接続中のデバイス一覧の取得
- ディスプレイレイアウトのデバイスへの書き込み
- LED 設定のデバイスへの書き込み
- Pack ファイルのデバイスへのデプロイ
- イベントのリアルタイムプレビュー

Manager が起動していない場合でも、Studio の編集・エクスポート機能は全て利用可能です。

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
