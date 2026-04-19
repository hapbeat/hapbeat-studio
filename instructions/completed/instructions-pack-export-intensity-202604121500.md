# Instructions: PackBuilder の gain → intensity 移行

**対象リポジトリ**: hapbeat-studio
**作成日**: 2026-04-12
**作成元**: hapbeat-contracts セッション（指示書 instructions-intensity-spec-202604111200 の適用に伴う波及）

## 背景

hapbeat-contracts で Pack manifest の parameters 仕様を変更した（コミット 5937349）:

- `gain` フィールドを削除し、`intensity` (number, 0.0–1.0, default 1.0) に置き換え
- `device_wiper` (integer, 0–127, optional) を新規追加
- 後方互換レイヤーは作らない（CLAUDE.md 方針）

Studio の Kit 系（KitManager, KitEventRow, library.ts の KitEvent 型）は既に `intensity` に移行済み。
しかし **PackBuilder** と **EventDefinition 型 (project.ts)** に旧 `gain` が残っている。

## 変更箇所

### 1. `src/types/project.ts` — EventDefinition 型

```typescript
// 変更前
export interface EventDefinition {
  eventId: string
  clipFile?: string
  gain: number
  loop: boolean
  ledColor?: string
}

// 変更後
export interface EventDefinition {
  eventId: string
  clipFile?: string
  intensity: number
  device_wiper?: number
  loop: boolean
  ledColor?: string
}
```

### 2. `src/components/pack/PackBuilder.tsx`

EventDefinition の `gain` 参照をすべて `intensity` に変更:

- L18: `gain: newGain` → `intensity: newGain`
- L89: ヘッダーラベル `ゲイン` → `Intensity`（または `強度`）
- L97: `event.gain.toFixed(1)` → `event.intensity.toFixed(1)`
- `newGain` 状態変数名は `newIntensity` にリネームしても良い（任意）

### 3. Pack export 時の manifest 生成

PackBuilder（または Pack export を担うコード）が manifest JSON を生成する箇所で、`gain` ではなく `intensity` / `device_wiper` を出力するよう修正。

## 変更しないもの

以下は別概念の gain なので変更不要:

- `src/types/waveform.ts` の `GainParams`, `gainDb` — 音声 DSP エフェクト（dB ゲイン）
- `src/types/waveform.ts` の `EqBand.gain` — イコライザバンドの dB ゲイン
- `src/types/display.ts` の `'gain'` — ディスプレイレイアウト要素（デバイス音量表示）
- `src/utils/audioDsp.ts` の `applyGain` 等 — 波形処理の DSP ゲイン
- `src/components/waveform/EffectParamEditor.tsx` — 波形エフェクト UI
- `src/components/common/ElementPalette.tsx` の `'gain'` — ディスプレイ要素パレット

## テスト

- TypeScript ビルドエラーがないこと（`npm run build`）
- PackBuilder で新規イベント追加 → intensity 列が正しく表示されること
- Pack export で出力される manifest.json に `intensity` が入り、`gain` が入らないこと
