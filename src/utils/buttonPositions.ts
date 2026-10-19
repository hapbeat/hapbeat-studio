import type { DeviceModel } from '@/types/device'

/**
 * UI-config button ids are positions as seen with the display text upright
 * (DEC-098, contracts display-layout.md「UI 設定のボタンと画面の向き」). The
 * device spec's ids name the switches in the normal orientation; with the
 * display flipped 180° the switches behind mirrored positions trade places
 * (Band left ⇄ right, Duo 3-button column top ⇄ bottom and 2-button column
 * top ⇄ bottom), the same pairs the firmware swaps.
 */
const FLIP_PAIRS: Record<DeviceModel, ReadonlyArray<readonly [string, string]>> = {
  band_wl: [['btn_l', 'btn_r']],
  duo_wl: [['btn_1', 'btn_3'], ['btn_4', 'btn_5']],
}

/** Position id shown on the switch the spec calls `specId`. */
export function positionIdAt(model: DeviceModel, specId: string, flipped: boolean): string {
  if (!flipped) return specId
  for (const [a, b] of FLIP_PAIRS[model]) {
    if (specId === a) return b
    if (specId === b) return a
  }
  return specId
}
