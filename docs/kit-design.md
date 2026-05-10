---
title: Kit デザインガイド
description: Hapbeat Studio で Kit を設計する方法と、manifest の gain が SDK 全体の基準強度になる仕組み。
---

Hapbeat の触覚コンテンツは **Kit** という単位でまとめられます。Kit は触覚クリップ（WAV）と設定をまとめた `manifest.json` で構成されており、Studio で設計してデバイスにデプロイします。

## Kit の構成

```
my-kit/
  manifest.json          ← イベント定義・基準 gain
  install-clips/         ← Fire (Command) モード用 WAV
  stream-clips/          ← Clip (Stream) モード用 WAV
```

## manifest の gain が「基準強度」になる

Kit をデザインする際の重要な概念として、**manifest に記録した gain が振動強度の基準（= 1.0 倍）** になります。

```
デバイスの実際の振動強度 = manifest の intensity × EventMap の gain × SDK の gain
```

### なぜこの構造か

- **アーティスト（Kit 設計者）** が Studio で適切な振動強度を決めて manifest に書く
- **開発者（SDK 利用者）** は EventMap や コード上の gain で、そこからの相対的な強弱だけを指定する
- `gain = 1.0` は「Kit 設計者が決めた標準の強さ」を意味し、`0.5` なら半分、`2.0` なら 2 倍になる
- Kit 側の調整と実装側の調整が独立しているため、どちらかを変更しても影響範囲が明確

### 具体例

Studio で `intensity: 0.8` に設定した Kit をデプロイしたとき:

| EventMap の gain | 実際の強度 |
|---|---|
| 1.0（デフォルト） | 0.8 |
| 0.5 | 0.4 |
| 1.25 | 1.0（最大付近） |

## Studio での Kit 設計手順

### 1. ワーキングディレクトリを開く

Studio → **Kit タブ** → フォルダ選択で、Kit ファイルを置くディレクトリを指定します。Unity プロジェクトの場合は `Assets/HapbeatSDK/Kits/` を推奨。

### 2. 新規 Kit を作成する

Kit 一覧の **+ New Kit** → Kit 名を入力（例: `my-game-kit`）。Kit 名は Event ID の prefix になります（`my-game-kit.footstep` など）。

### 3. クリップを追加する

Kit を選択 → **+ Add Clip** で WAV ファイルを追加。クリップ名が Event ID の suffix になります。

クリップごとに以下を設定します:

| 設定 | 説明 |
|---|---|
| **intensity** | 基準振動強度（0.0〜1.0）。SDK 側 gain の基準値 |
| **mode** | `command`（Fire 用）/ `stream_clip`（Clip 用） |

### 4. デバイスにデプロイする

**Manage タブ** → デバイスを選択 → **Kit サブタブ** → **Deploy**。

Fire (Command) モードは `install-clips/` の WAV がデバイスに転送されます。Clip (Stream) モードの WAV はデプロイ不要です。

## intensity の決め方

- 実際にデバイスを装着してデプロイ後に Test Play で確認しながら調整する
- 全イベントを同じ intensity にしておき、SDK 側 gain で相対調整するのがシンプル
- 衝撃音など「最大付近で鳴らしたい」クリップは `0.8〜1.0`、環境音などは `0.3〜0.5` が目安

## 関連

- [Fire と Clip の比較](/docs/unity-sdk/fire-vs-clip/) — モード選択の考え方
- [Kit フォーマット仕様](https://github.com/Hapbeat/hapbeat-contracts/blob/master/specs/kit-format.md) — manifest.json の完全なスキーマ定義
