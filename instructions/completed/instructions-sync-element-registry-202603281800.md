# Studio: element-registry.json 同期と差分修正

## 目的

ファームウェア側で `element-registry.json` を定義し、ディスプレイ要素・ボタン・LED・Volume の仕様を一元管理した。
Studio 側の型定義とデフォルト値をファームの実態に合わせて修正する。

**element-registry.json の場所**: `hapbeat-device-firmware/src/element-registry.json`

---

## 差分一覧

### 1. DisplayElementType に `channel` が不足

**ファーム側**: `channel` 要素が存在する（`CH_0` 表示、default_size [4,1]）
**Studio 側**: `DisplayElementType` に `channel` がない

**修正**: `src/types/display.ts`

```typescript
export type DisplayElementType =
  | 'channel'              // ★ 追加
  | 'volume'
  | 'battery'
  // ... (既存そのまま)
```

`ELEMENT_FIXED_SIZES` にも追加:
```typescript
channel: [4, 1],
```

`ElementPalette.tsx` にも `channel` のメタ情報を追加:
```typescript
{ type: 'channel', label: 'チャンネル', description: 'CH番号', icon: '📺' }
```

---

### 2. DisplayElementType に `custom_text` が不足

**ファーム側**: `custom_text` 要素が存在する（任意テキスト表示、default_size [4,1]）
**Studio 側**: `DisplayElementType` に `custom_text` がない

**修正**: `DisplayElementType` と `ELEMENT_FIXED_SIZES` に追加:
```typescript
| 'custom_text'
```
```typescript
custom_text: [4, 1],
```

`ElementPalette.tsx` にもメタ情報追加。custom_text は配置時に text プロパティの入力が必要。

---

### 3. DisplayElement に variant と font_scale が不足

**ファーム側**: `DisplayElement` に `variant`(0=standard, 1=compact) と `font_scale`(1 or 2) がある
**Studio 側**: `DisplayElement` に `variant` と `font_scale` がない

**修正**: `src/types/display.ts`

```typescript
export interface DisplayElement {
  id: string
  type: DisplayElementType
  pos: [number, number]
  variant?: 'standard' | 'compact'  // ★ 追加
  font_scale?: 1 | 2               // ★ 追加
  text?: string                     // ★ 追加（custom_text 用）
}
```

compact バリアントが使える要素（element-registry.json の variants に compact がある要素）:
- `wifi_status`, `connection_status`, `ip_address`, `firmware_version`, `device_name`

---

### 4. ButtonActionType の差分

**ファーム側が対応しているアクション**:
| アクション名 | ファーム対応 | Studio 定義 |
|---|---|---|
| `none` | ✅ | ✅ |
| `next_page` | ✅ | ✅ |
| `prev_page` | ✅ (`previous_page` もエイリアスとして対応) | ✅ |
| `volume_up` | ✅ | ❌ 不足 |
| `volume_down` | ✅ | ❌ 不足 |
| `mode_toggle` | ✅ (`toggle_volume_adc` もエイリアス) | ✅ (`toggle_volume_adc` として) |
| `player_inc` | ✅ | ✅ |
| `player_dec` | ✅ | ✅ |
| `position_inc` | ✅ | ✅ |
| `position_dec` | ✅ | ✅ |
| `display_toggle` | ✅ | ❌ 不足 |
| `goto_page` | ❌ ファーム未対応 | ✅ Studio にある |

**修正**: `src/types/display.ts`

```typescript
export type ButtonActionType =
  | 'none'
  | 'next_page'
  | 'prev_page'
  | 'volume_up'          // ★ 追加
  | 'volume_down'        // ★ 追加
  | 'mode_toggle'        // ★ 追加（toggle_volume_adc のエイリアス）
  | 'display_toggle'     // ★ 追加
  | 'player_inc'
  | 'player_dec'
  | 'position_inc'
  | 'position_dec'
  // 'goto_page' は削除（ファーム未対応）
  // 'toggle_volume_adc' は 'mode_toggle' に統一
```

**注意**: `toggle_volume_adc` はファーム側で `mode_toggle` のエイリアスとして処理されるが、Studio 側は `mode_toggle` に統一する。既存データの `toggle_volume_adc` は `displayLayoutIO.ts` のインポート時に `mode_toggle` に変換する。

---

### 5. LedCondition の差分

**ファーム側が対応している条件**:
| 条件名 | ファーム対応 | Studio 定義 |
|---|---|---|
| `battery_critical` | ✅ | ✅ |
| `battery_low` | ✅ | ✅ |
| `wifi_disconnected` | ✅ | ✅ |
| `volume_mute` | ✅ | ✅ |
| `app_connected` | ✅ | ✅ |
| `idle_wifi` | ✅ | ❌ 不足 |
| `idle_espnow` | ✅ | ❌ 不足 |
| `idle_fix` | ✅ | ❌ 不足 |
| `idle_volume` | ✅ | ❌ 不足 |
| `always` | ✅ | ❌ 不足 |
| `internal_error` | ❌ ファーム未対応 | ✅ Studio にある |
| `idle` | ❌ ファーム未対応（idle_wifi/fix/volume に分割） | ✅ Studio にある |

**修正**: `src/types/display.ts`

