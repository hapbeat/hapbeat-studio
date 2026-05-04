# 指示書: Manager → Studio 移植の漏れ機能を補完する

**配置先:** `hapbeat-studio/instructions/later/`
**起点セッション:** 2026-04-27 02:40 (Manager 機能 1:1 監査)
**優先度:** 中

## 背景

Phase 2 で Manager の機能を Studio に移植したが、Manager の現行実装と
1:1 で照合した結果、以下の機能が **未移植** または **不完全**。

## 監査結果 — Manager にあって Studio に無い機能

### Critical (UX 上明らかに欠ける)

1. **Kit deploy の進捗バー**
   - Manager: `ContentPage.set_progress(percent, status)` でバー + ステータス表示
   - Studio: `deploy_result` の OK/NG だけ。Helper は `_deploy_kit_to_device` で
     ファイル毎の send 進捗を取れるが broadcast していない
   - 修正: Helper に `deploy_progress` push 追加 + KitManager 側で受信して進捗バー表示

2. **Wi-Fi 接続試行の結果追跡**
   - Manager: `set_wifi` 送信後 12 秒間 `get_wifi_status` を 2 秒間隔でポーリング、
     `connected=true` を見届けて「✓ 接続しました」または「✗ 接続失敗」を表示
     (`_wifi_attempt_active` / `_wifi_poll_timer` / `_wifi_attempt_timeout`)
   - Studio: `set_wifi` の WS 応答 (write_result) のみ → "保存しました" 止まり、
     実接続成否がユーザーに分からない
   - 修正: `WifiProfilesForm` で set_wifi 送信後にポーリングを開始、12 秒後に結果判定

3. **Section-local flash_warning / flash_info**
   - Manager: 各 section 直下に inline status label を持ち、操作のフィードバックを
     近接表示 (例: 名前変更失敗 → 名前 input の真下に warning)
   - Studio: ヘッダー横に 1 箇所だけの `globalStatus`、操作箇所と離れている
   - 修正: 各 Form に `useFormStatus` フックを通して inline status 表示

### Medium

4. **Erase Flash ボタン (USB Serial)**
   - Manager: `FirmwarePage.erase_flash_requested` Signal あり
   - Studio: 無い (Web Serial Phase 3 でカバーすべき)
   - 修正: Phase 3 の Serial 実装時に同梱

5. **Pack normalize 警告の UI 表示**
   - Manager: `pack_normalize` の `messages` を log drawer に流す
   - Studio Helper: `pack_normalize` を呼ぶが結果を WS で push していない
   - 修正: Helper の `_extract_and_normalize` で warnings を `kit_normalize_warning`
     として broadcast → Studio で log drawer に流す

6. **Reboot 後の再接続検出**
   - Manager: reboot 送信後 600ms で serial disconnect、自動再接続
   - Studio: reboot 後にデバイスが offline → online に戻るまで何も出ない
   - 修正: reboot WS 送信時に「再起動中… (約 5 秒)」と表示し、
     PONG 受信で「✓ 再接続しました」に切り替え

### Skip (合意済み or 別 Phase)

- Live Audio (AudioBridgePage) → Phase 5
- USB Serial flash (esptool-js) → Phase 3
- Recovery section (低バッテリー) → Manager でも `_RECOVERY_ENABLED=False` で無効化中

## 完了条件

各項目の「修正」を実装し、Manager と挙動が揃っていることを確認:

- [ ] Kit deploy で進捗バーが進む (per-file)
- [ ] set_wifi 送信後に「接続中… 残り N 秒」表示 → 接続成否を判定して通知
- [ ] 各 form 操作の成否が近接 inline で出る
- [ ] Helper が pack normalize warning を push
- [ ] Reboot 送信時のフィードバック表示

## 関連 doc

- `hapbeat-manager/src/hapbeat_manager/widgets/config_page.py` - flash_warning / wifi profile / debug
- `hapbeat-manager/src/hapbeat_manager/widgets/content_page.py` - set_progress
- `hapbeat-manager/src/hapbeat_manager/widgets/firmware_page.py` - erase_flash
- `hapbeat-manager/src/hapbeat_manager/main_window.py` - wifi attempt polling (`_maybe_handle_wifi_attempt_response` 等)

## 完了したら

`instructions/completed/` に移動。
