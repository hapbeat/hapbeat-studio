import type {
  DisplayTemplate, PagePreset, DisplayPage,
  PerButtonActions, LedConfig, VolumeConfig, UiSettings, DisplayOrientation,
} from '@/types/display'
import type { DeviceModel } from '@/types/device'
import type { MessageId } from '@/i18n/messages'

/**
 * テンプレート定義
 *
 * 二段構え:
 *   - fullLayouts: 全レイアウト (= 全 page + buttons) を一括適用。新規 / リセット用。
 *   - pagePresets: 1 ページだけ既存レイアウトに追加・差替。微調整用。
 *
 * OLED: 128x32px = 16文字 × 2行 グリッド
 * 各要素のサイズ:
 *   volume: 6, volume_mode: 3, battery(%): 4, battery(bar): 8,
 *   wifi_status: 5, connection_status: 4, player_number: 4,
 *   position: 7 (variant 4/8/16), device_name: 5 (variant 4/5/16),
 *   firmware_version: 6 (variant 6/8), ip_address: 6 (variant 4/6/13),
 *   page_indicator: 3, group_id: 5, address: 8 (variant 4/8/16),
 *   app_name: 8 (variant 4/8/16), wifi_ssid: 8 (variant 4/8/16)
 *
 * 初期状態は 2026-05-09 にユーザー提供 JSON
 * (Downloads/ui-config_20260508_173158.json) を baseline に再構成し、
 * 2026-10-19 に Band を main（バンド）/ exhibit に変更:
 *   Duo: main（ネック）/ exhibit / debug の 3 ページ
 *   Band: main（バンド）/ exhibit の 2 ページ
 */

// ========================================
// Page presets (1 ページ単位)
// ========================================

/** main（ネック）: Duo の主表示。デバイス名 + プレイヤー/グループ + 残量 + Var/Fix + 音量 */
const mainNeckPage: DisplayPage = {
  name: 'main',
  elements: [
    { id: 'el-name',   type: 'device_name',   pos: [0, 0] },                          // 5 chars (standard)
    { id: 'el-player', type: 'player_number', pos: [6, 0] },                          // 4 chars
    { id: 'el-group',  type: 'group_id',      pos: [11, 0] },                         // 5 chars
    { id: 'el-bat',    type: 'battery',       pos: [0, 1] },                          // 4 chars (% — variant 未指定)
    { id: 'el-mode',   type: 'volume_mode',   pos: [6, 1] },                          // 3 chars
    { id: 'el-vol',    type: 'volume',        pos: [10, 1] },                         // 6 chars
  ],
}

/** main（バンド）: Band の主表示。main（ネック）の Var/Fix の代わりに装着位置を出す。
 *  2026-10-19 ユーザーが Band で使っている main (ui-config_20261019_183802.json の page_0) 由来。 */
const mainBandPage: DisplayPage = {
  name: 'main',
  elements: [
    { id: 'el-name',   type: 'device_name',   pos: [0, 0] },                          // 5 chars (standard)
    { id: 'el-player', type: 'player_number', pos: [6, 0] },                          // 4 chars
    { id: 'el-group',  type: 'group_id',      pos: [11, 0] },                         // 5 chars
    { id: 'el-bat',    type: 'battery',       pos: [0, 1] },                          // 4 chars (% — variant 未指定)
    { id: 'el-pos',    type: 'position',      pos: [5, 1],  variant: 'compact' },     // 4 chars
    { id: 'el-vol',    type: 'volume',        pos: [10, 1] },                         // 6 chars
  ],
}

/** exhibit: 展示・本番運用中にユーザーへ装着して見せる用。
 *  プレイヤー番号 / グループ ID と接続中アプリ名 (compact) を強調。 */
const exhibitPage: DisplayPage = {
  name: 'exhibit',
  elements: [
    { id: 'el-addr',   type: 'address',       pos: [0, 0],  variant: 'compact' },     // 4 chars
    { id: 'el-player', type: 'player_number', pos: [5, 0] },                          // 4 chars
    { id: 'el-group',  type: 'group_id',      pos: [10, 0] },                         // 5 chars
    { id: 'el-app',    type: 'app_name',      pos: [0, 1],  variant: 'compact' },     // 4 chars
    { id: 'el-bat',    type: 'battery',       pos: [5, 1] },                          // 4 chars
    { id: 'el-vol',    type: 'volume',        pos: [10, 1] },                         // 6 chars
  ],
}

/** debug: ネットワーク / 装着位置 / FW / IP の整備員視点ページ。 */
const debugPage: DisplayPage = {
  name: 'debug',
  elements: [
    { id: 'el-ssid',   type: 'wifi_ssid',        pos: [0, 0],  variant: 'wide' },     // 16 chars
    { id: 'el-pos',    type: 'position',         pos: [0, 1],  variant: 'compact' },  // 4 chars
    { id: 'el-ip',     type: 'ip_address',       pos: [5, 1],  variant: 'compact' },  // 4 chars
    { id: 'el-fw',     type: 'firmware_version', pos: [10, 1], variant: 'compact' },  // 6 chars
  ],
}

