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
- **Helper 連携**: WebSocket（localhost:7703）経由で `hapbeat-helper` daemon と通信し、デバイスへの書き込みを実行（旧: hapbeat-manager。DEC-026 で deprecate）

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
- Manager（Desktop アプリ）の機能を Studio 側に実装しない（書き込み・転送は Helper 経由）

## 「Manager 機能を Studio に移植」する際のルール

「Manager 機能を移植」と依頼されたら、**Manager の現行実装 (git HEAD) に存在する機能を全て洗い出してから着手する**。

- ❌ 悪い例: Manager の `widgets/config_page.py` を読んで「設定タブはこういうものだ」と Studio 側を一から書き直す → 結果として Wi-Fi profiles 一覧やデバッグダンプなど、Manager 側で実装済みの機能が抜け落ちる
- ✅ 良い例:
  1. `widgets/__init__.py` と `main_window.py` から **タブ構成と全 page クラス** を確認
  2. 各 page の **public method / Signal を全列挙** (`apply_*`, `update_*`, `flash_*`, `show_*` 等)
  3. 各メソッドが「Studio から WS で同等の操作ができるか」をチェックリスト化
  4. 漏れがあれば実装、欠けるなら理由を明記してユーザーに確認

「Manager にあって Studio に無い機能」が出たら、それは原則 **欠陥** として報告する。Live Audio のように明示的に外す合意があるものだけ例外。

参照は **git HEAD の実コード** が正。`docs/`, `knowledge/`, `instructions/applied/` などは過去の判断ログで、現在の実装と乖離している可能性がある。

## 依存

- hapbeat-contracts: display-layout.schema.json, pack-manifest.schema.json, event-id 仕様
- hapbeat-helper: WebSocket リレー（localhost:7703）。`pipx install hapbeat-helper` で常駐。詳細は `../hapbeat-helper/README.md`

## 指示書

- `instructions/` — 他セッションからの未実行の指示書
- `instructions/completed/` — 完了済みの指示書
- セッション開始時に `instructions/` を確認し、該当する指示書があれば適用する

## エージェント共通メモリ（Claude / OpenAI 系共通）

- セッション間で引き継ぐ知見・ログ・ルールはワークスペースルートの `docs/agent-memory/` に保存する
- インデックスは `docs/agent-memory/INDEX.md`
- この repo から参照する場合の相対パスは `../docs/agent-memory/`
- メモリを新規作成・更新した場合は、必ず `INDEX.md` も更新する
