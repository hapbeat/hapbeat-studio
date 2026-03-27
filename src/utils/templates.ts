import type { DisplayTemplate } from '@/types/display'

export const standardTemplate: DisplayTemplate = {
  name: '標準',
  description: 'VOL, Battery, 接続状態, Player',
  layout: {
    grid: [16, 2],
    pages: [
      {
        name: '画面1',
        elements: [
          { id: 'el-vol', type: 'volume', pos: [0, 0] },
          { id: 'el-player', type: 'player_number', pos: [5, 0] },
          { id: 'el-bat', type: 'battery', pos: [0, 1] },
          { id: 'el-conn', type: 'connection_status', pos: [5, 1] },
        ],
      },
    ],
    buttons: { short_press: 'next_page', long_press: 'none' },
  },
}

export const simpleTemplate: DisplayTemplate = {
  name: 'シンプル',
  description: 'VOL と Player のみ',
  layout: {
    grid: [16, 2],
    pages: [
      {
        name: '画面1',
        elements: [
          { id: 'el-vol', type: 'volume', pos: [0, 0] },
          { id: 'el-player', type: 'player_number', pos: [0, 1] },
        ],
      },
    ],
    buttons: { short_press: 'player_inc', long_press: 'player_dec' },
  },
}

export const detailedTemplate: DisplayTemplate = {
  name: '詳細',
  description: '全情報を 2 ページに',
  layout: {
    grid: [16, 2],
    pages: [
      {
        name: '画面1',
        elements: [
          { id: 'el-name', type: 'device_name', pos: [0, 0] },
          { id: 'el-bat', type: 'battery', pos: [10, 0] },
          { id: 'el-vol', type: 'volume', pos: [0, 1] },
          { id: 'el-pos', type: 'position', pos: [5, 1] },
          { id: 'el-wifi', type: 'wifi_status', pos: [10, 1] },
        ],
      },
      {
        name: '画面2',
        elements: [
          { id: 'el-ip', type: 'ip_address', pos: [0, 0] },
          { id: 'el-fw', type: 'firmware_version', pos: [0, 1] },
          { id: 'el-gain', type: 'gain', pos: [9, 1] },
        ],
      },
    ],
    buttons: { short_press: 'next_page', long_press: 'prev_page' },
  },
}

export const allTemplates: DisplayTemplate[] = [standardTemplate, simpleTemplate, detailedTemplate]