/** プリセットのメニュー項目。`name` は一意な id、メニューの表示名は `labelKey`
 *  (i18n)、挿入するページの名前は `page.name` (main は両方とも 'main')。 */
export interface PagePresetEntry extends PagePreset {
  labelKey: MessageId
}

/**
 * Insert preset メニューに出すページの一覧。Band / Duo で共通
 * (2026-10-19 ユーザー決定。Band でも exhibit を使いたいため、2026-05-09 の
 * 「Band には exhibit を出さない」機種別一覧を置き換えた)。
 * main だけは機種で中身が違うので、main（バンド）と main（ネック）の 2 つに分ける。
 *
 * empty は意図的に除外 (= 「+ Page」ボタンで空ページ追加できるので preset に
 * 出す必要がない、2026-05-09 ユーザ要望)。
 */
export const pagePresets: PagePresetEntry[] = [
  { name: 'main_band', labelKey: 'display.presetMainBand',
    description: 'バンド型の主表示 (装着位置 + 番号 + 音量)', page: mainBandPage },
  { name: 'main_neck', labelKey: 'display.presetMainNeck',
    description: 'ネック型の主表示 (Var/Fix + 番号 + 音量)', page: mainNeckPage },
  { name: 'exhibit', labelKey: 'display.presetExhibit',
    description: '展示・本番中ユーザー装着時用 (App名 + 番号)', page: exhibitPage },
  { name: 'debug', labelKey: 'display.presetDebug',
    description: 'ネットワーク / 位置 / IP / FW (整備員向け)', page: debugPage },
]

// ========================================
// Full layout templates (全 page + buttons 上書き)
// ========================================

/** Duo (DuoWL) の出荷時レイアウト: main（ネック）/ exhibit / debug の 3 ページ。 */
export const duoStandardTemplate: DisplayTemplate = {
  name: 'Duo Standard',
  description: 'Duo: main / exhibit / debug',
  layout: {
    grid: [16, 2],
    pages: [
      structuredClone(mainNeckPage),
      structuredClone(exhibitPage),
      structuredClone(debugPage),
    ],
    buttons: { short_press: 'next_page', long_press: 'none' },
  },
}

/** Band (BandWL) の出荷時レイアウト: main（バンド）/ exhibit の 2 ページ
 *  (2026-10-19 ユーザー決定で debug を exhibit に替えた)。中央の短押し
 *  (toggle_page) で 2 ページを行き来する。 */
export const bandStandardTemplate: DisplayTemplate = {
  name: 'Band Standard',
  description: 'Band: main / exhibit',
  layout: {
    grid: [16, 2],
    pages: [
      structuredClone(mainBandPage),
      structuredClone(exhibitPage),
    ],
    buttons: { short_press: 'next_page', long_press: 'none' },
  },
}

export const allTemplates: DisplayTemplate[] = [duoStandardTemplate, bandStandardTemplate]

// ========================================
// 初期状態 (= 工場出荷 / リセット時に適用される完全な state)
// ========================================
//
// 2026-05-09 ユーザ提供 JSON (Downloads/ui-config_20260508_173158.json) を
// baseline に再構成。display 以外 (= ボタン / LED / volume / UI) も含めた
// **完全な初期 state** を 1 箇所で定義する。
//
// この constant を:
//   - DisplayEditor の初回 useState 既定値
//   - 「初期化」ボタン (handleResetToDefault)
// の双方が使うことで「初期化を押せば工場出荷に戻る」という単純な保証を作る。
//
// 重要: page presets (Insert preset メニュー) は **display 専用** (= ページ
// レイアウトのみ) で、ここに含む button / LED / volume / UI は触らない
// (ユーザ要望)。

/** Duo (5 ボタン) の出荷時 button action 既定。JSON 由来:
 *  - btn_1: short=player_inc, long=none, hold=prev_page (latch)
 *  - btn_2: short=vib_mode,   long=none, hold=wifi_select (latch)
 *  - btn_3: short=player_dec, long=none, hold=led_toggle (latch)
 *  - btn_4: short=group_inc,  long=none, hold=next_page (latch)
 *  - btn_5: short=group_dec,  long=none, hold=display_toggle (latch)
 *  Tmp/Latch 独立保持構造のため、hold_mode='latch' の場合は値を hold_latch に
 *  入れる (hold_tmp は 'none')。 */
const INITIAL_BUTTON_ACTIONS_DUO: PerButtonActions = {
  btn_1: { short_press: 'player_inc', long_press: 'none', hold_tmp: 'none', hold_latch: 'prev_page',      hold_mode: 'latch' },
  btn_2: { short_press: 'vib_mode',   long_press: 'none', hold_tmp: 'none', hold_latch: 'wifi_select',    hold_mode: 'latch' },
  btn_3: { short_press: 'player_dec', long_press: 'none', hold_tmp: 'none', hold_latch: 'led_toggle',     hold_mode: 'latch' },
  btn_4: { short_press: 'group_inc',  long_press: 'none', hold_tmp: 'none', hold_latch: 'next_page',      hold_mode: 'latch' },
  btn_5: { short_press: 'group_dec',  long_press: 'none', hold_tmp: 'none', hold_latch: 'display_toggle', hold_mode: 'latch' },
}

