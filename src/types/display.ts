import type { DeviceModel } from './device'

export interface DisplayElement {
  id: string
  type: DisplayElementType
  pos: [number, number]  // [col, row]
  variant?: 'standard' | 'compact' | 'bar' | 'wide'
  font_scale?: 1 | 2
}

export type DisplayElementType =
  | 'volume'
  | 'volume_mode'
  | 'battery'
  | 'wifi_status'
  | 'wifi_ssid'
  | 'connection_status'
  | 'ip_address'
  | 'firmware_version'
  | 'device_name'
  | 'app_name'
  | 'player_number'
  | 'position'
  | 'page_indicator'
  | 'group_id'
  | 'address'

export interface DisplayPage {
  name: string
  elements: DisplayElement[]
}

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
  | 'group_inc'
  | 'group_dec'
  | 'volume_up'
  | 'volume_down'
  | 'wifi_select'

/** Hold 動作モード: momentary=離したら戻す, latch=1回押しと同じ */
export type HoldMode = 'momentary' | 'latch'

export interface SingleButtonAction {
  short_press: ButtonActionType
  long_press: ButtonActionType
  hold?: ButtonActionType
  hold_mode?: HoldMode
}

export type PerButtonActions = Record<string, SingleButtonAction>

export interface ButtonAction {
  short_press: ButtonActionType
  long_press: ButtonActionType
  hold?: ButtonActionType
  hold_mode?: HoldMode
}

export type DisplayOrientation = 'normal' | 'flipped'

export interface DisplayLayout {
  grid: [number, number]
  pages: DisplayPage[]
  buttons: ButtonAction
  deviceModel?: DeviceModel
  perButtonActions?: PerButtonActions
  orientation?: DisplayOrientation
}

export interface DisplayTemplate {
  name: string
  description: string
  layout: DisplayLayout
}

/** 1 ページ分のプリセット。既存レイアウトに追加・差替するための単位。 */
export interface PagePreset {
  name: string
  description: string
  page: DisplayPage
}

export interface DisplayElementMeta {
  type: DisplayElementType
  variant?: 'standard' | 'compact' | 'bar' | 'wide'
  label: string
  description: string
  icon: string
}

// ========================================
// LED 設定
// ========================================

export type LedCondition =
  | 'battery_critical'
  | 'battery_low'
  | 'wifi_disconnected'
  | 'volume_mute'
  | 'app_connected'
  | 'idle_wifi'

/**
 * UI 上のグループ分け。
 * - `warning`: 優先度が高く、他のルールより前に発火する例外状態 (バッテリー / Wi-Fi 切断 / ミュート)
 * - `state`: 通常運用での状態遷移 (待機 ⇄ アプリ接続中)
 *
 * `idle_fix` / `idle_volume` (mode) や `always` (fallback) は 2026-05-08 に
 * 削除した。Wi-Fi 接続中はほぼ表示されない条件のため、Studio 上で扱う
 * 価値が薄かった。ESP-NOW のみで動作させるユースケースが立ち上がった
 * 段階で再導入する想定。
 */
export type LedConditionGroup = 'warning' | 'state'

export interface LedRule {
  id: string
  condition: LedCondition
  enabled: boolean
  color: [number, number, number]
  /** Per-rule brightness override (0-255). undefined = use globalBrightness */
  brightness?: number
  blink_sec: number
  fade: boolean
  priority: number
}

export interface LedConfig {
  /** Global brightness applied to all rules (0-255). Per-rule brightness overrides this. */
  globalBrightness: number
  rules: LedRule[]
}

export interface LedConditionMeta {
  condition: LedCondition
  label: string
  description: string
  group: LedConditionGroup
}

export const LED_CONDITION_METAS: LedConditionMeta[] = [
  // 警告 (priority 高、常に最優先で発火)
  { condition: 'battery_critical',  label: 'バッテリー危険',  description: '残量 ≤5%、間もなく停止',         group: 'warning' },
  { condition: 'battery_low',       label: 'バッテリー低下',  description: '残量 ≤15%、充電推奨',             group: 'warning' },
  { condition: 'wifi_disconnected', label: 'Wi-Fi 未接続',    description: '設定済みなのに未接続',           group: 'warning' },
  { condition: 'volume_mute',       label: '音量ミュート',    description: '音量 = 0、振動しない',           group: 'warning' },
  // 状態遷移: 待機 ⇄ アプリ接続中
  { condition: 'idle_wifi',         label: '待機',             description: 'Wi-Fi 接続済み・アプリ非接続',   group: 'state' },
  { condition: 'app_connected',     label: 'アプリ接続中',     description: 'アプリから CONNECT_STATUS 受信中', group: 'state' },
]

