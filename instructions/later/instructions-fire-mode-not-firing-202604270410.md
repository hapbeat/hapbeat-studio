# 指示書: FIRE モード kit event を Devices/Kit タブから再生しても振動しない

**配置先:** `hapbeat-studio/instructions/later/`
**起点セッション:** 2026-04-27 04:10 (Kit UX セッション)
**優先度:** 高 (機能不全)

## 現象

1. Studio で kit を作成し Deploy to Device で deploy 完了
2. Devices > 選択デバイス > Kit サブタブ で kit が一覧に出る
3. event ボタン (例: `cmd-test.grab-right`) をクリック
4. Helper のログには `OK — play sent` が出る
5. **デバイスが振動しない**

stream_clip モードでの再生 (Kit タブの ▶) は正常動作しているので、UDP の経路自体は通っている。FIRE (command mode) のときだけ問題。

## これまでに切り分け済の項目

- Helper: `_handle_preview_event` は target=broadcast で
  `protocol.build_play(seq, event_id, target="")` を送信。
  ログで "OK — play sent" が出るので Helper の export までは正常。
- Studio: `InstalledKitsSection.onPlayEvent` から
  `preview_event` で event_id をそのまま渡す (前回 commit e643e52 で
  target=device.address → target="" に変更済)。
- 直前: target=device.address だと address フィルタで弾かれる可能性が
  あったため broadcast に修正したが、それでも振動しない。

## 残った原因候補

1. **デバイス側 kit_install 後の event_id 解決バグ**
   - kit_install で manifest.json に登録された event_id が
     正しく LittleFS に書き込まれていない
   - kit_id (= cmd-test) と event_id (= cmd-test.grab-right) の
     prefix 一致判定が壊れている
   - `pack_installer` (firmware) の event テーブルが旧 manifest schema
     を期待している (`clips/` vs `install-clips/` 等)
2. **manifest.json の events 構造が古い形式**
   - 提示された manifest:
     ```json
     "events": {
       "cmd-test.grab-right": {
         "clip": "grab-right.wav",
         "parameters": {...}
       }
     }
     ```
   - 期待形式と乖離している可能性 (firmware 側の最新仕様を要確認)
3. **stream_clip と FIRE で WAV の置き場が違う**
   - manifest を見ると stream_clip モードは `clip: "stream-clips/80hz_1s.wav"`
   - FIRE モードは `clip: "grab-right.wav"` (prefix なし)
   - `install_clips` セクションには bare filename で登録されている
   - Helper の deploy_kit_data は pack_dir 全体を file 送信 →
     install-clips/ にコピーされる
   - **firmware が "grab-right.wav" → install-clips/grab-right.wav の
     resolve をできているか?**

## デバッグ手順

1. Helper を `--verbose` で起動して PLAY 送信時の生バイト列をダンプ
   - event_id バイトが期待通りか確認
2. Hapbeat デバイスで TCP `log_stream` を有効化し、PLAY 受信時の
   firmware ログを確認
   - kit_install 後の event テーブル状態
   - PLAY ハンドラの event_id lookup が hit するか
3. 直近の hapbeat-device-firmware の `pack_installer.cpp` /
   `event_dispatcher.cpp` を読んで仕様確認
   - `install_clips` セクション読込が `install-clips/` プレフィックス
     を期待しているか
4. 確実に動く参照 kit (Manager で deploy したやつ) と
   Studio が出力した kit の manifest.json を diff
   - 完全一致なら firmware バグ、差分があれば Studio kitExporter 側

## 期待動作

`preview_event(event_id="cmd-test.grab-right")` を broadcast すると、
deploy 済の Hapbeat デバイスが `install-clips/grab-right.wav` を再生
してその振動を出す。

## 参考ファイル

- `src/utils/kitExporter.ts` (manifest 出力)
- `src/components/devices/InstalledKitsSection.tsx` (Kit 内 event クリック)
- `hapbeat-helper/src/hapbeat_helper/server.py` (`_handle_preview_event`,
  `_deploy_kit_to_device`)
- `hapbeat-device-firmware/src/pack_installer*.cpp` (firmware 側)

## 完了したら

`instructions/completed/` に移動。原因が firmware にあれば device-firmware の
`instructions/` にも同等の指示書を起こす。
