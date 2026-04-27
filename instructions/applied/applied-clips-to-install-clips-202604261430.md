# Applied: clips/ → install-clips/ rename (DEC-027)

**日付:** 2026-04-26
**起点セッション:** workspace (本 repo を起点に issue 単位の横断編集)
**対象 repo:** hapbeat-studio
**関連 DEC:** [DEC-027](../../../docs/decision-log.md)
**ステータス:** ✅ 適用済み — レビューしてください

## この repo に入った変更

- `src/utils/kitExporter.ts`
  - 全てのコメント / docstring の `clips/` → `install-clips/` 表記
  - ZIP 配置: `root.file(\`clips/${fname}\`, packBlob)` → `root.file(\`install-clips/${fname}\`, packBlob)`
  - manifest 出力 dict key: `clips: clipsMeta` → `install_clips: clipsMeta`
- `src/utils/localDirectory.ts`
  - `scanKitOutputFolder` の subfolder 探索: `['clips', 'stream-clips']` → `['install-clips', 'stream-clips']`
  - `writeKitFolder` のコメント (`"clips/gunshot.wav"` → `"install-clips/gunshot.wav"`)
- `src/stores/libraryStore.ts`
  - kit import 時の clip lookup key: `\`clips/${ev.clip}\`` → `\`install-clips/${ev.clip}\``

ライブラリの workdir 配下にある `clips/` ディレクトリ (ユーザーが import した source clip の格納先) は **rename 対象外** — これは Kit 出力の `install-clips/` とは別概念。`ClipEditModal.tsx`、`localDirectory.ts` の library 系ヘルパー、`stores/libraryStore.ts` の archive UI 等は変更していない。

## 変更の背景

ユーザーから「kit の clips/ がデバイスに焼かれる WAV だと名前から伝わらない」というフィードバック。`stream-clips/` との対比軸 (install / stream) で `install-clips/` に rename。manifest dict key も `install_clips` に揃えた。詳細は workspace `docs/decision-log.md` の DEC-027 参照。

`event.clip` の値は引き続き bare filename (command mode) のまま。

## 横断的に同セッションで入った関連変更

- **contracts**: schema / spec / fixture
- **kit-tools**: builder / validator / installer / cli / tests
- **device-firmware**: TCP / kit_installer / kit_loader の `"install-clips/"` プレフィックス判定
- **manager**: `pack_normalize.py` の探索パスと dict key
- **unity-sdk**: cosmetic のみ + readme template version bump

## 検証状況

- `npx tsc --noEmit` 通過 (Studio 全体の TS 型チェック OK)
- preview verification は本セッション末で実施予定 (browser で kit save → ZIP の中身確認)

## この repo のエージェントへのアクション

1. 上記 3 ファイルの diff を確認
2. 既存の kit を Save し、ZIP に展開して `install-clips/*.wav` が配置されること、`manifest.json` の `install_clips` dict が出力されることを browser で確認
3. Auto-import (kit dir 再選択時) が `install-clips/` を見つけて再構築できることを確認
4. 問題なければ本ファイルを `instructions/completed/` に移動