export const DEFAULT_LED_RULES: LedRule[] = [
  { id: 'battery_critical',  condition: 'battery_critical',  enabled: true, color: [255, 0, 0],   blink_sec: 0.5, fade: false, priority: 1 },
  { id: 'battery_low',       condition: 'battery_low',       enabled: true, color: [255, 120, 0], blink_sec: 2,   fade: true,  priority: 2 },
  { id: 'wifi_disconnected', condition: 'wifi_disconnected', enabled: true, color: [255, 200, 0], blink_sec: 1,   fade: false, priority: 3 },
  { id: 'volume_mute',       condition: 'volume_mute',       enabled: true, color: [180, 0, 255], blink_sec: 0,   fade: false, priority: 4 },
  { id: 'idle_wifi',         condition: 'idle_wifi',         enabled: true, color: [0, 60, 0],    blink_sec: 0,   fade: false, priority: 5 },
  { id: 'app_connected',     condition: 'app_connected',     enabled: true, color: [0, 0, 80],    blink_sec: 2,   fade: true,  priority: 6 },
]

// ========================================
// Volume 設定
// ========================================

export type VolumeDirection = 'ascending' | 'descending'

export interface VolumeConfig {
  steps: number
  direction: VolumeDirection
  default_level: number
}

export const DEFAULT_VOLUME_CONFIG: VolumeConfig = {
  steps: 24,
  direction: 'ascending',
  default_level: 12,
}

// ========================================
// その他 UI 設定 (OLED 輝度 / Hold 時間)
// ========================================

/**
 * Studio の "UI 設定" モーダルにまとめている本体側 UI パラメータ。
 *
 * Hold タイミングは 3 段階で制御する:
 *
 *   t=0                        press 開始 (LED は通常の rule 色)
 *   t=hold_feedback_start_ms    LED が hold_feedback_color に切替、最大輝度
 *                              (= hold_feedback_brightness) からスタート
 *   t=hold_ms                  線形に 0 まで減衰 → hold アクション発火
 *
 * `hold_feedback_start_ms` < `hold_ms` を必ず満たすこと。
 *
 * 発火予告は **指定色の輝度を線形にフェードアウト** することで表現する。
 *   - 進捗が連続的に分かる (徐々に暗くなる)
 *   - 0 (= 完全消灯) で発火する瞬間に明確な区切りができる
 *   - 色は LED rule とは別系統で固定指定 (hold 中だと一目で分かる)
 *   - 輝度は別軸で調整可能 (LED 設定の global brightness とは独立)
 *
 * - `oled_brightness`: 1=Low / 2=Mid / 3=High。
 * - `hold_ms`: 発火時間 (default 1000)。
 * - `hold_feedback_start_ms`: 色切替 + 輝度減衰開始時刻 (default 300)。
 * - `hold_feedback_color`: 切替時の色 (default `[0, 255, 255]` = 純 cyan)。
 *   raw RGB 値で持つが、実際の出力は brightness で scale される。
 * - `hold_feedback_brightness`: 切替直後の輝度 (raw 0-255、default 30 ≈ 12%)。
 *   LED 設定の global brightness とは独立。デバイスが顔の近くにある前提で
 *   控えめのデフォルトにしてある。
 * - `hold_show_oled_indicator`: hold 待機中 OLED に "Hold..." を出すか
 *   (default false — 短押し時の pos/group 切替表示を遮らないため)。
 */
export interface UiSettings {
  oled_brightness: 1 | 2 | 3
  hold_ms: number
  hold_feedback_start_ms: number
  hold_feedback_color: [number, number, number]
  hold_feedback_brightness: number
  hold_show_oled_indicator: boolean
}

export const DEFAULT_UI_SETTINGS: UiSettings = {
  oled_brightness: 2,
  hold_ms: 1000,
  hold_feedback_start_ms: 300,
  hold_feedback_color: [0, 255, 255],   // 純 cyan (brightness で scale される)
  hold_feedback_brightness: 30,         // raw 0-255、default ≈ 12%
  hold_show_oled_indicator: false,
}

