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
      // 4/8/16 variant 対応。サンプル IP '192.168.100.123' (15 文字) を左から N。
      const sample = '192.168.100.123'
      if (variant === 'compact') return sample.padEnd(4, ' ').slice(0, 4)
      if (variant === 'wide')    return sample.padEnd(16, ' ').slice(0, 16)
      return sample.padEnd(8, ' ').slice(0, 8)
    }
    case 'firmware_version':  return 'v2.0.0'                                     // 6文字 (semver)
    case 'device_name':       return 'DuoWL2'                                   // 6文字
    case 'app_name':
      // CONNECT_STATUS payload の app_name (Unity SDK 等が送信)。
      // variant でプレビュー文字数を切替: compact=4 / standard=8 / wide=16
      if (variant === 'compact') return 'MyAp'                                   // 4文字
      if (variant === 'wide')    return 'MyHapbeatApp_v01'                       // 16文字
      return 'MyApp   '                                                          // 8文字
    case 'player_number':     return `P:${String(s.player).padStart(2, '0')}`    // 4文字
    case 'position':          return `Pos:${String(s.position).padStart(3, '0')}` // 7文字
    case 'page_indicator':    return '1/2'                                       // 3文字
    case 'group_id':          return `Gr:${s.group}`                             // 4文字
    case 'address': {
      // address は player_ より前の prefix 部分のみ表示。
      // variant でプレビュー文字数を切替: compact=4 / standard=8 / wide=16
      const sample = 'MyHapbeatGroup'
      if (variant === 'compact') return sample.padEnd(4, ' ').slice(0, 4)
      if (variant === 'wide')    return sample.padEnd(16, ' ').slice(0, 16)
      return sample.padEnd(8, ' ').slice(0, 8)
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
    case 'ip_address':        return 'IP 左 N 文字'
    case 'firmware_version':  return 'FW ver'
    case 'device_name':       return 'Name'
    case 'app_name':          return 'App名'
    case 'address':           return 'prefix'
    case 'player_number':     return 'P:XX'
    case 'position':          return 'Pos:XXX'
    case 'page_indicator':    return 'N/N'
    case 'group_id':          return 'Gr:X'
  }
}
