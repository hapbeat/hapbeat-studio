# 指示書: button_actions を選択中デバイスモデルのみ出力する

- **作成日**: 2026-04-08
- **作成元**: hapbeat-device-firmware セッション
- **対象リポジトリ**: hapbeat-studio
- **目的**: ui-config.json の button_actions に全デバイスモデルのボタンが混在する問題を修正

---

## 症状

Studio から書き込まれた ui-config.json の button_actions に、DuoWL（btn_1〜btn_5）と BandWL（btn_l/btn_c/btn_r）の**両方**が含まれている。

ファーム側では BandWL のボタンID（btn_l=idx0, btn_c=idx1, btn_r=idx2）が DuoWL のボタン設定を上書きし、btn_1/btn_4/btn_5 のアクションが `none` になる。

### 実際のログ（ファーム側）

```
[UiConfig] btn 'btn_1' (idx=2) short='prev_page'   ← 正しく設定
[UiConfig] btn 'btn_4' (idx=1) short='next_page'    ← 正しく設定
[UiConfig] btn 'btn_l' (idx=0) ...                   ← BandWL が混入
[UiConfig] btn 'btn_r' (idx=2) short='none'          ← btn_1 を上書き！
```

## 原因

Studio が button_actions を出力する際、選択中のデバイスモデルに関係なく全モデルのボタン設定を含めている。

## 修正

`displayLayoutIO.ts`（または該当するエクスポート関数）で `button_actions` を出力する際、**現在選択中のデバイスモデルのボタンIDのみ**を含めること。

### 期待する出力

**DuoWL 選択時:**
```json
"button_actions": {
  "btn_1": { "short_press": "prev_page", "long_press": "none", "hold": "none", "hold_mode": "momentary" },
  "btn_2": { "short_press": "mode_toggle", "long_press": "none", "hold": "none", "hold_mode": "momentary" },
  "btn_3": { "short_press": "next_page", "long_press": "none", "hold": "none", "hold_mode": "momentary" },
  "btn_4": { "short_press": "next_page", "long_press": "none", "hold": "none", "hold_mode": "momentary" },
  "btn_5": { "short_press": "display_toggle", "long_press": "none", "hold": "none", "hold_mode": "momentary" }
}
```
→ btn_l / btn_c / btn_r は含めない

**BandWL 選択時:**
```json
"button_actions": {
  "btn_l": { "short_press": "volume_up", ... },
  "btn_c": { "short_press": "mode_toggle", ... },
  "btn_r": { "short_press": "volume_down", ... }
}
```
→ btn_1〜btn_5 は含めない

## 備考

ファーム側でも防御として、ハードウェアに合わないボタンIDを無視するフィルタを追加済み。ただしそれは防御であり、Studio 側で正しいデータだけを送るのが本筋。

---

## 完了条件

- [ ] DuoWL 選択時に btn_l / btn_c / btn_r が button_actions に含まれない
- [ ] BandWL 選択時に btn_1〜btn_5 が button_actions に含まれない
- [ ] デバイスモデル切替時に button_actions が正しくリセットされる
