# Instructions: Kit が適切に保存できない (継続調査)

**発行日:** 2026-04-28
**起票:** 2026-04-27〜28 Helper MVP + Studio Manager 統合セッション (継続)
**優先度:** 即着手

## 背景

複数回のフィックス (autosave debounce / race condition guard / events 空でも保存 /
fs status の見える化 / 実ファイル master 同期) を入れた後も、ユーザーから
「まだ kit が適切に保存できない問題が残っている」との報告で次セッションに持ち越し。

最新の挙動 (commit 9a0e14f / その後の差分) でも症状が続いているため、根本原因が
別のところにある可能性が高い。

## これまでの修正内容

1. autosave debounce + race condition: timer 内で `kits.some(k => k.id === kit.id)` を
   pre / post-await で 2 段チェック、`buildAndSave({silent}) → writeKitFolder` 直前にも
   存在チェック (commit 7a8158a)
2. 新規 kit でも events 空のまま autosave を走らせて空 manifest を即書き出し
3. autoSaveLabel に blocker (outRoot 未設定 / 名前 NG) の precise 表示
4. fallback テキストから「auto-save 待機中」を撤去
5. 実 kit folder (`<packId>/manifest.json`) を master に — `syncClipsFromDir` 内で
   `importKitsFromOutputDir` を呼び、`kitDirHandle ?? workDirHandle` で動くように
6. `localFsStatus` を libraryStore に集中、フッターに pill 表示

それでも残っている症状を次セッションで再現する必要がある。

## 次セッションのデバッグ手順

1. **症状の正確な再現**:
   - 新規 kit 作成 → ボタン横の autoSaveLabel と Footer の LocalFsStatus は何を表示する?
   - `保存中…` が出るのに完了しないのか、`保存待機…` で止まるのか、
     そもそも何も出ないのか
   - F12 で `useLibraryStore.getState().localFsStatus` を確認
2. **autosave useEffect が発火しているか**:
   - KitExportSection 内 `useEffect([kit, clips, outRoot, buildAndSave])` の依存
   - `outRoot` が null なら early return → status は idle のまま
   - workDirHandle / kitDirHandle が permission lost → restoreWorkDir で false
     になっていないか確認
3. **buildAndSave の例外パス**:
   - `validateKitName` 通過後、`exportKitAsPack` で何かが throw すると
     `setAutoSaveStatus('error')` に飛ぶはず → 表示されないなら throw すら
     起きていない可能性
   - `exportKitAsPack(kit, clips)` を新規 (events 空) で呼んだ場合、`for (const ev of kit.events)` は
     skip → manifest だけ生成 → その時点で throw しないか?
4. **writeKitFolder が実際にディスクに書いているか**:
   - F12 で `(await window.showDirectoryPicker())` を叩いて `<outRoot>/<packId>/`
     が存在するか目視
   - createWritable / write / close が permission denied で silent fail していないか
5. **scanKitOutputFolder が拾っているか**:
   - syncClipsFromDir で kit が見つからないと kitsMeta.json fallback だが、
     これも保存されない場合は IDB-only 状態
6. **Helper への影響なし** (Helper は kit deploy 時のみ関与、Save 自体には不要)

## 完了条件

- [ ] 新規 kit 作成 → `<outRoot>/<新kit名>/manifest.json` が即座に存在する
- [ ] kit に event 追加 → manifest.json と install-clips/*.wav が更新される
- [ ] kit を OS Explorer で削除 → ブラウザリロード後に Studio から消える
- [ ] kit を × → `_archive/<packId>/` に移動、Studio から消える
- [ ] フッター LocalFsStatus が saving → saved の遷移を正しく表示
- [ ] 本ファイルを `instructions/completed/` に移動

## 依存関係

- **Required**:
  - workDirHandle のパーミッション (永続化されているか)
  - File System Access API のサポート (Chrome / Edge / Safari の最近のバージョン)
- **Downstream**:
  - device-firmware の FIRE モード再生不全 (`instructions-fire-mode-and-target-device-202604280210.md`)
    の調査と並行して進めれば一気に kit ライフサイクルが繋がる

## 参考ファイル

- `src/components/kit/KitManager.tsx` の `KitExportSection` (autosave useEffect / buildAndSave / handleDeploy)
- `src/stores/libraryStore.ts` の `createKit` / `removeKit` / `updateKit` / `syncClipsFromDir` / `importKitsFromOutputDir`
- `src/utils/localDirectory.ts` の `writeKitFolder` / `archiveKitFolder` / `scanKitOutputFolder`
- `src/utils/kitExporter.ts` の `exportKitAsPack`
- `src/components/common/LocalFsStatus.tsx` (フッター pill)
