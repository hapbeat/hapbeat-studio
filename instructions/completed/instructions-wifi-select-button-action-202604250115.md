# Wi-Fi 選択モード起動用ボタンアクション `wifi_select` の追加

## 背景

`hapbeat-device-firmware` 側で Wi-Fi マルチプロファイル機能（最大 5 件）を実装した（2026-04-24）。デバイス本体には **Wi-Fi 選択モード** という固定 UI が組み込まれており、有効化されるとボタン操作で保存済みプロファイルを切り替えて接続先を変更できる。

選択モードへの **入り口** として、ファーム側のボタンアクション系に `wifi_select` という新しいアクション ID が追加される。Studio はボタンアクション割当 UI のドロップダウンにこの選択肢を追加する必要がある。

選択モード自体の UI（OLED 表示・ボタン操作）はファーム側で完全にハードコードされる:

- 表示: `SSID: [name]` を画面左上から（はみ出る分は省略）
- ボタン:
  - **DuoWL**: btn_1 (左上) = 次, btn_3 (左下) = 前, btn_2 (左中) = 決定
  - **BandWL**: btn_l (左) = 前 / btn_r (右) = 次 / btn_c (中) = 決定
- 決定で選択した SSID にホット切替し、選択モードから抜ける

Studio は **このアクションを割り当てる UI を提供するだけ**で、選択モードのレイアウトはデザインしない。

## 対象リポジトリ

`hapbeat-studio`

## 仕様確認用の参照

- Manager 側並行タスク: `hapbeat-manager/instructions/instructions-wifi-multi-profile-ui-202604250115.md`
- ファーム側関連ファイル: `hapbeat-device-firmware/src/wifi_select.{h,cpp}`, `button_handler.cpp`
- アクション ID 文字列は `button_handler.cpp` の alias テーブルに登録されたものをそのまま使用する: **`wifi_select`**

## 実装タスク

### 1. `src/types/display.ts` の `ButtonActionType` に追加

ファイル: `src/types/display.ts`

```ts
export type ButtonActionType =
  | 'none'
  | 'next_page'
  | 'prev_page'
  | 'toggle_page'
  | 'vib_mode'
  | 'display_toggle'
  | 'led_toggle'
  | 'player_inc'
  | 'player_dec'
  | 'position_inc'
  | 'position_dec'
  | 'volume_up'
  | 'volume_down'
  | 'wifi_select'   // ← 追加
```

### 2. `src/components/display/DisplayEditor.tsx` のドロップダウンに追加

ファイル: `src/components/display/DisplayEditor.tsx`、関数 `buildActionGroups()`

`Other` グループ（display_toggle / led_toggle / vib_mode / none が並ぶブロック）の前後どちらでもよいが、システム動作系を分離する意味で **新しいグループ `System` を追加** し、そこに `wifi_select` を入れることを推奨する:

```ts
groups.push({
  label: 'System',
  items: [
    { value: 'wifi_select', label: 'Wi-Fi 選択モード' },
  ],
})

groups.push({
  label: 'Other',
  items: [
    { value: 'display_toggle', label: 'Display ON/OFF' },
    { value: 'led_toggle',     label: 'LED ON/OFF' },
    { value: 'vib_mode',       label: 'VibMode Var/Fix' },
    { value: 'none',           label: '— (None)' },
  ],
})
```

将来 `factory_reset` / `pair_mode` 等のシステム系アクションが増えることを見越して `System` グループに分けておく。

### 3. `buildHoldActionGroups()` の対応

`hold_mode === 'momentary'` の Tmp ホールドでは `wifi_select` を **出さない**（モーメンタリ離しで戻るアクションではないため）。
`hold_mode === 'latch'` (Exec) では `buildActionGroups()` を再利用しているので自動的に出る。

実装上は `buildHoldActionGroups()` 側に変更不要（momentary 分岐は明示的に列挙しているので、自動的に `wifi_select` は除外される）。

