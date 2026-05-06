# Applied: kit-manifest から `kit_id` を削除して `name` に一本化 (DEC-028)

**日付:** 2026-04-28
**起点セッション:** workspace (helper + studio セッション)
**対象 repo:** hapbeat-studio
**関連 DEC:** DEC-028
**ステータス:** ✅ 適用済み — レビューしてください

## この repo に入った変更

- `src/utils/kitExporter.ts`
  - manifest 出力から `kit_id: packId,` 行を削除
  - `name` の値を `kit.name` から `packId` に変更（Studio 内で kit.name = packId が成立しているので実質変化なし、明示化）
- `src/stores/libraryStore.ts`
  - `importKitsFromOutputDir` の manifest 型定義から `kit_id` を除外（既に値は参照していなかった）
  - `validateKitName` を `^[a-z][a-z0-9-]*$`（contracts kit_id pattern と完全一致）に厳格化
- `src/components/kit/KitManager.tsx`
  - kit name 入力 sanitize の正規表現から `_` を除外
  - 先頭は英小文字のみとなるように `^[^a-z]+` を strip
  - エラー / hint メッセージ・`pattern` 属性・title fallback を新ルールに合わせて更新

## 変更の背景

`manifest.kit_id` と `manifest.name` が実用上常に同じ値（=ディレクトリ名）を保持しており冗長だった。Studio 側で `Basic Exam Kit` のような Title-Case 整形バグが発生した遠因も「2 フィールドあって drift しうる」設計にあった。1 フィールドに統合し、命名は contracts kit_id pattern に揃えた。詳細は `docs/decision-log.md` の DEC-028 参照。

`kit_id` という名前は wire-protocol レベル（kit-install-protocol、bridge-api、deploy_kit_data WS payload 等）では引き続き存在する。値はディレクトリ名から導出される。

## 横断的に同セッションで入った関連変更

- **contracts:**
  - `schemas/kit-manifest.schema.json`: `kit_id` プロパティ削除、`required` 更新、`name` に `^[a-z][a-z0-9-]*$` pattern 追加
  - `specs/kit-format.md`: フィールド表 / セクション 4 (Kit ID → Kit name) / manifest 例
  - `fixtures/sample-kit-manifest.json`: `kit_id` 行削除、name を `basic-impacts` に統一
- 追従指示書 (他 repo 用): `hapbeat-contracts/instructions/instructions-drop-kit_id-from-manifest-202604280515.md`

## 検証状況

- typecheck pass (npx tsc --noEmit)
- 開発サーバ上で `validateKitName` が `_` / 大文字 / 数字先頭を reject することを確認
- exportKitAsPack の出力 manifest に `kit_id` キーが存在しないことを確認

## この repo のエージェントへのアクション

1. 上記 3 ファイルの diff を確認
2. 既存のローカル kit が再起動後も同じ name (= ディレクトリ名) で復元されることを確認
3. 問題なければ本ファイルを `instructions/completed/` に移動
