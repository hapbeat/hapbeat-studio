# 指示書: Working Directory ロードを高速化

**配置先:** `hapbeat-studio/instructions/later/`
**起点セッション:** 2026-04-27 02:35 (devices-subtab セッションでユーザー報告)
**優先度:** 中 (UX を直接損なう体感問題)

## 問題

ユーザーが Studio を起動して Library workdir を再接続 (`restoreWorkDir`) してから
clip 一覧が描画されるまで時間がかかる。clip 数が増えるほど線形悪化。

## 原因 (`src/stores/libraryStore.ts` の `syncClipsFromDir`)

1. **全 WAV を `file.arrayBuffer()` で読み込み + `AudioContext.decodeAudioData()` を実行**
   メタデータ (`clipsMeta.json`) が存在しても無条件にデコードしている (L673-674, L678-679)。
   1 ファイル数十-数百 ms × N ファイルで線形悪化。
2. **IndexedDB へ全 clip を `saveClip` で書き戻し** (L674)
   既に IDB にある場合でも write amplification が発生。
3. **sequential `for` ループ**
   ファイル I/O / decode が 1 つずつ直列実行で並列性ゼロ。
4. **`refreshClipsFromDir` も同じ問題** (L745-)
5. UI 側はこれらを `await get().syncClipsFromDir()` で待つので、終わるまで Library が空のまま。

## 提案する修正

### 1. メタデータ優先 + decode はキャッシュミス時のみ
```ts
const existing = metaMap.get(filename)
if (existing && existing.duration > 0 && existing.channels > 0) {
  // メタが完全 → decode しない、IDB write もしない
  clips.push(existing)
  continue
}
// ↓ メタ無し or 不完全な場合のみ decode + IDB write
```

### 2. ファイル mtime でキャッシュ妥当性を判定
`File.lastModified` を `LibraryClip.fileMtime` として保存。
ロード時に mtime 一致 → メタ・blob 両方をスキップ。mtime ズレ → decode + 再書き込み。

### 3. blob を IDB に毎回コピーしない
`saveClip(existing, blob)` は workdir → IDB の同期が目的だが、
**実はもう必要ない**。Studio は audio 再生時に IDB ではなく `readClipFile(workDirHandle, ...)` で
都度読めるので、IDB ミラーは廃止可能。
(ただし IDB-only モード — File System Access 非対応ブラウザ — の互換性に注意)

### 4. 残った decode を並列化
`Promise.allSettled(fileList.map(async ...))` で並列実行。
ただし AudioContext は同時 decode に強くないので、`concurrency = 4` 程度の semaphore でガード。

### 5. UI を ストリーミング表示に
`syncClipsFromDir` が返るのを全部待たず、 メタが揃ったクリップから順次 `set({ clips: ... })`
して描画 (Zustand state を増分更新)。
ユーザー体感は「全件待つ」ではなく「徐々に増える」になる。

### 6. 進捗 UI を出す
Library のヘッダーに「Loading clips… 24 / 87」を出す。今は完全沈黙で長時間待たされ、
何が起きているか分からない。

## 影響範囲

- `src/stores/libraryStore.ts`: `syncClipsFromDir` / `refreshClipsFromDir` / `LibraryClip` 型に `fileMtime` 追加
- `src/utils/libraryStorage.ts`: 互換性 (IDB ミラーを残すか撤去するか) の判断
- `src/components/kit/KitManager.tsx`: 進捗 UI の追加 (ヘッダーバナー)

## 完了条件

- 100 clip のフォルダで初回ロード/再接続が **1 秒以内** に Library が描画される
  (現状を測定して比較値を記録)
- 2 回目以降のロードはメタ不変なら decode 0 件
- 進捗バー or 件数表示で「処理中」が見える
- 既存ユーザー (`clipsMeta.json` を持つ workdir) は再 decode が走らない
- `npm run build` 通過

## 検証手順

1. 100 個 WAV を `clips/` に置いた workdir を準備
2. Studio リロード → Library 描画までの時間を計測 (修正前後)
3. 1 つだけ WAV を差し替えて mtime を更新 → その 1 件だけ decode が走ること
4. 全件削除 → kit 編集で問題なくクリップが利用できること

## 完了したら

`instructions/completed/` に移動。
