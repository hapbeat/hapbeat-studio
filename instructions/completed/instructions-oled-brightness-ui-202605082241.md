# Studio: OLED 輝度 (low / mid / high) 設定 UI

**作成日:** 2026-05-08
**起点セッション:** workspace `studio + helper` worktree
**優先度:** 中
**前提:** device-firmware 側の `set_oled_brightness` / `get_oled_brightness` 実装が必要
(指示書: `hapbeat-device-firmware/instructions/instructions-oled-brightness-3-levels-202605082240.md`)

---

## 背景

OLED 輝度を 3 段階 (low / mid / high) で切替えられるようにする。
眩しさ対策と省電力 (限定的) 用途。

---

## 仕様

### UI 配置

**Devices タブ → 設定 (Settings) サブタブ** に「OLED 輝度」セクションを追加。

```
OLED 輝度: [Low] [●Mid] [High]
           ⓘ 暗所では Low、展示用は High
```

- 3-state segmented button (現状の他の toggle と同 UI)
- 現在値を get_oled_brightness で取得 (or get_info に含まれていればそこから)
- クリックで set_oled_brightness を即送信、device confirm で UI 更新

### WS message 型

`src/types/manager.ts` に追加:

```ts
// Studio → Helper
| 'set_oled_brightness'  // { level: 1|2|3 }
| 'get_oled_brightness'  // {}

// Helper → Studio
| 'oled_brightness_result'  // { level: 1|2|3 }
```

### Helper 透過

Helper はそのまま TCP 7701 へ転送。新規 handler は不要 (既存の write/query パターンに乗る)。

---

## 実装ファイル候補

1. **`src/types/manager.ts`**: 上記 message 型追加
2. **`src/components/devices/`** に新規 `OledBrightnessSection.tsx`:
   - 3-state segmented button
   - get_oled_brightness 結果を deviceStore.infoCache に保存 (or 独立 state)
   - set_oled_brightness で即時送信
3. **`src/components/devices/DeviceDetail.tsx`** または `IdentityForm.tsx` の隣に統合
4. **`src/stores/deviceStore.ts`**: `infoCache[ip].oled_brightness` フィールド追加 (任意)

---

## 完了条件

- 設定タブに 3 段階輝度切替 UI
- 現在値の表示 (アクティブ button が highlight)
- クリックで即時切替 + device 反映確認後に UI 更新
- 複数デバイス選択時は個別反映 (broadcast 不可、各 IP に順次送信)

## 検証手順

1. デバイス選択 → 設定タブで「OLED 輝度: Mid」表示
2. Low クリック → OLED が暗くなる + UI が Low に highlight
3. デバイス再起動 → Low のまま起動 (NVS 永続化確認、device 側仕様)
4. High に変更 → 即時反映

## 関連参照

- device 側指示書: `instructions-oled-brightness-3-levels-202605082240.md`
- 既存パターン参考: `IdentityForm.tsx` の group 設定 (NVS-stored 設定の Studio UI)
