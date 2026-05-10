---
title: 最初の Kit を作る
description: Hapbeat Studio を初めて開いてから、最初の Kit をデバイスに転送するまで。
sidebar:
  order: 2
---

Hapbeat Studio はブラウザ完全クライアントサイドで動作する触覚コンテンツのデザインツールです。波形・UI（OLED/LED）・Kit ビルドを行います。

**起動**: [Hapbeat Studio を開く](https://devtools.hapbeat.com/studio/)

## 前提

- 推奨ブラウザ: Chrome / Edge（Web Audio API + WebSocket + IndexedDB を使うため）
- Kit をデバイスに転送する場合は `hapbeat-helper` がインストール・起動されていること（[初期セットアップ](/docs/studio/initial-setup/)）
- ファームウェアが書き込まれた Hapbeat デバイスが Wi-Fi 接続されていること

## 1. Library フォルダを開く

初回起動時に「Library フォルダを選択してください」と表示されます。これは波形素材（WAV ファイル）の置き場です。任意のフォルダを選択してください。File System Access API を使うため Chrome / Edge 推奨です。

サンプル素材が欲しい場合は、空フォルダを選んでから後でドラッグ＆ドロップで WAV を追加できます。

## 2. Kit を新規作成

Library パネル下部の「+ Kit」をクリックして Kit に名前を付けます（例: `tutorial-kit`）。

## 3. Event を追加

Kit 画面で「+ Event」を押し、Event ID を入力します（例: `tutorial-kit.gunshot`）。

> Event ID は `<kit-name>.<clip-name>` 形式が推奨です。

## 4. Mode を選択

Event の mode 列で再生方式を選びます。

| Mode | 表示 | 用途 |
|------|------|-----|
| **FIRE** (command) | ▶ | 短い one-shot。command を送信、デバイス側で Kit 内クリップを再生 |
| **CLIP** (stream_clip) | ♪ | やや長めのクリップ。Helper が PCM をストリーミング配信 |
| **LIVE** (stream_source) | ~ | リアルタイム音源（マイク入力等）を直接ストリーミング |

最初は **FIRE** から始めるのが簡単です。

## 5. クリップを割り当て

Library から WAV をドラッグして Event 行にドロップするか、Event 行の「Edit」を押してクリップを選択します。

- WAV はビルド時に **16 kHz PCM16 mono** に自動正規化されます
- 元ファイルは Library 側のみで保持、Kit 内には正規化版が入ります

## 6. 強度（Intensity）を調整

各 Event 行の Intensity スライダーで再生強度（0-100%）を設定します。

## 7. キーボードで試聴

Event 行を選択して `Space` で再生、`↑/↓` で行間移動、`←/→` で Intensity ±5% の調整ができます。プレビュー中はブラウザ音声で確認できます。

## 8. Deploy

Kit は編集内容が自動保存されます。

選択中デバイスへのデプロイは右上の **Deploy** ボタンを押します:

1. Helper 経由でデバイスへ転送
2. 完了すると Studio の Manage タブ → Kit 一覧に反映されます

## 9. 実機で Event を発火

Studio の Kit タブで Event 行の ▶ ボタンを押して再生、または Unity SDK 等の SDK から Event ID を送信してデバイスから振動を確認します。

## 次のステップ

- [画面構成](/docs/studio/ui-overview/) — 各パネルの役割
- [Mode の使い分け](/docs/studio/modes/) — FIRE / CLIP / LIVE をいつ使うか
- [キーボードショートカット](/docs/studio/shortcuts/)
