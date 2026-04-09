import type { DeviceModel } from './device'

export interface DisplayElement {
  id: string
  type: DisplayElementType
  pos: [number, number]  // [col, row]
  variant?: 'standard' | 'compact' | 'bar'
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
  | 'gain'
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
  | 'position_inc'
  | 'position_dec'

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

export interface DisplayElementMeta {
  type: DisplayElementType
  variant?: 'standard' | 'compact' | 'bar'
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
  | 'idle_espnow'
  | 'idle_fix'
  | 'idle_volume'
  | 'always'

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
}

export const LED_CONDITION_METAS: LedConditionMeta[] = [
  { condition: 'battery_critical', label: 'バッテリー危険', description: '残量 ≤5%、間もなく停止' },
  { condition: 'battery_low', label: 'バッテリー低下', description: '残量 ≤15%、充電推奨' },
  { condition: 'wifi_disconnected', label: 'Wi-Fi 未接続', description: '設定済みなのに未接続' },
  { condition: 'volume_mute', label: '音量ミュート', description: '音量 = 0、振動しない' },
  { condition: 'app_connected', label: 'アプリ接続中', description: '正常動作中' },
  { condition: 'idle_wifi', label: '待機 (Wi-Fi)', description: 'Wi-Fi 接続済み・待機' },
  { condition: 'idle_espnow', label: '待機 (ESP-NOW)', description: 'ESP-NOW のみ' },
  { condition: 'idle_fix', label: '待機 (Fix)', description: 'Fix モード' },
  { condition: 'idle_volume', label: '待機 (Volume)', description: 'Volume モード' },
  { condition: 'always', label: 'フォールバック', description: '他の条件に該当しない場合' },
]

export const DEFAULT_LED_RULES: LedRule[] = [
  { id: 'battery_critical', condition: 'battery_critical', enabled: true, color: [255, 0, 0], blink_sec: 0.5, fade: false, priority: 1 },
  { id: 'battery_low', condition: 'battery_low', enabled: true, color: [255, 120, 0], blink_sec: 2, fade: true, priority: 2 },
  { id: 'wifi_disconnected', condition: 'wifi_disconnected', enabled: true, color: [255, 200, 0], blink_sec: 1, fade: false, priority: 3 },
  { id: 'volume_mute', condition: 'volume_mute', enabled: true, color: [180, 0, 255], blink_sec: 0, fade: false, priority: 4 },
  { id: 'app_connected', condition: 'app_connected', enabled: true, color: [0, 0, 80], blink_sec: 2, fade: true, priority: 5 },
  { id: 'idle_wifi', condition: 'idle_wifi', enabled: true, color: [0, 60, 0], blink_sec: 0, fade: false, priority: 6 },
  { id: 'idle_espnow', condition: 'idle_espnow', enabled: true, color: [0, 50, 50], blink_sec: 0, fade: false, priority: 7 },
  { id: 'idle_fix', condition: 'idle_fix', enabled: true, color: [5, 5, 5], blink_sec: 0, fade: false, priority: 8 },
  { id: 'idle_volume', condition: 'idle_volume', enabled: true, color: [0, 0, 5], blink_sec: 0, fade: false, priority: 9 },
  { id: 'always', condition: 'always', enabled: true, color: [0, 0, 0], blink_sec: 0, fade: false, priority: 10 },
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
  wifi_ssid: [8, 1],         // "MySSID__"  最大8文字
  connection_status: [4, 1], // "[--]"      4文字 (compact), standard "[OK]App_" 8文字
  ip_address: [15, 1],       // "192.168.1.100" 最大15文字, compact ".1.100" 6文字
  firmware_version: [3, 1],  // "FW3"       3文字
  device_name: [6, 1],       // "DuoWL2"    6文字, compact 3文字
  gain: [4, 1],              // "G:12"      4文字
  player_number: [4, 1],     // "P:01"      4文字
  position: [7, 1],          // "Pos:001"   7文字
  page_indicator: [3, 1],    // "1/2"       3文字
  group_id: [4, 1],          // "Gr:1"      4文字
  address: [10, 1],          // "p1/pos_nck" 10文字, compact 7文字
}

/** Get element size considering variant. Battery "bar" variant is wider. */
export function getElementSize(type: DisplayElementType, variant?: string): [number, number] {
  if (type === 'battery' && variant === 'bar') return [8, 1] // "BAT[||||]" 8文字
  return ELEMENT_FIXED_SIZES[type]
}
