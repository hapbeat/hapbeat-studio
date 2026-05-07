import type { DisplayElementType } from '@/types/display'

/** シミュレーション状態
 *  - player / group はボタン操作で増減 (player_inc/dec, group_inc/dec)
 *  - position は設定で決まる固定値 (ボタン操作対象外) なのでサンプル表示用
 *  - volume / volumeAdcEnabled は volume / vib_mode 系ボタンで変化
 */
export interface SimState {
  player: number
  group: number
  position: number
  volume: number
  volumeAdcEnabled: boolean
}

export const DEFAULT_SIM_STATE: SimState = {
  player: 0,
  group: 0,
  position: 0,
  volume: 5,
  volumeAdcEnabled: true,
}

/**
 * ファームウェア準拠のプレビューテキスト
 *
 * 重要: 文字数 = getElementSize() の幅と一致させること
 * 1文字 = 1グリッドセル = 8px
 */
export function getElementPreviewText(type: DisplayElementType, simState?: SimState, variant?: string): string {
  const s = simState ?? DEFAULT_SIM_STATE
  switch (type) {
    case 'volume':            return `vol:${String(s.volume).padStart(2, '0')}`   // 6文字
    case 'volume_mode':       return s.volumeAdcEnabled ? 'Var' : 'Fix'          // 3文字
    case 'battery':
      if (variant === 'bar') return 'BAT\u2588\u2588\u2588\u2588\u2581'          // 8文字 (bar meter)
      return ' 85%'                                                               // 4文字 (percent)
    case 'wifi_status':       return 'W:---'                                     // 5文字 (padding)
    case 'wifi_ssid': {
      // 4/8/16 variant 対応。サンプル SSID 'MyAccessPoint01' を左から N 文字。
      const sample = 'MyAccessPoint01'
      if (variant === 'compact') return sample.padEnd(4, ' ').slice(0, 4)
      if (variant === 'wide')    return sample.padEnd(16, ' ').slice(0, 16)
      return sample.padEnd(8, ' ').slice(0, 8)
    }
    case 'connection_status': return '[--]'                                      // 4文字
    case 'ip_address': {
      // 同 LAN は 192.168.x や 10.0.x のように前半オクテットが基本被るため、
      // **右から N 文字** で切出すと重要部分 (末尾 1-2 オクテット) を残せる。
      // compact=4 (".147"), standard=6 (".0.147"), wide=13 (フル "192.168.0.147")
      const sample = '192.168.0.147'
      const pickRight = (n: number) => sample.length >= n
        ? sample.slice(-n)
        : sample.padStart(n, ' ')
      if (variant === 'compact') return pickRight(4)
      if (variant === 'wide')    return pickRight(13)
      return pickRight(6)
    }
    case 'firmware_version':  return 'v0.1.0'                                     // 6文字 (semver)
    case 'device_name':       return 'Duo-1'                                   // 6文字
    case 'app_name':
      // CONNECT_STATUS payload の app_name (Unity SDK 等が送信)。
      // variant でプレビュー文字数を切替: compact=4 / standard=8 / wide=16
      if (variant === 'compact') return 'N.C.'                                   // 4文字
      if (variant === 'wide')    return 'App: unconnected'                       // 16文字
      return 'App N.C.'                                                          // 8文字
    case 'player_number':     return `P:${String(s.player).padStart(2, '0')}`    // 4文字
    case 'position': {
      // NVS の `pos_xxx` 名を表示 (数値ではない)。サンプル `pos_l_wrist` を
      // 4/8/16 variant に成形する。
      //   compact (4) = name 部のみ truncate (e.g. 'l_wr')
      //   standard (8) = `pos:` + name 4 字 (e.g. 'pos:l_wr')
      //   wide (16)    = `pos: ` + full name pad (e.g. 'pos: l_wrist    ')
      const sample = 'pos_l_wrist'
      const name = sample.startsWith('pos_') ? sample.slice(4) : sample
      if (variant === 'compact') return name.padEnd(4, ' ').slice(0, 4)
      if (variant === 'wide')    return `pos: ${name}`.padEnd(16, ' ').slice(0, 16)
      return `pos:${name}`.padEnd(8, ' ').slice(0, 8)
    }
    case 'page_indicator':    return '1/2'                                       // 3文字
    case 'group_id':          return `Gr:${s.group}`                             // 4文字
    case 'address': {
      // address は player_ より前の prefix 部分のみ表示。
      // variant でプレビュー文字数を切替: compact=4 / standard=8 / wide=16
      // NVS は通常 `<prefix>/player_N/pos_xxx` 形式。prefix が無い
      // (`player_N/...` 形式 or 未設定) 場合は [unset] にフォールバックして
      // player_N が漏れて表示されないようにする (firmware 側も同 rule)。
      const fullSample = 'red/alpha/player_5/pos_neck'
      const idx = fullSample.indexOf('/player_')
      const headBeforePlayer = idx < 0
        ? (fullSample.startsWith('player_') ? '' : fullSample)
        : fullSample.slice(0, idx)
      const isUnset = headBeforePlayer.length === 0
      const text = isUnset
        ? (variant === 'compact' ? 'none'
          : variant === 'wide'    ? '[unset prefix]'
          :                         '[unset]')
        : headBeforePlayer
      if (variant === 'compact') return text.padEnd(4, ' ').slice(0, 4)
      if (variant === 'wide')    return text.padEnd(16, ' ').slice(0, 16)
      return text.padEnd(8, ' ').slice(0, 8)
    }
  }
}

/** パレット表示用の説明文 */
export function getElementDescription(type: DisplayElementType): string {
  switch (type) {
    case 'volume':            return 'vol:00'
    case 'volume_mode':       return 'Fix/Var'
    case 'battery':           return 'XX%'
    case 'wifi_status':       return 'W:dBm'
    case 'wifi_ssid':         return 'SSID 左 N 文字'
    case 'connection_status': return '[OK]app'
    case 'ip_address':        return 'IP 右 N 文字'
    case 'firmware_version':  return 'FW ver'
    case 'device_name':       return 'Name'
    case 'app_name':          return 'App名'
    case 'address':           return 'prefix'
    case 'player_number':     return 'P:XX'
    case 'position':          return 'pos:xxx'
    case 'page_indicator':    return 'N/N'
    case 'group_id':          return 'Gr:X'
  }
}
