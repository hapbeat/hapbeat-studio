# CLAUDE.md — hapbeat-studio

## このリポジトリの責務

Hapbeat Studio — Web ベースの統合デザインツール。

- 波形エディタ（触覚コンテンツのデザイン）
- Kit ビルド・エクスポート
- ディスプレイレイアウトエディタ（OLED 表示のブロック配置・ページ管理）
- LED 設定（色、パターン、イベント連動）
- デバイス管理（接続・設定・ファームウェア書込み）
- テンプレート管理

## 技術スタック

- React 18 + TypeScript
- Vite（ビルド）
- Zustand（状態管理）
- react-grid-layout（ドラッグ＆ドロップ）
- WaveSurfer.js（波形表示）
- idb（IndexedDB）
- JSZip（Kit エクスポート）

## 設計方針

- **完全クライアントサイド**: バックエンドなし、認証なし
- **静的ホスティング**: Xserver / GitHub Pages / Netlify 等で配信
- **ローカルデータ保持**: ユーザーのプロジェクトはブラウザの IndexedDB に保存
- **ファイル入出力**: JSON エクスポート/インポートでプロジェクト共有
- **Helper 連携**: WebSocket（localhost:7703）経由で `hapbeat-helper` daemon と通信し、デバイスへの書き込みを実行

## ディレクトリ構造

- `src/components/` — React コンポーネント（waveform, display, led, kit, common）
- `src/hooks/` — カスタムフック
- `src/stores/` — Zustand ストア
- `src/types/` — TypeScript 型定義
- `src/utils/` — ユーティリティ（storage, templates）

## やってはいけないこと

- バックエンド API を作らない（全てクライアントサイド）
- ユーザー認証を入れない
- hapbeat-contracts の仕様に反するデータ形式を独自に定義しない
- Kit フォーマットを独自に拡張しない（contracts に従う）
- デバイスへの書き込み・転送を Helper を介さずに行わない

## 依存

- hapbeat-contracts: display-layout.schema.json, kit-manifest.schema.json, event-id 仕様
- hapbeat-helper: WebSocket リレー（localhost:7703）。`pipx install hapbeat-helper` で常駐。詳細は `../hapbeat-helper/README.md`