/** Band (3 ボタン) の出荷時 button action 既定。
 *  3 ボタン構成 — Duo の 5 ボタン分を当てはめられないので独自割当て:
 *  - btn_l (左): short=group_dec,   hold=volume_down  (latch) — グループ -1 / 音量 DOWN
 *  - btn_c (中): short=toggle_page, hold=wifi_select  (latch) — ページ切替 / Wi-Fi 設定
 *  - btn_r (右): short=group_inc,   hold=volume_up    (latch) — グループ +1 / 音量 UP
 *  (2026-10-15 ユーザ指示: 右 = プラス、左 = マイナス。旧既定は左右逆で
 *  2026-05-09 ユーザ提供 ui-config 061935.json 由来。左右は画面の文字が読める
 *  向きで見た位置で、出荷時の flipped でも見た目の右がプラスになる — DEC-098)
 *  player 番号変更は現場で再割当てする想定。 */
const INITIAL_BUTTON_ACTIONS_BAND: PerButtonActions = {
  btn_l: { short_press: 'group_dec',   long_press: 'none', hold_tmp: 'none', hold_latch: 'volume_down', hold_mode: 'latch' },
  btn_c: { short_press: 'toggle_page', long_press: 'none', hold_tmp: 'none', hold_latch: 'wifi_select', hold_mode: 'latch' },
  btn_r: { short_press: 'group_inc',   long_press: 'none', hold_tmp: 'none', hold_latch: 'volume_up',   hold_mode: 'latch' },
}

/** 出荷時の per-button actions (Duo 5 + Band 3 を同居)。
 *  perButtonActions は単一 map で両モデルのボタン id (btn_1..5, btn_l/c/r)
 *  が共存する設計。モデル切替時に該当 id だけを参照する。 */
export const INITIAL_PER_BUTTON_ACTIONS: PerButtonActions = {
  ...INITIAL_BUTTON_ACTIONS_DUO,
  ...INITIAL_BUTTON_ACTIONS_BAND,
}

/** 出荷時の LED 設定 (JSON 由来)。global_brightness=5 は控えめ
 *  (顔のすぐ近くで使う想定で眩しすぎないため)。 */
export const INITIAL_LED_CONFIG: LedConfig = {
  globalBrightness: 5,
  rules: [
    { id: 'battery_critical',  condition: 'battery_critical',  enabled: true, color: [128,   0,   0], blink_sec: 0.5, fade: true,  priority: 1 },
    { id: 'battery_low',       condition: 'battery_low',       enabled: true, color: [255, 120,   0], blink_sec: 2,   fade: true,  priority: 2 },
    { id: 'wifi_disconnected', condition: 'wifi_disconnected', enabled: true, color: [255, 200,   0], blink_sec: 1,   fade: false, priority: 3 },
    { id: 'volume_mute',       condition: 'volume_mute',       enabled: true, color: [180,   0, 255], blink_sec: 0,   fade: false, priority: 4 },
    { id: 'app_connected',     condition: 'app_connected',     enabled: true, color: [  0,  42, 255], blink_sec: 0,   fade: false, priority: 6 },
    { id: 'idle_wifi',         condition: 'idle_wifi',         enabled: true, color: [  0, 255,   0], blink_sec: 0,   fade: false, priority: 7 },
  ],
}

/** 出荷時の volume 設定 (JSON 由来): 10 段階、昇順、初期値 5。 */
export const INITIAL_VOLUME_CONFIG: VolumeConfig = {
  steps: 10,
  direction: 'ascending',
  default_level: 5,
}

/** 出荷時の UI 設定 (JSON 由来):
 *  - oled_brightness=3 (High)
 *  - hold_ms=700 / hold_feedback_start_ms=150 → ホールド予告は 150-700ms の窓
 *  - hold_feedback_color=[255,136,0] (オレンジ)、輝度 35 (約 14%)
 *  - hold_show_oled_indicator=false (短押し時の pos/group 切替表示を遮らない) */
export const INITIAL_UI_SETTINGS: UiSettings = {
  oled_brightness: 3,
  hold_ms: 700,
  hold_feedback_start_ms: 150,
  hold_feedback_color: [255, 136, 0],
  hold_feedback_brightness: 35,
  hold_show_oled_indicator: false,
}

/** 出荷時の orientation:
 *  - Duo: normal
 *  - Band: flipped (装着時 OLED が上下逆になる物理配置のため、JSON 由来)
 */
export const INITIAL_ORIENTATION_BY_MODEL: Record<DeviceModel, DisplayOrientation> = {
  duo_wl: 'normal',
  band_wl: 'flipped',
}

/** Helper: クローン込みの初期 layoutByModel。`structuredClone` で参照を切る。 */
export function buildInitialLayoutByModel() {
  return {
    duo_wl: structuredClone(duoStandardTemplate.layout),
    band_wl: structuredClone(bandStandardTemplate.layout),
  }
}