/**
 * 要素の幅 = 文字数（1セル = 1文字 = 8px）
 *
 * OLED: 128x32px, フォント: 8x16px (ASCII)
 * → 16文字/行 × 2行
 * → font_scale=2 → 16x32px → 8文字/行 × 1行
 *
 * [幅, 高さ] = [文字数, 行数]
 * 各要素の幅はプレビュー文字列の文字数と完全一致させること
 */
export const ELEMENT_FIXED_SIZES: Record<DisplayElementType, [number, number]> = {
  volume: [6, 1],            // "vol:05"    6文字
  volume_mode: [3, 1],       // "Fix"/"Var" 3文字
  battery: [4, 1],           // " 85%"      4文字 (数値%表示, standard)
  wifi_status: [5, 1],       // "W:---"     5文字 (standard), compact 同
  wifi_ssid: [8, 1],         // "MySSID__"  標準 8文字 (compact=4, wide=16)
  connection_status: [4, 1], // "[--]"      4文字 (compact), standard "[OK]App_" 8文字
  ip_address: [6, 1],        // ".0.147"   標準 6文字 (compact=4, wide=13)。
                             // 同 LAN は前半オクテットが被るため右から N 文字切出し
                             // (3rd オクテットも被ることが多いので standard は 6 で十分)
  firmware_version: [8, 1],  // " v0.1.0" 標準 8文字 (compact=6)。
                             // device は左 truncate / 右 pad で width に追従。
  device_name: [6, 1],       // "DuoWL2"    6文字, compact 3文字
  app_name: [8, 1],          // "MyApp__"   標準 8文字 (compact=4, wide=16)
  player_number: [4, 1],     // "P:01"      4文字
  position: [8, 1],          // "pos:neck"  標準 8文字 (compact=4, wide=16)。
                             // 数値ではなく NVS の pos_xxx 名を表示
  page_indicator: [3, 1],    // "1/2"       3文字
  group_id: [4, 1],          // "Gr:1"      4文字
  address: [8, 1],           // "prefix__"  標準 8文字 (compact=4, wide=16)。
                             // 表示は address の prefix 部分のみ
                             // (player_/pos は別要素として持つため重複させない)
}

/** Get element size considering variant. Battery "bar" variant is wider. */
export function getElementSize(type: DisplayElementType, variant?: string): [number, number] {
  if (type === 'battery' && variant === 'bar') return [8, 1] // "BAT[||||]" 8文字
  if (type === 'app_name') {
    // app_name は 3 サイズ展開:
    //   compact = 4 文字 (短いプロジェクト名)
    //   standard (default) = 8 文字
    //   wide = 16 文字 (行全体)
    if (variant === 'compact') return [4, 1]
    if (variant === 'wide') return [16, 1]
    return [8, 1]
  }
  if (type === 'address') {
    // address は prefix (player_ より前の部分) のみ表示。3 サイズ展開:
    //   compact = 4 文字 / standard (default) = 8 文字 / wide = 16 文字
    if (variant === 'compact') return [4, 1]
    if (variant === 'wide') return [16, 1]
    return [8, 1]
  }
  if (type === 'wifi_ssid') {
    // SSID は左から N 文字。4/8/16 の 3 サイズ展開。
    if (variant === 'compact') return [4, 1]
    if (variant === 'wide') return [16, 1]
    return [8, 1]
  }
  if (type === 'ip_address') {
    // IP は右から N 文字 (同 LAN は前半オクテットが被るので右側ほど重要)。
    // compact=4 (".147"), standard=6 (".0.147"), wide=13 (フル IP).
    if (variant === 'compact') return [4, 1]
    if (variant === 'wide') return [13, 1]
    return [6, 1]
  }
  if (type === 'position') {
    // pos_xxx 名を表示。標準=8 (e.g. "pos:neck"), compact=4 (名前のみ),
    // wide=16 (フル prefix 付き)。
    if (variant === 'compact') return [4, 1]
    if (variant === 'wide') return [16, 1]
    return [8, 1]
  }
  if (type === 'firmware_version') {
    // 'v0.1.0' (= 6 文字) が基本で 8 文字なら左 pad で右寄せ。
    // wide は不要 (semver 以上の長さは想定しない)。
    if (variant === 'compact') return [6, 1]
    return [8, 1]
  }
  return ELEMENT_FIXED_SIZES[type]
}
