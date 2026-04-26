/**
 * Address position keys mirrored from the Manager's ConfigPage.
 * See `hapbeat-manager/src/hapbeat_manager/widgets/config_page.py`.
 */
export const POSITION_NAMES = [
  'pos_neck',
  'pos_chest',
  'pos_abd',
  'pos_l_arm',
  'pos_r_arm',
  'pos_l_wrist',
  'pos_r_wrist',
  'pos_hip',
  'pos_l_thigh',
  'pos_r_thigh',
  'pos_l_ankle',
  'pos_r_ankle',
] as const

export type PositionKey = typeof POSITION_NAMES[number]

/** Strip the `pos_` prefix for display. */
export function positionLabel(key: string): string {
  return key.startsWith('pos_') ? key.slice(4) : key
}

/**
 * Parse "[prefix/]player_N/pos_xxx" → { prefix, player, position }.
 *
 * Prefix may itself contain "/" (e.g. "red/alpha"), so the last two
 * segments are assumed to be `player_N` and `pos_xxx` and the rest is
 * the prefix.
 */
export function parseAddress(address: string): {
  prefix: string
  player: number
  position: string
} {
  if (!address) return { prefix: '', player: 1, position: 'pos_chest' }
  const parts = address.split('/')
  if (parts.length < 2) return { prefix: '', player: 1, position: 'pos_chest' }
  const playerStr = parts[parts.length - 2]
  const position = parts[parts.length - 1]
  const prefix = parts.slice(0, -2).join('/')
  let player = 1
  if (playerStr.startsWith('player_')) {
    const n = Number(playerStr.slice(7))
    if (Number.isFinite(n) && n > 0) player = n
  }
  return { prefix, player, position }
}

export function buildAddress(prefix: string, player: number, position: string): string {
  const tail = `player_${player}/${position}`
  return prefix.trim() ? `${prefix.trim()}/${tail}` : tail
}
