---
title: Mode の使い分け（FIRE / CLIP）
description: Hapbeat の触覚再生 2 モード (command / stream_clip) の違いと選び方。
---

Studio では各 Event に 2 つの再生 mode があります。用途に応じて選択してください。

## 一覧

| Mode | 内部名 | 表示 | 配置先 | 適性 |
|------|-------|------|--------|------|
| **FIRE** | command | ▶ | デバイスローカル（Kit 内に WAV 同梱） | 短い one-shot 効果音、最低遅延 |
| **CLIP** | stream_clip | ♪ | Helper が PCM ストリーミング | 長めの効果音、動的に gain / pan 制御 |

## FIRE（推奨デフォルト）

**Kit に WAV を同梱**し、デバイス側でローカル再生します。

- **遅延**: 数 ms。SDK の Event 送信からほぼ即時
- **長さ**: 数百 ms 〜 数秒（Kit パーティション容量との相談）
- **動的制御**: 強度（intensity）のみ
- **典型用途**: 銃撃音、爆発、衝撃、ボタンプレス感

ゲームやアプリで頻繁に発火する短い触覚はすべて FIRE で構わない。

## CLIP（長めの素材 + 動的パラメータ）

**Helper が PCM (16 kHz, MTU ≤ 1024 B chunk) をストリーミング**します。

- **遅延**: 数十 ms（chunk 単位の buffering + 送信）
- **長さ**: 任意（数十秒、ループ可）
- **動的制御**: 強度・gain・pan を再生中に変更可能
- **典型用途**: BGM 的な持続触覚、長めの環境振動、Unity ParameterBinding と組み合わせた距離減衰など

CLIP は hapbeat-helper と Wi-Fi が必要です。Helper が起動していないと再生できません。

## どれを選ぶか — 判断フロー

```
触覚は短い (< 数秒) ?
├─ Yes → FIRE（一番シンプル、デバイス自走）
└─ No  → CLIP（長尺ループ・動的 gain）
```

## 制約と注意

- **CLIP は Wi-Fi 経由のストリーミング**なので、ネットワーク不安定時は途切れる
- **FIRE は Kit パーティション容量** が制約（数 MB）。長尺は分割するか CLIP に変える
- **WAV は 16 kHz PCM16 mono に正規化**される（FIRE / CLIP 共通、ビルド時自動）
- ステレオ素材は L/R をミックスダウンして mono に
