/** Hapbeat デバイスモデルの定義 */

export type DeviceModel = 'duo_wl' | 'band_wl'

/** ボタンの物理的な位置（デバイス表面の正規化座標 0-100） */
export interface ButtonPosition {
  id: string
  label: string
  x: number // 0-100 (左→右)
  y: number // 0-100 (上→下)
}

/** LED の物理的な位置 */
export interface LedPosition {
  x: number
  y: number
}

/** OLED ディスプレイの物理的な位置とサイズ */
export interface OledPosition {
  x: number
  y: number
  width: number
  height: number
}

/** デバイスモデルごとのハードウェア定義 */
export interface DeviceHardwareSpec {
  model: DeviceModel
  name: string
  description: string
  buttons: ButtonPosition[]
  led: LedPosition
  volumeIcon: LedPosition
  oled: OledPosition
  /** SVG の viewBox 用アスペクト比 (width / height) */
  aspectRatio: number
  /** デバイス外形の SVG path */
  outlinePath: string
}

/**
 * DuoWL — 五角形筐体、ボタン5個、OLED中央、LED中央下
 *
 * 頂点（左上から反時計回り）:
 *   1(左上) ──────── 5(右上)   ← 上辺水平
 *   |                |         ← 1→2, 4→5 は垂直
 *   2                4
 *    \              /          ← 2→3, 3→4 は斜め
 *      \          /
 *         3(底)               ← 底部中央 1 点
 *
 * ボタン配置 (物理位置 → GPIO):
 *   Btn1(左上,SW2,GPIO33)   Btn4(右上,SW1,GPIO47)
 *   Btn2(左中,SW4,GPIO48)   [OLED]
 *   Btn3(左下,SW3,GPIO34)   [LED]   Btn5(右下,SW0,GPIO26)
 */
export const DUO_WL_SPEC: DeviceHardwareSpec = {
  model: 'duo_wl',
  name: 'Duo WL',
  description: '五角形筐体・ボタン5個',
  buttons: [
    { id: 'btn_1', label: '1(左上)', x: 2, y: 25 },
    { id: 'btn_2', label: '2(左中)', x: 2, y: 60 },
    { id: 'btn_3', label: '3(左下)', x: 2, y: 90 },
    { id: 'btn_4', label: '4(右上)', x: 98, y: 25 },
    { id: 'btn_5', label: '5(右下)', x: 98, y: 90 },
  ],
  led: { x: 55, y: 90 },
  volumeIcon: { x: 30, y: 90 },
  oled: { x: 9, y: 40, width: 82, height: 20 },
  aspectRatio: 1.25,
  // 五角形: 上辺水平、左右辺垂直、底部が V 字
  // 頂点: 1(3,4) → 5(97,4) → 4(97,58) → 3(50,96) → 2(3,58)
  outlinePath: 'M 3,4 L 97,4 L 97,58 L 50,96 L 3,58 Z',
}

/**
 * BandWL — 長方形筐体（ストラップ付き）、ボタン3個、OLED下部左、LED下部右
 *
 * 物理配置（正面から見た向き）— ID と位置を一致させる:
 *   [btn_l] [btn_c] [btn_r]   ← 左から右へ
 *   [OLED]           [LED]
 *
 * firmware 側 (button_handler.cpp / element-registry.json) で
 *   btn_l → 物理 左 (= SW1/GPIO13, idx 1)
 *   btn_c → 物理 中 (= SW2/GPIO12, idx 2)
 *   btn_r → 物理 右 (= SW0/GPIO14, idx 0)
 * の対応になるよう同期が必要。
 */
export const BAND_WL_SPEC: DeviceHardwareSpec = {
  model: 'band_wl',
  name: 'Band WL',
  description: '長方形筐体・ボタン3個',
  buttons: [
    { id: 'btn_l', label: '左', x: 12, y: 10 },
    { id: 'btn_c', label: '中', x: 50, y: 10 },
    { id: 'btn_r', label: '右', x: 88, y: 10 },
  ],
  led: { x: 100, y: 65 },
  volumeIcon: { x: 100, y: 85 },
  oled: { x: 9, y: 50, width: 82, height: 20 },
  aspectRatio: 1.1,
  // 長方形（角丸）
  outlinePath: 'M 8,5 L 92,5 Q 97,5 97,10 L 97,90 Q 97,95 92,95 L 8,95 Q 3,95 3,90 L 3,10 Q 3,5 8,5 Z',
}

/** モデル名からスペックを取得 */
export const DEVICE_SPECS: Record<DeviceModel, DeviceHardwareSpec> = {
  duo_wl: DUO_WL_SPEC,
  band_wl: BAND_WL_SPEC,
}
