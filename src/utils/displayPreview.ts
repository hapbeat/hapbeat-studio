import type { DisplayElementType } from '@/types/display'

/** シミュレーション状態 */
export interface SimState {
  player: number
  position: number
  volume: number
  volumeAdcEnabled: boolean
}

export const DEFAULT_SIM_STATE: SimState = {
  player: 0,
  position: 0,
  volume: 5,
  volumeAdcEnabled: true,
}

/**
 * ファームウェア準拠のプレビューテキスト
 *
 * 重要: 文字数 = ELEMENT_FIXED_SIZES の幅と一致させること
 * 1文字 = 1グリッドセル = 8px
 */
export function getElementPreviewText(type: DisplayElementType, simState?: SimState): string {
  const s = simState ?? DEFAULT_SIM_STATE
  switch (type) {
    case 'volume':            return `v${String(s.volume).padStart(2, ' ')}`     // 3文字
    case 'battery':           return 'BAT:100%'                                  // 8文字
    case 'wifi_status':       return 'W:---'                                     // 5文字 (padding)
    case 'wifi_ssid':         return 'MySSID  '                                  // 8文字
    case 'connection_status': return '[--]'                                      // 4文字
    case 'ip_address':        return '192.168.100.123'                           // 15文字
    case 'firmware_version':  return 'v1.2.3'                                    // 6文字
    case 'device_name':       return 'DuoWL2'                                   // 6文字
    case 'gain':              return 'G:12'                                      // 4文字
    case 'player_number':     return `P:${String(s.player).padStart(2, '0')}`    // 4文字
    case 'position':          return `Pos:${String(s.position).padStart(3, '0')}` // 7文字
    case 'page_indicator':    return '1/2'                                       // 3文字
    case 'group_id':          return 'Gr:1'                                      // 4文字
    case 'address':           return `p${s.player}/pos_nck`                      // 10文字
  }
}

/** パレット表示用の説明文 */
export function getElementDescription(type: DisplayElementType): string {
  switch (type) {
    case 'volume':            return 'v00\u2013v23'
    case 'battery':           return 'BAT:XXX%'
    case 'wifi_status':       return 'W:dBm'
    case 'wifi_ssid':         return 'SSID/AP'
    case 'connection_status': return '[OK]app'
    case 'ip_address':        return 'Full IP'
    case 'firmware_version':  return 'FW ver'
    case 'device_name':       return 'Name'
    case 'gain':              return 'G:XX'
    case 'address':           return 'pN/pos'
    case 'player_number':     return 'P:XX'
    case 'position':          return 'Pos:XXX'
    case 'page_indicator':    return 'N/N'
    case 'group_id':          return 'Gr:X'
  }
}
