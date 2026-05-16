# Manifest ファイル名規約変更: `manifest.json` → `<kitname>-manifest.json`

**作成日:** 2026-05-16
**起票元:** hapbeat-unity-sdk セッション (SDK 側で先行実装済み)
**優先度:** 中 — 複数 Kit を 1 プロジェクトで扱う際の視認性向上 + 一覧画面での識別性

## 背景

複数の Kit が `Assets/HapbeatSDK/Kits/` 配下に並ぶと、Kit フォルダ内の `manifest.json` がどの Kit のものか一目で判別できない問題があった。Unity SDK 側 (HapbeatEventMapWindow の manifest セレクタ) で manifest を選ぶときも、ファイル名が全部 `manifest.json` だと選びにくい。

そこで、Kit 内の manifest ファイルを **`<kit-name>-manifest.json`** (例: `tutorial-kit-manifest.json`, `basic-exam-kit-manifest.json`) に統一する。

## 命名規約

- ファイル名: `<kit-name>-manifest.json`
  - `<kit-name>` は manifest.json の `name` フィールド (= Kit フォルダ名と同一にする慣例) と一致させる
  - 例: Kit 名が `my-effect-kit` → ファイル名は `my-effect-kit-manifest.json`
- 配置: 従来通り `<kit-folder>/<kit-name>-manifest.json` (kit フォルダ直下)
- 内容: スキーマ変更なし (`manifest.json` の中身フォーマットはそのまま)

### Discovery / Search

- ファイル探索は `*-manifest.json` パターンマッチで行う (preferred: `<kitname>-manifest.json` の exact match → fallback: any `*manifest*.json`)
- UI 側の picker / search box は **"manifest" partial-match** で絞り込む
- ファイル選択 UI で扱う file type は **`.json` only** (TextAsset 全般ではなく)

## SDK 側 (hapbeat-unity-sdk) の対応 (済)

参考実装としてすでに完了:

- `Samples~/{Tutorial,BasicExample}/Kit/manifest.json` をそれぞれ `<kit-name>-manifest.json` にリネーム
- `HapbeatManifestIntensity.FindKitManifest`: `<kitname>-manifest.json` exact match → `*manifest*.json` fallback の 2 段階探索
- `HapbeatEventMapAutoIntensityRefresher.IsManifestPath`: ファイル名が "manifest" を含み、拡張子が `.json` であるものを manifest として認識
- `HapbeatEventMapWindow.DrawManifestPickerField`: custom ObjectField
  - Drag-drop は `.json` のみ受け付け (他の TextAsset は warning + reject)
  - Click 時に `EditorGUIUtility.ShowObjectPicker<TextAsset>(current, false, "manifest", id)` を呼び出して "manifest" 検索プリセットで picker を開く
  - ピッカー結果も `.json` 拡張子を validate
- `HapbeatEventEntry.manifestOverride` (`TextAsset`) で per-entry override 可

## Studio 側でやってほしいこと

### 1. Kit serialization

- Kit を新規保存 / deploy する際、manifest ファイル名を **`<kit-name>-manifest.json`** で出力する
- 既存 Kit を読み込んで保存し直す場合、旧 `manifest.json` ファイルがあれば新名にリネームして書き出す (リネーム後の旧ファイルは削除)
- 後方互換 (旧 `manifest.json` を残す等) は不要 — プロジェクトはリリース前なので一括移行する

### 2. Kit reader

- 既存 Kit を Studio で開く際、`<kit-folder>/<kit-name>-manifest.json` を優先して探す
- 見つからなければ `<kit-folder>/*manifest*.json` のいずれかを fallback として使う (SDK と同一ロジック)
- 両方無ければ "no manifest" エラー

### 3. UI (Studio Web 側)

- Kit 一覧 / picker / search で manifest を扱う UI がある場合:
  - ファイルピッカーは **`.json` 拡張子のみ** にフィルタ
  - 検索は **"manifest" partial match を優先表示** (例: 検索ボックスに何も入力しなくても `*manifest*.json` を上位に出す、または検索プレースホルダーを `"manifest"` にして即マッチさせる)

### 4. Helper との連携

- Helper が Kit を deploy する際の manifest 探索 (TCP install パケット組み立て時等) も同じ規約で動くようにする
- 仕様だけ書いておけば Helper 側も対応可能 (Helper repo に別途指示書が必要なら起票)

## 影響範囲

| repo | 必要な変更 |
|---|---|
| **hapbeat-studio (本指示書)** | Kit writer / reader / UI |
| **hapbeat-helper** | Kit deploy 時の manifest 探索 (要別 instructions if 動かない) |
| **hapbeat-contracts** | Kit packaging spec の manifest filename を更新 |
| **hapbeat-pack-tools** | Kit ビルド時の manifest 出力ファイル名 |
| **hapbeat-unity-sdk** | ✅ 完了 (本指示書 起票元) |
| **hapbeat-device-firmware** | 影響なし (manifest はデバイス側で読まない、Studio がパース → wire 上は intensity 適用済みの gain) |

## 完了条件

- [ ] Studio で新規 Kit を save → `<kit-folder>/<kit-name>-manifest.json` が出力される
- [ ] Studio で既存 Kit (古い `manifest.json` を含む) を開く → 自動でリネーム + 旧ファイル削除
- [ ] Studio UI の manifest 関連ピッカー (もしあれば) で .json filter + "manifest" 検索優先表示
- [ ] Unity SDK の `Samples~/{Tutorial,BasicExample}/Kit/<kit-name>-manifest.json` が Studio で正常に開ける
- [ ] Studio repo に applied note (`instructions/applied/applied-kitname-manifest-rename-<timestamp>.md`) を作成して本指示書を `completed/` に移動

## SDK 側で先行実装済みの理由 (workspace 横断編集の事後承諾)

manifest 探索ロジックは SDK の `HapbeatManifestIntensity` が直接ファイル名で scan する設計のため、SDK のリネーム + 探索ロジックは同一セッションで完結できた。Studio 側はファイル出力者なので、SDK が読めるファイルを書き出してくれれば整合する。両者の同期は本指示書 + applied note でトラッキングする。
