---
title: 最初の Kit を作る
description: Hapbeat Studio を初めて開いてから、最初の Kit をデバイスに転送するまで。
---

Hapbeat Studio はブラウザ完全クライアントサイドで動作する触覚コンテンツのデザインツールです。波形・LED・ディスプレイレイアウトの編集と Kit ビルドを行います。

**起動 URL**: [https://devtools.hapbeat.com/studio/](https://devtools.hapbeat.com/studio/)

## 前提

- 推奨ブラウザ: Chrome / Edge（Web Audio API + WebSocket + IndexedDB を使うため）
- [Hapbeat Manager](/docs/manager/) がインストール・起動されていること（Kit を実機に転送する場合）
- ファームウェアが書き込まれた Hapbeat デバイスが Wi-Fi 接続されていること

## 1. Library フォルダを開く

初回起動時に「Library フォルダを選択してください」と表示されます。これは波形素材（WAV ファイル）の置き場です。任意のフォルダを選択してください。File System Access API を使うため Chrome / Edge 推奨です。

サンプル素材が欲しい場合は、空フォルダを選んでから後でドラッグ＆ドロップで WAV を追加できます。

## 2. Kit を新規作成

左パネルの「+ New Kit」をクリックして Kit に名前を付けます（例: `tutorial-kit`）。

## 3. Event を追加

Kit 画面で「+ Event」を押し、Event ID を入力します（例: `gunshot`）。

## 4. Mode を選択

Event の mode 列で再生方式を選びます。

| Mode | 表示 | 用途 |
|------|------|-----|
| **FIRE** (command) | ▶ | 短い one-shot。command を送信、デバイス側で Kit 内クリップを再生 |
| **CLIP** (stream_clip) | ♪ | やや長めのクリップ。Manager が PCM をストリーミング配信 |
| **LIVE** (stream_source) | ~ | リアルタイム音源（マイク入力等）を直接ストリーミング |

最初は **FIRE** から始めるのが簡単です。

## 5. クリップを割り当て

Library から WAV をドラッグ、または Event 行の「Edit」を押してクリップを選択します。

- WAV はビルド時に **16 kHz PCM16 mono** に自動正規化されます
- 元ファイルは Library 側のみで保持、Kit 内には正規化版が入る

## 6. 強度（Intensity）を調整

各 Event 行の Intensity スライダーで再生強度（0-128 = 0-100%）を設定します。

## 7. キーボードで試聴

行を選択して `Space` で再生、`↑/↓/←/→` で移動できます。プレビュー中はブラウザ音声で確認できます。

## 8. Save & Deploy

右上の **Save & Deploy** ボタンを押すと、

1. Kit が IndexedDB に保存
2. WebSocket 経由で Manager に Deploy 要求
3. Manager が選択中デバイスに転送

完了すると Manager の Kit タブで一覧に出てきます。

## 9. 実機で Event を発火

Manager の Test タブから Event ID を選んで再生、または Unity SDK 等の SDK から Event を送信してデバイスから振動を確認します。

## 次のステップ

- [画面構成](/docs/studio/ui-overview/) — 各パネルの役割
- [Mode の使い分け](/docs/studio/modes/) — FIRE / CLIP / LIVE をいつ使うか
- [キーボードショートカット](/docs/studio/shortcuts/)
