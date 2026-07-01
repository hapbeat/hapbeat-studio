# Changelog

Hapbeat Studio の変更履歴。形式は [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/)、
バージョンは [Semantic Versioning](https://semver.org/lang/ja/)（conventional-commits: `feat`→minor / `fix`→patch）に従う。

- **最新版** `https://studio.hapbeat.com/` は master の package.json バージョンを表示。
- **凍結版** `https://studio.hapbeat.com/vX.Y/` は `vX.Y.Z` タグ push 時に作成（マイナー単位）。

## [0.4.0] - 2026-07-01

### Added（追加）
- USB serial カードの選択を Wi-Fi カードと統一（単クリック=このデバイスだけ選択 / Ctrl+クリック=追加選択 / Shift+クリック=範囲選択）
- USB serial セクションに「全選択 / 全解除」ボタン（5〜10 台の一斉並列書き込み向け）
- USB serial カードに「接続」ボタン（設定接続を選択とは別操作に分離）

### Fixed（修正）
- カード選択時のレイアウトシフトを解消（Wi-Fi・USB 両方 — 選択表示は border 色のみで箱サイズ不変）
- ファームウェアライブラリのラベルを製品名に統一（Necklace → DuoWL / Band → BandWL）
- dev（ローカル）ファームウェアライブラリが repos-* 再編後の実ビルドを読めるようパス修正（凍結スナップショットの古い版を配信していた問題を解消。表示は各ビルドの実 fwVersion）

## [0.3.1] - 2026-06-29

### Fixed（修正）
- ファームウェアのバージョン一覧で旧版が `vv0.1.1` と「v」が二重表示される不具合（manifest の `fwVersion` を先頭 `v` なしの正準形に統一 + 表示側でも正規化）
- バージョンの日付表示を、ファイルの更新日時（≒デプロイ時刻）から**リリースタグの公開日**に変更（CI が GitHub Release の `publishedAt` を manifest に取り込み）
- アーカイブ版を選択した時にリリース日以下の行が1行ずれる不具合（選択状態の説明行を常時1行表示にして高さを固定。最新選択時は「最新版を選択中。」を表示）

## [0.3.0] - 2026-06-26

### Added（追加）
- デバイスを見失った時用の「検出層 再初期化」ボタン（helper）
- インストール済み Kit のイベント再生を選択デバイス(IP)に限定（devices）

### Fixed（修正）
- クリップ/イベント再生を選択デバイスに限定
- 設定名の変更後に入力欄が旧名へ戻る不具合
- 再生/停止コマンドのトーストを「コマンドを送信しました」に統一
- `preview_event` の targets から serial 疑似デバイスを除外
- バージョンタブの「（現在）」表記を削除

## [0.2.1] - 2026-06-21

### Added（追加）
- 凍結リリースをマイナー単位ディレクトリ化 + バージョンバッジ
- clip import 中の進捗バナー（Loading… X/Y + バー）
- sine-tones テンプレート + showcase-kit 更新
- バージョン切替をヘッダのプルダウンに昇格

### Fixed（修正）
- clips を disk-as-truth 化（フォルダ接続時はディスクから再生 / phantom kit 抑制）
- 未検証の MQTT アラート variant を非表示（band_v3/v4/necklace）

## [0.2.0] - 2026-06-16

### Added（追加）
- バージョン管理 + アプリ内ロールバック切替
- マルチトピック送信・ack-hold・Hapbeat グルーピング・flow チャート・OTA
- センサーマッピングの JSON import/export・OLED 改行・readout 整備
- デバイスカードに Wi-Fi OTA 進捗バー・各種 OLED 表示要素（mqtt_status / ALERT_LIMIT_MODE 等）
- config フォームの anchored toast フィードバック

## [0.1.0] - 2026-06-16

- 初版リリース
