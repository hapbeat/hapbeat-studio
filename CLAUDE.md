# CLAUDE.md — hapbeat-studio

## このリポジトリの責務

Hapbeat Studio — Web ベースの統合デザインツール。

- 波形エディタ（触覚コンテンツのデザイン）
- ディスプレイレイアウトエディタ（OLED 表示のブロック配置・ページ管理）
- LED 設定（色、パターン、イベント連動）
- Pack ビルド・エクスポート
- テンプレート管理

## 技術スタック

- React 18 + TypeScript
- Vite（ビルド）
- Zustand（状態管理）
- react-grid-layout（ドラッグ＆ドロップ）
- WaveSurfer.js（波形表示）
- idb（IndexedDB）
- JSZip（Pack エクスポート）

## 設計方針

- **完全クライアントサイド**: バックエンドなし、認証なし
- **静的ホスティング**: Xserver / GitHub Pages / Netlify 等で配信
- **ローカルデータ保持**: ユーザーのプロジェクトはブラウザの IndexedDB に保存
- **ファイル入出力**: JSON エクスポート/インポートでプロジェクト共有
- **Manager 連携**: WebSocket（localhost:7703）経由で Hapbeat Manager と通信し、デバイスへの書き込みを実行

## ディレクトリ構造

- `src/components/` — React コンポーネント（waveform, display, led, pack, common）
- `src/hooks/` — カスタムフック（Manager 接続等）
- `src/stores/` — Zustand ストア
- `src/types/` — TypeScript 型定義
- `src/utils/` — ユーティリティ（storage, templates）

## やってはいけないこと

- バックエンド API を作らない（全てクライアントサイド）
- ユーザー認証を入れない
- hapbeat-contracts の仕様に反するデータ形式を独自に定義しない
- Pack フォーマットを独自に拡張しない（contracts に従う）
- Manager（Desktop アプリ）の機能を Studio 側に実装しない（書き込み・転送は Manager 経由）

## 依存

- hapbeat-contracts: display-layout.schema.json, pack-manifest.schema.json, event-id 仕様
- hapbeat-manager: WebSocket リレー（localhost:7703）でデバイス書き込み

## 指示書

- `instructions/` — 他セッションからの未実行の指示書
- `instructions/completed/` — 完了済みの指示書
- セッション開始時に `instructions/` を確認し、該当する指示書があれば適用する

