# Instructions: clips を disk-as-truth 化（ブラウザ永続をやめ作業フォルダ参照に統一）

**発行日:** 2026-06-21
**起票:** hapbeat-sdk-workspace セッション（QA: BandWL v2 / Studio フォルダ挙動調査の派生）
**優先度:** 即着手寄り（顧客が実害を踏んでいる）

## 背景

「空の専用フォルダを作業フォルダに指定したのに、テンプレート（組み込みライブラリ）以外に
過去に取り込んだ clip（例: `handdemo` / `basicexample`）の `.wav` が書き込まれる」という
不具合。原因は **clips がブラウザ（IndexedDB）に永続化され、作業フォルダと無関係に復元 →
空フォルダへ seed される**こと。

kits は既に disk-as-truth 方針（IDB は cache のみ / `saveKit` は dead code / `kits-meta.json`
が真実、2026-05-26〜06-02 の対応）。**clips も同じ規律に揃える**のが本タスク。
amp preset は既に作業フォルダ内 `amp-presets.json` 方式（[libraryStore.ts:342,2180-2183](../src/stores/libraryStore.ts) `AMP_PRESETS_FILE` / `loadAmpPresets`）で localStorage 不使用 → これは現状維持でよい。

## 現状の問題コード（file:line）

1. **起動時、フォルダ未接続でも IDB から clips を復元している**
   - `loadLibrary` の no-workdir 分岐: `const clips = await listClips()` → `set({ clips, kits: [] })`
     （[libraryStore.ts:1083-1084](../src/stores/libraryStore.ts#L1083)）。
     kits は `[]` にしているのに **clips だけ IDB から復元**している（コメント 1080-1082「drop a clip,
     it lives in IDB until you pick a folder」が旧仕様）。

2. **空フォルダ接続時、IDB 由来の in-memory clips をフォルダへ書き出している**
   - `pickWorkDir`（[libraryStore.ts:1262-1273](../src/stores/libraryStore.ts#L1262)）:
     空フォルダなら `syncClipsToDir()`（メモリの全 clip を書き出し）→ `importAllBuiltinClips()` は
     **`clips.length === 0` のときだけ**。IDB 由来 clip が残っているので built-in seed が走らず、
     過去 clip がそのまま新フォルダに書かれる。
   - `syncClipsToDir`（[libraryStore.ts:1776-1792](../src/stores/libraryStore.ts#L1776)）は
     `get().clips` 全件の `.wav` + メタを書き出す。
   - `pickWorkDir` は kits の `pickKitDir`（[1311-1312] `resetKitMemory()` + `kits:[]`）と違い、
     **作業フォルダ切替時に in-memory clips をクリアしない**。

3. **clip 本体・メタが IDB に永続化されている**
   - `hapbeat-studio-library` の `clips` / `audio` ストア（[libraryStorage.ts:6-7,24-29](../src/utils/libraryStorage.ts#L6)）。
     `saveClip` / `listClips` / `loadClipAudio` 経由。kits の IDB ストアと同じく「真実」になってはいけない。

## 望ましい挙動（disk-as-truth for clips）

- **clips の source of truth = 作業フォルダ**（`.wav` ファイル + `clips-meta.json`）。
- 例外は **組み込みテンプレートライブラリの取り込みのみ**（`public/library/index.json` + 各 `.wav` を
  fetch する `importAllBuiltinClips` / `loadBuiltinIndex`。fps-sample / showcase-kit / sine-tones）。
- **ブラウザ側（IndexedDB / localStorage）に clip 本体・メタ・amp を永続しない**。
  IDB はランタイム cache に限定するか、clips 永続用途としては撤去する。
  （`encoded-wavs` のような純 cache は維持可。clip/audio の「真実」用途は停止。）

## 具体的な変更

1. **`loadLibrary`**: no-workdir 時に `listClips()` で IDB から復元しない。kits と同様
   `set({ clips: [] })`（または built-in テンプレートのみロード）にする。clips 編集は
   作業フォルダ接続が前提、という UX に統一（未接続時の Library は「組み込みテンプレート閲覧のみ」）。

2. **`pickWorkDir`**:
   - 作業フォルダ切替時に **in-memory clips をクリア**してから新フォルダを採用（`pickKitDir` の
     `resetKitMemory()`+`kits:[]` に相当する clips 版を入れる）。
   - **空フォルダなら必ず built-in テンプレートのみ seed**（`importAllBuiltinClips`）。
     旧 clips を書き出さない（`syncClipsToDir` で全件書き出す経路を空フォルダで使わない）。
   - 非空フォルダは従来どおり `syncClipsFromDir()`（ディスクを真実として読み込む）。

3. **clip CRUD（追加 / インポート / 削除 / rename / amp 変更）**: 永続は
   `saveClipsMetaToDir` + `writeClipFile`（作業フォルダ）に一本化。IDB への永続書き込み
   （`saveClip` / `STORE_CLIPS` / `STORE_AUDIO` の真実用途）を停止する（kits の `saveKit`
   dead-code 化と同じ扱い）。未接続時は「フォルダを接続してください」を促し、ブラウザに溜めない。

4. **レガシー IDB データの purge**: `hapbeat-studio-library` の `clips` / `audio`（必要なら
   `kits`）に残る stale 行を起動時にクリアする移行処理を入れる（リリース前で既存ユーザー無し →
   後方互換不要、破棄してよい）。または「読まない」徹底で実害が無いことを保証する。

5. **amp preset**: 既に `amp-presets.json`（フォルダ）方式なので維持。localStorage は使わない
   （現状そうなっている）。UI 設定のみの localStorage（`LIBRARY_SORT_KEY` 等のソート設定）は
   clip データではないため対象外＝残してよい。

## エッジケース / 注意

- **未接続時の Library 表示**: 組み込みテンプレートのみ。「drop した clip を IDB に貯めて後で
  フォルダに移す」旧フローは廃止する（これが phantom の温床）。
- **built-in 取り込み**: `loadBuiltinIndex`（`public/library/index.json` fetch）→ `importAllBuiltinClips`
  は維持。これがテンプレートの唯一のブラウザ→フォルダ供給経路。
- リリース前で**既存ユーザー・後方互換は考慮不要**（workspace CLAUDE.md 方針）。stale IDB は消してよい。

## 完了条件

- [ ] 空の専用フォルダを接続 → **組み込みテンプレート（fps-sample / showcase-kit / sine-tones）だけ**が
      入り、`handdemo` / `basicexample` 等の過去 clip は出ない・書き込まれない。
- [ ] ブラウザのサイトデータ（IndexedDB）をクリアしても、作業フォルダを接続すれば
      **フォルダ内容が真実として復元**される（ブラウザに依存しない）。
- [ ] clip 本体・メタ・amp が localStorage / IDB に永続されていない（IDB は cache のみ）。
- [ ] `npm run build`（tsc + vite）/ `npm run test` pass。
- [ ] `/self-review` 通過（disk-as-truth・並行 flush・フォルダ切替時の race を観点に含める）。
- [ ] 本ファイルを `instructions/completed/` に移動。

## 検証

- DevTools → Application → IndexedDB で `hapbeat-studio-library` の `clips`/`audio` に
  clip データが**増えない**こと。
- フォルダ切替（A→空 B）で B に A の clip が漏れないこと。
- 別ブラウザ / サイトデータクリア後にフォルダ接続して clip が揃うこと。

## 関連（kit 側の同根クリーンアップも併せて）

kits は disk-as-truth 方針だが、本調査で以下の同根の緩みを確認:
- `pickWorkDir` が kit memory を reset しない（`pickKitDir` のみ reset）。
- `importKitsFromOutputDir` が**ディスクに存在しない kit を prune しない**ため in-memory の
  stale kit が survive し得る（[libraryStore.ts:1405-付近](../src/stores/libraryStore.ts#L1405) のコメント参照）。
- レガシー IDB `kits` ストア（dead だが stale 行が残存）。

clips 対応のついでに、**作業フォルダ切替時の reset / import 時の prune / レガシー IDB purge** を
clips・kits 両方で同じ規律に揃えること。
