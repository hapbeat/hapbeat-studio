# 指示書: 再生テストの「ストリーミングテスト」を Manager 同等のフォルダブラウザに置き換え

**配置先:** `hapbeat-studio/instructions/later/`
**起点セッション:** 2026-04-27 02:30 (devices-subtab 整理セッションからの分割)
**優先度:** 中 (Phase 2 完了後の追加要望)

## 背景

現状の `src/components/devices/StreamingTestSection.tsx` は **単一ファイル選択** UI で、Manager
の `widgets/test_page.py` (920+ 行) にあるフォルダ列挙 + キーボードナビゲーション機能を
再現できていない。

ユーザー要求:
- 単一ファイル再生は不要 → 削除
- フォルダを選択して中の音源を Explorer のようにグリッド表示
- ファイル数 / コンポーネント幅に応じて行列を動的に決定 (詰め込み配置)
- ↑↓←→ で前後左右移動、Space で再生/一時停止、Enter でフォルダ侵入・再生、`..` で親へ

## 参照する Manager 実装

`hapbeat-manager/src/hapbeat_manager/widgets/test_page.py` の以下:

- `_NoBubbleListWidget` — 親 ScrollArea にホイールイベントをバブルさせない `QListWidget`
- `_set_current_dir()` — フォルダ走査 + 親フォルダ行 (`📁 ..`) + サブフォルダ + 音源ファイルの順
- `_AUDIO_EXTS` (拡張子集合) — `wav/mp3/aac/m4a/ogg/flac/mp4/mkv/avi/mov/webm`
- `_compute_n_cols` / `_apply_grid_width` / `_apply_content_height` — 動的列数 + ヒステリシス + 行数調整
- `_relayout_list()` — content 変更時の再フィット
- `_toggle_play_or_pause()` — Space キーの選択依存挙動 (停止中=再生 / 再生中同じファイル=pause トグル / 再生中別ファイル=切替)
- `_on_list_activated()` — Enter / ダブルクリック (parent → 上、dir → 入る、file → stream)
- `_on_seek_*` / `set_stream_progress()` — シーク + 再生位置表示
- ドラッグ&ドロップ (フォルダ / 音源)

## 完了条件

- `StreamingTestSection.tsx` を **フォルダブラウザ実装** に置き換え (単一ファイル選択は削除)
- `<input type="file" webkitdirectory>` または File System Access API の `showDirectoryPicker` でフォルダ取得
- フォルダ内 + サブフォルダの WAV/MP3/M4A/OGG/FLAC を列挙
- グリッドレイアウト + 動的列数 (要素幅に応じて 2-4 列、最小列幅 170px、ヒステリシス 30px)
- 矢印キー: ↑↓←→ で選択移動 (CSS grid + 自前 keydown handler)
- Space: 選択依存トグル (停止中=再生 / 再生中=pause / 別選択=切替)
- Enter / ダブルクリック: parent / dir / file の動作切替
- ドラッグ&ドロップでフォルダ受付
- シークバー + 時刻表示 + 一時停止ボタン
- Now playing ラベル
- 既存 utils/audioStreamer.ts (16kHz resample + STREAM_BEGIN/DATA/END) はそのまま流用

## ブラウザ制約と実装メモ

- **File System Access API の `showDirectoryPicker`** は Chrome/Edge のみサポート、Safari/Firefox は不可。フォールバックとして `<input type="file" webkitdirectory>` を使う (これは全ブラウザ動くが、ファイル選択ダイアログが直感的でない)
- フォルダの "中" を再帰列挙する場合、`FileSystemDirectoryHandle` の async iterator (`for await (const entry of dirHandle.values())`) を使う
- 親フォルダへの移動は `FileSystemDirectoryHandle` ではできないため、ユーザーが選択したルート以下に閉じ込める設計でも良い (Manager は OS のルートまで遡れる)
- ストリーミング中の pause は `audioStreamer.streamClip` の AbortController を活用するか、`stream_data` の送信ループに pause フラグを足す

## 検証手順

1. 適当な WAV を集めたフォルダを「参照…」で開く
2. グリッドが panel 幅に応じて 2-4 列で並ぶ
3. ↑↓←→ で選択移動、Space で再生開始
4. 再生中に別ファイルを選んで Space → 切替
5. 再生中に同じファイルで Space → pause/resume
6. パネル幅を縮める → 列数が減って高さが伸びる
7. パネルを広げる → 列数が増える (ヒステリシスで rapid flicker しない)
8. ドラッグ&ドロップでフォルダ受付

## 関連 doc

- 現実装: `src/components/devices/StreamingTestSection.tsx`
- 移植元: `hapbeat-manager/src/hapbeat_manager/widgets/test_page.py`
- ストリーマ: `src/utils/audioStreamer.ts`

## 完了したら

`instructions/completed/` に移動。
