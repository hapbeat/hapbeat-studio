/**
 * LED 輝度の段階 (step) ⇄ raw uint8 (0-255) 変換ユーティリティ。
 *
 * gamma 1.8 + min=2 で生成したテーブルを LED 設定モーダル / UI 設定モーダル
 * (Hold feedback brightness) で共有する。両者で同じ感覚で輝度を選べる。
 *
 * 表 (steps=10):
 *   step:  0  1  2  3   4   5   6   7    8    9    10
 *   raw:   0  2  5  17  35  59  89  123  162  206  255
 *   delta:    +2 +3 +12 +18 +24 +30 +34  +39  +44  +49
 */

export const BRIGHTNESS_STEPS = 10
const BRIGHTNESS_MIN = 2
const BRIGHTNESS_GAMMA = 1.8

function buildBrightnessTable(steps: number): number[] {
  const table = [0]
  for (let i = 1; i <= steps; i++) {
    const t = (i - 1) / (steps - 1)
    const raw = Math.round(255 * Math.pow(t, BRIGHTNESS_GAMMA))
    table.push(Math.max(BRIGHTNESS_MIN, raw))
  }
  table[steps] = 255
  return table
}

export const BRIGHTNESS_TABLE = buildBrightnessTable(BRIGHTNESS_STEPS)

export function rawToStep(raw: number): number {
  let best = 0
  let bestDist = Math.abs(raw - BRIGHTNESS_TABLE[0])
  for (let i = 1; i < BRIGHTNESS_TABLE.length; i++) {
    const d = Math.abs(raw - BRIGHTNESS_TABLE[i])
    if (d < bestDist) { best = i; bestDist = d }
  }
  return best
}

export function stepToRaw(step: number): number {
  return BRIGHTNESS_TABLE[Math.max(0, Math.min(step, BRIGHTNESS_STEPS))]
}
