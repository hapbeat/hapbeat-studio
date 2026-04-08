# 指示書: ボタンID のファームウェア同期確認

- **作成日**: 2026-04-08
- **作成元**: hapbeat-device-firmware セッション
- **対象リポジトリ**: hapbeat-studio
- **目的**: ファーム側のボタンリファクタに伴う情報共有と軽微な確認事項

---

## 背景

ファーム側のボタン処理を全面リファクタした。

**変更前**: `ButtonAction` enum ベース、ファーム固有のボタンID（`btn_0`〜`btn_4`, `btn_up`/`btn_mode`/`btn_down`）
**変更後**: 文字列ベースの汎用実行テーブル。Studio の出力をそのまま受け取れる。

### ファーム側が認識するボタンID（エイリアステーブル）

```cpp
// Studio DuoWL (1-indexed)
{"btn_1", 0}, {"btn_2", 1}, {"btn_3", 2}, {"btn_4", 3}, {"btn_5", 4},
// Studio BandWL
{"btn_l", 0}, {"btn_c", 1}, {"btn_r", 2},
// Legacy (0-indexed)
{"btn_0", 0}, {"btn_up", 0}, {"btn_mode", 1}, {"btn_down", 2},
```

**Studio の現在の出力（`btn_1`〜`btn_5`, `btn_l`/`btn_c`/`btn_r`）はそのまま認識される。変更不要。**

### ファーム側が認識するアクション名

| アクション名 | 動作 | エイリアス |
|---|---|---|
| `volume_up` | ボリューム UP | — |
| `volume_down` | ボリューム DOWN | — |
| `mode_toggle` | Fix/Volume モード切替 | `toggle_volume_adc` |
| `position_inc` | ポジション +1 | `category_next` |
| `position_dec` | ポジション -1 | `category_prev` |
| `player_inc` | プレイヤー +1 | `channel_next` |
| `player_dec` | プレイヤー -1 | `channel_prev` |
| `next_page` | 次ページ | `page_next` |
| `prev_page` | 前ページ | `previous_page`, `page_prev` |
| `display_toggle` | ディスプレイ ON/OFF | — |
| `espnow_cycle` | ESP-NOW チャンネル切替 | — |
| `goto_page:N` | N番目のページへ遷移 | — |
| `hold_page:N` | 押し続けでN番目のページ表示 | — |
| `none` | アクションなし | — |

**Studio の現在の出力アクション名はすべて認識される。変更不要。**

### JSON フォーマット

ファームが受け付ける `button_actions` の構造:

```json
"button_actions": {
  "btn_1": {
    "short_press": "prev_page",
    "long_press": "none",
    "hold": "hold_page:1"
  }
}
```

**3スロット（`short_press`, `long_press`, `hold`）すべて対応済み。**

---

## Studio 側の確認事項

### 1. 確認のみ（変更不要の見込み）

- Studio が出力する `button_actions` の JSON 構造が上記と一致しているか確認
- Studio が出力するアクション名が上記テーブルに含まれているか確認
- 新しいアクション名を追加する場合は、ファーム側の `s_action_table` に1行追加が必要（指示書で依頼）

### 2. element-registry.json との同期（任意）

ファーム側の `src/element-registry.json` の `button_ids` セクションを Studio が参照している場合:
- `necklace_v3` のボタンID は `btn_0`〜`btn_4`（レガシー命名）のままになっている
- Studio 側が `btn_1`〜`btn_5` を使っているなら、element-registry.json の命名を Studio に合わせて更新してよい（ファームのエイリアステーブルで両方認識する）

---

## 完了条件

- [ ] Studio の出力 JSON がファームで正しくパースされることを確認（既存テストまたは手動）
- [ ] 不整合があれば報告（ファーム側で対応する）
