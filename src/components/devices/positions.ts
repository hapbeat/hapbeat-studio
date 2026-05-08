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
 * Parse "[prefix/]player_N/pos_xxx[/group_M]" → { prefix, player, position, group }.
 *
 * Prefix may itself contain "/" (e.g. "red/alpha"). 末尾の `group_<N>` は
 * 任意セグメント (contracts spec §2 改定後)。group=-1 は未指定 (suffix なし)。
 */
export function parseAddress(address: string): {
  prefix: string
  player: number
  position: string
  group: number
} {
  if (!address) return { prefix: '', player: 1, position: 'pos_chest', group: -1 }
  const parts = address.split('/')

  // 末尾が group_<N> なら抽出して parts から除く (1..99 のみ valid)
  let group = -1
  if (parts.length >= 1 && parts[parts.length - 1].startsWith('group_')) {
    const gStr = parts[parts.length - 1].slice(6)
    const gNum = Number(gStr)
    if (Number.isFinite(gNum) && gNum >= 1 && gNum <= 99) {
      group = gNum
      parts.pop()
    }
  }

  if (parts.length < 2) {
    return { prefix: '', player: 1, position: 'pos_chest', group }
  }
  const playerStr = parts[parts.length - 2]
  const position = parts[parts.length - 1]
  const prefix = parts.slice(0, -2).join('/')
  let player = 1
  if (playerStr.startsWith('player_')) {
    const n = Number(playerStr.slice(7))
    if (Number.isFinite(n) && n > 0) player = n
  }
  return { prefix, player, position, group }
}

export function buildAddress(
  prefix: string,
  player: number,
  position: string,
  group: number = -1,
): string {
  const tail = `player_${player}/${position}`
  let addr = prefix.trim() ? `${prefix.trim()}/${tail}` : tail
  if (group >= 1 && group <= 99) {
    addr += `/group_${group}`
  }
  return addr
}