```typescript
export type LedCondition =
  | 'battery_critical'
  | 'battery_low'
  | 'wifi_disconnected'
  | 'volume_mute'
  | 'app_connected'
  | 'idle_wifi'          // ★ 追加（Wi-Fi接続済み待機）
  | 'idle_espnow'       // ★ 追加（ESP-NOW のみ待機）
  | 'idle_fix'           // ★ 追加（Fix モード待機）
  | 'idle_volume'        // ★ 追加（Volume モード待機）
  | 'always'             // ★ 追加（フォールバック）
  // 'internal_error' 削除（ファーム未対応）
  // 'idle' 削除（idle_wifi/idle_fix/idle_volume に分割）
```

`LED_CONDITION_METAS` と `DEFAULT_LED_RULES` も同様に更新。
element-registry.json の `led_conditions` セクションにデフォルト値が定義済み。

---

### 6. VolumeConfig のデフォルト値の差分

**ファーム側デフォルト**: steps=24, default_level=12
**Studio 側デフォルト**: steps=10, default_level=5

**修正**: `src/types/display.ts`

```typescript
export const DEFAULT_VOLUME_CONFIG: VolumeConfig = {
  steps: 24,          // ★ 10 → 24 に変更
  direction: 'ascending',
  default_level: 12,  // ★ 5 → 12 に変更
}
```

---

### 7. displayLayoutIO.ts のファームフォーマット変換

`toFirmwareFormat()` と `fromFirmwareFormat()` を以下に対応させる:

- `channel`, `custom_text` 要素の変換
- `variant` フィールド: Studio の `'standard'|'compact'` → ファームの省略 or `"variant": "compact"`
- `font_scale` フィールド: `1|2` → ファームの `"font_scale": 2`（1 は省略可）
- `text` フィールド: `custom_text` 要素のテキスト
- `mode_toggle` ↔ `toggle_volume_adc` の変換
- LED conditions の新旧マッピング（`idle` → `idle_wifi` へのマイグレーション）

---

### 8. element-registry.json の将来的な直接参照（推奨）

現在はハードコードで定義を二重管理している。将来的には:

```typescript
import registry from '../../hapbeat-device-firmware/src/element-registry.json'

// ELEMENT_FIXED_SIZES を registry.elements から自動生成
// LED_CONDITION_METAS を registry.led_conditions から自動生成
// ButtonActionType を registry.button_actions から自動生成
```

ただし、これはビルド設定の変更（Vite alias or symlink）が必要なため、今回は手動同期で対応し、将来タスクとする。

---

## ファームウェア側の起動時適用順序（重要）

修正済みの起動フロー:

```
1. buttonInit()          ← ハードウェアデフォルトアクション設定
2. displayInit()         ← OLED 初期化
3. ui-config.json あり?
   → YES: applyUiConfig()  ← Studio 設定で上書き（最終勝者）★
   → NO:  uiConfigApply()  ← 旧 ui.json フォールバック
```

**以前の問題**: `applyUiConfig()` が `buttonInit()` の**前**に呼ばれていたため、Studio で設定したボタンアクションがデフォルトで上書きされていた。**修正済み**。

---

## TCP コマンド仕様（Manager 連携）

Studio → Manager → Device のフロー:

```
Studio → WebSocket ws://localhost:7703
  { type: "write_ui_config", payload: { config: {...} } }

Manager → TCP 7701
  { "cmd": "write_ui_config", "config": {...} }

Device 応答:
  { "status": "ok", "message": "ui config saved and applied" }
```

config オブジェクトの構造:
```json
{
  "display": {
    "pages": [...],
    "button_actions": { "btn_up": { "short_press": "volume_up", ... }, ... },
    "show_page_indicator": false
  },
  "led": {
    "rules": [
      { "id": "...", "condition": "...", "enabled": true, "color": [R,G,B], "blink_sec": 0, "fade": false, "priority": 1 }
    ]
  },
  "volume": {
    "steps": 24,
    "direction": "ascending",
    "default_level": 12
  }
}
```

削除コマンド（デフォルトに戻す）:
```json
{ "cmd": "delete_ui_config" }
```

---

## テスト手順

1. Studio で channel 要素をページに配置 → ファームの OLED に `CH_0` が表示
2. Studio でボタン btn_0 に `next_page` を設定 → デバイスのボタン 0 でページ切替
3. Studio で LED の `idle_fix` 条件の色を変更 → デバイスの LED が反映
4. Studio で Volume steps を 10 に変更 → デバイスのボリュームが 10 段になる
5. デバイス再起動後も設定が維持されることを確認

---

## 変更対象ファイル一覧

| ファイル | 変更内容 |
|---------|---------|
| `src/types/display.ts` | DisplayElementType に channel/custom_text 追加、DisplayElement に variant/font_scale/text 追加、ButtonActionType 修正、LedCondition 修正、VolumeConfig デフォルト修正 |
| `src/components/common/ElementPalette.tsx` | channel/custom_text のメタ情報追加 |
| `src/utils/displayLayoutIO.ts` | variant/font_scale/text のシリアライズ、アクション名マッピング修正 |
| `src/components/display/LedConfigModal.tsx` | 新条件の UI 対応 |
