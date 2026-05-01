import type { DisplayTemplate } from '@/types/display'

/**
 * テンプレート定義
 *
 * OLED: 128x32px = 16文字 × 2行 グリッド
 * 各要素のサイズ:
 *   volume: 6, volume_mode: 3, battery(%): 4, battery(bar): 8,
 *   wifi_status: 5, connection_status: 4, player_number: 4,
 *   position: 7, device_name: 6, firmware_version: 6, gain: 4,
 *   ip_address: 15, page_indicator: 3, group_id: 4, address: 10
 */

export const standardTemplate: DisplayTemplate = {
  name: 'Standard',
  description: 'VOL + Battery + Player + Connection',
  layout: {
    grid: [16, 2],
    pages: [
      {
        name: 'Page 1',
        elements: [
          // Row 0: vol(6) + player(4) + mode(3) = 13
          { id: 'el-vol', type: 'volume', pos: [0, 0] },
          { id: 'el-player', type: 'player_number', pos: [7, 0] },
          { id: 'el-mode', type: 'volume_mode', pos: [12, 0] },
          // Row 1: battery_bar(8) + connection(4) = 12
          { id: 'el-bat', type: 'battery', pos: [0, 1], variant: 'bar' },
          { id: 'el-conn', type: 'connection_status', pos: [9, 1] },
        ],
      },
    ],
    buttons: { short_press: 'next_page', long_press: 'none' },
  },
}

export const simpleTemplate: DisplayTemplate = {
  name: 'Simple',
  description: 'VOL + Battery only',
  layout: {
    grid: [16, 2],
    pages: [
      {
        name: 'Page 1',
        elements: [
          // Row 0: vol(6) + mode(3) = 9
          { id: 'el-vol', type: 'volume', pos: [0, 0] },
          { id: 'el-mode', type: 'volume_mode', pos: [7, 0] },
          // Row 1: battery_bar(8) = 8
          { id: 'el-bat', type: 'battery', pos: [0, 1], variant: 'bar' },
        ],
      },
    ],
    buttons: { short_press: 'player_inc', long_press: 'player_dec' },
  },
}

export const detailedTemplate: DisplayTemplate = {
  name: 'Detailed',
  description: '2 pages: main + info',
  layout: {
    grid: [16, 2],
    pages: [
      {
        name: 'Page 1',
        elements: [
          // Row 0: vol(6) + player(4) + mode(3) + page(3) = 16
          { id: 'el-vol', type: 'volume', pos: [0, 0] },
          { id: 'el-player', type: 'player_number', pos: [6, 0] },
          { id: 'el-mode', type: 'volume_mode', pos: [10, 0] },
          { id: 'el-page', type: 'page_indicator', pos: [13, 0] },
          // Row 1: battery_bar(8) + connection(4) = 12
          { id: 'el-bat', type: 'battery', pos: [0, 1], variant: 'bar' },
          { id: 'el-conn', type: 'connection_status', pos: [9, 1] },
        ],
      },
      {
        name: 'Page 2',
        elements: [
          // Row 0: device_name(6) + wifi(5) + page(3) = 14
          { id: 'el-name', type: 'device_name', pos: [0, 0] },
          { id: 'el-wifi', type: 'wifi_status', pos: [7, 0] },
          { id: 'el-page2', type: 'page_indicator', pos: [13, 0] },
          // Row 1: fw(3) + gain(4) + battery%(4) = 11
          { id: 'el-fw', type: 'firmware_version', pos: [0, 1] },
          { id: 'el-gain', type: 'gain', pos: [4, 1] },
          { id: 'el-bat2', type: 'battery', pos: [9, 1] },
        ],
      },
    ],
    buttons: { short_press: 'next_page', long_press: 'prev_page' },
  },
}

export const allTemplates: DisplayTemplate[] = [standardTemplate, simpleTemplate, detailedTemplate]
