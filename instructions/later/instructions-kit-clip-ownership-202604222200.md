# Instructions: Kit 内 Clip の物理所有 & 事前コピー

**発行日:** 2026-04-22
**起票:** 2026-04-22-studio-kit-ux-folder-separation-auto-import セッション
**優先度:** 後回し

## 背景

現在 Kit event は Library の clip を参照するだけで、Kit output dir にコピーされるのは Deploy (writeKitFolder) 時のみ。
ユーザーから「Kit に clip を追加した時点で Kit フォルダにコピーしたい」という要望があったが、
auto-import で一定の相互性が確保されたため現時点は見送り。

Unity SDK 側が Kit フォルダから直接 WAV を読む設計（`stream-clips/<name>.wav`）のため、
Studio で Kit を編集する際にリアルタイムで Kit フォルダを更新する仕組みがあると便利。

## タスク

1. Kit に event を追加したとき、対応 WAV を kitDirHandle/<kitName>/clips/ または stream-clips/ にコピー
2. clip を別の名前に rename した場合、Kit フォルダ側のファイルも追随して rename
3. Kit から event を削除した場合、Kit フォルダ側のファイルを削除（または archive に移動）
4. Kit を Deploy しなくても Kit フォルダが常に最新状態になるオプション UI（「Keep in sync」トグル等）

## 完了条件
- [ ] Kit event 追加時に WAV が Kit output dir に書き出される
- [ ] Kit event 削除時に WAV が Kit output dir から削除される
- [ ] clip rename が Kit output dir にも反映される
- [ ] 「Keep in sync」的な opt-in トグルがある（常時同期は強制しない）
- [ ] 本ファイルを `instructions/completed/` に移動

## 依存関係
- **Required**: kitDirHandle が設定されていること（2026-04-22 セッションで実装済み）
- **Downstream**: Unity SDK が Kit フォルダを参照する設計と整合