### 4. シミュレータ部分（オプション）

`DisplayEditor.tsx` 内の `switch (action)` シミュレータで `wifi_select` を受けても何もしないが、Studio の OLED プレビューには Wi-Fi 選択モードを再現する義務はない（**設計方針**: 選択モードのレイアウトはファーム固定なので Studio で表現しない）。

シミュレータ警告を出さない安全策として、`wifi_select` ケースだけ追加して `/* no-op: rendered by firmware */` コメントで明示すると良い:

```ts
case 'wifi_select':
  // Wi-Fi 選択モード遷移はファーム側で OLED が固定描画する。
  // Studio のプレビューでは表現しない。
  break
```

これは hold 側の同 switch にも追加すること。

### 5. テンプレートへの追加（任意）

`src/utils/templates.ts` の標準テンプレートで、たとえば「3 つ目の長押し or hold スロット」に `wifi_select` を初期割当しておくとユーザーが発見しやすい。ただしユーザーがどのスロットに割り当てるかは自由なので、**初期テンプレートを変えるかどうかは実装者判断**。最小実装としてはテンプレートはいじらず、ドロップダウンに出るだけで OK。

### 6. 永続化フォーマットへの影響

`SavedState.layout.buttons` 等は `ButtonActionType` をそのまま保存しているので、TS 型に追加すれば永続化フォーマットも自動対応する。マイグレーションは不要（既存ユーザーの設定には `wifi_select` は出てこないだけで壊れない）。

### 7. Manager 経由でデバイスへの書き込み

`wifi_select` アクション ID 文字列はそのまま ui-config.json の `button_actions` に流れて Manager → ファームに転送される。ファーム側の alias テーブルが `wifi_select` を解釈するので、Studio 側で特別な変換は不要。

## 動作確認シナリオ

1. **Studio で割り当て**
   - DisplayEditor の任意のボタンの short_press / long_press に `Wi-Fi 選択モード` を割り当て
   - 保存して localStorage に反映されることを確認

2. **Manager 経由でデバイスに書き込み**
   - WebSocket 経由で Manager → デバイスに ui-config.json を送信
   - デバイスの `button_actions` セクションに `"wifi_select"` が入っていることをデバッグダンプで確認

3. **デバイス上で動作確認**
   - 割り当てたボタンを押す → OLED に `SSID: ...` が表示され Wi-Fi 選択モードに入る
   - DuoWL: btn_1/btn_3 で前後、btn_2 で決定 → 選択した Wi-Fi に切り替わる
   - BandWL: btn_l/btn_r で前後、btn_c で決定 → 同上

4. **未割り当ての場合のフォールバック**
   - どのボタンにも `wifi_select` を割り当てなかった場合、選択モードには入れない（Manager の Wi-Fi 設定経由でしか変えられない）。これは仕様通り

## 注意事項 / 落とし穴

- **アクション ID 文字列はファームと完全一致させる**。`wifi_select` (snake_case) で、`wifiSelect` や `wifi-select` ではない
- **DuoWL の hold/long_press への割り当ては推奨しない**：Wi-Fi 選択モードは中断するとユーザーが置き去りになるので、明示的な短押し or 長押しでの起動が望ましい。ただし制限はかけない（ユーザー判断）
- **シミュレータには再現しない**：選択モード中の OLED 描画と挙動はファーム固定なので、Studio で再現するとファームと食い違うリスクがある。プレビューでは何もしない（あるいは「Wi-Fi 選択モード（デバイス側で動作）」と一瞬表示するだけ、程度に留める）

## 関連の契約仕様更新（別タスク）

`hapbeat-contracts/schemas/display-layout.schema.json` の `buttonAction` enum は現状 `next_page / previous_page / toggle_display / none` のみで、Studio / firmware 側の実装に追従できていない。これは既知の負債であり、本タスクの対象外とする。今後 contracts 側の enum を Studio / firmware と同期する別タスクで `wifi_select` も含めて整理する。
