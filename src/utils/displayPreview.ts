import type { DisplayElementType } from '@/types/display'

/** シミュレーション状態 */
export interface SimState {
  player: number
  position: number
  volume: number
  volumeAdcEnabled: boolean // true=可変(ADC), false=固定値
}

export const DEFAULT_SIM_STATE: SimState = {
  player: 0,
  position: 0,
  volume: 5,
  volumeAdcEnabled: true,
}

/** ファームウェア準拠のプレビューテキスト */
export function getElementPreviewText(type: DisplayElementType, simState?: SimState): string {
  const s = simState ?? DEFAULT_SIM_STATE
  switch (type) {
    case 'volume': {
      const v = `v${String(s.volume).padStart(2, '0')}`
      return s.volumeAdcEnabled ? v : `${v}F`
    }
    case 'battery':           return 'BAT \u2593\u2593\u2593\u2591\u2591'
    case 'wifi_status':       return 'W:---'
    case 'connection_status': return '[--]'
    case 'ip_address':        return 'XXX.XXX.X.X'
    case 'firmware_version':  return 'X.X.X'
    case 'device_name':       return 'Hapbeat'
    case 'gain':              return 'G:XX'
    case 'player_number':     return `P:${String(s.player).padStart(2, '0')}`
    case 'position':          return `Pos:${String(s.position).padStart(3, '0')}`
  }
}

/** パレット表示用 */
export function getElementDescription(type: DisplayElementType): string {
  switch (type) {
    case 'volume':            return 'v00\u2013v10'
    case 'battery':           return 'BAT+meter'
    case 'wifi_status':       return 'W:XXdBm'
    case 'connection_status': return '[OK]app'
    case 'ip_address':        return 'IP address'
    case 'firmware_version':  return 'FW ver'
    case 'device_name':       return 'Device name'
    case 'gain':              return 'G:XX'
    case 'player_number':     return 'P:XX'
    case 'position':          return 'Pos:XXX'
  }
}
