import type { DisplayTemplate, PagePreset, DisplayPage } from '@/types/display'

/**
 * テンプレート定義
 *
 * 二段構え:
 *   - fullLayouts: 全レイアウト (= 全 page + buttons) を一括適用。新規 / リセット用。
 *   - pagePresets: 1 ページだけ既存レイアウトに追加・差替。微調整用。
 *
 * OLED: 128x32px = 16文字 × 2行 グリッド
 * 各要素のサイズ:
 *   volume: 6, volume_mode: 3, battery(%): 4, battery(bar): 8,
 *   wifi_status: 5, connection_status: 4, player_number: 4,
 *   position: 7, device_name: 6, firmware_version: 6,
 *   ip_address: 15, page_indicator: 3, group_id: 4, address: 10
 */

// ========================================
// Page presets (1 ページ単位)
// ========================================

const mainPage: DisplayPage = {
  name: 'Main',
  elements: [
    { id: 'el-vol', type: 'volume', pos: [0, 0] },
    { id: 'el-player', type: 'player_number', pos: [7, 0] },
    { id: 'el-mode', type: 'volume_mode', pos: [12, 0] },
    { id: 'el-bat', type: 'battery', pos: [0, 1], variant: 'bar' },
    { id: 'el-conn', type: 'connection_status', pos: [9, 1] },
  ],
}

const simplePage: DisplayPage = {
  name: 'Simple',
  elements: [
    { id: 'el-vol', type: 'volume', pos: [0, 0] },
    { id: 'el-mode', type: 'volume_mode', pos: [7, 0] },
    { id: 'el-bat', type: 'battery', pos: [0, 1], variant: 'bar' },
  ],
}

const playerPage: DisplayPage = {
  name: 'Player',
  elements: [
    { id: 'el-vol', type: 'volume', pos: [0, 0] },
    { id: 'el-player', type: 'player_number', pos: [6, 0] },
    { id: 'el-mode', type: 'volume_mode', pos: [10, 0] },
    { id: 'el-page', type: 'page_indicator', pos: [13, 0] },
    { id: 'el-bat', type: 'battery', pos: [0, 1], variant: 'bar' },
    { id: 'el-conn', type: 'connection_status', pos: [9, 1] },
  ],
}

const infoPage: DisplayPage = {
  name: 'Info',
  elements: [
    { id: 'el-name', type: 'device_name', pos: [0, 0] },
    { id: 'el-wifi', type: 'wifi_status', pos: [7, 0] },
    { id: 'el-page', type: 'page_indicator', pos: [13, 0] },
    { id: 'el-fw', type: 'firmware_version', pos: [0, 1] },
    { id: 'el-bat', type: 'battery', pos: [9, 1] },
  ],
}

const networkPage: DisplayPage = {
  name: 'Network',
  elements: [
    { id: 'el-wifi', type: 'wifi_ssid', pos: [0, 0] },
    { id: 'el-page', type: 'page_indicator', pos: [13, 0] },
    { id: 'el-ip', type: 'ip_address', pos: [0, 1] },
  ],
}

const appPage: DisplayPage = {
  name: 'App',
  elements: [
    { id: 'el-app', type: 'app_name', pos: [0, 0], variant: 'wide' },
    { id: 'el-conn', type: 'connection_status', pos: [0, 1] },
    { id: 'el-bat', type: 'battery', pos: [9, 1] },
  ],
}

const emptyPage: DisplayPage = {
  name: 'Empty',
  elements: [],
}

export const pagePresets: PagePreset[] = [
  { name: 'Main', description: 'VOL + Player + Mode + Battery + Conn', page: mainPage },
  { name: 'Simple', description: 'VOL + Mode + Battery のみ', page: simplePage },
  { name: 'Player', description: 'Main + Page indicator', page: playerPage },
  { name: 'Info', description: 'Device / Wi-Fi / FW / Bat%', page: infoPage },
  { name: 'Network', description: 'Wi-Fi SSID + IP Address', page: networkPage },
  { name: 'App', description: 'アプリ名 + 接続状態 + Battery', page: appPage },
  { name: 'Empty', description: '空ページ (要素なし)', page: emptyPage },
]

// ========================================
// Full layout templates (全 page + buttons 上書き)
// ========================================

export const standardTemplate: DisplayTemplate = {
  name: 'Standard',
  description: 'Main 1 ページ',
  layout: {
    grid: [16, 2],
    pages: [structuredClone(mainPage)],
    buttons: { short_press: 'next_page', long_press: 'none' },
  },
}

export const simpleTemplate: DisplayTemplate = {
  name: 'Simple',
  description: 'VOL + Battery のみ',
  layout: {
    grid: [16, 2],
    pages: [structuredClone(simplePage)],
    buttons: { short_press: 'player_inc', long_press: 'player_dec' },
  },
}

export const detailedTemplate: DisplayTemplate = {
  name: 'Detailed',
  description: '2 pages: Player + Info',
  layout: {
    grid: [16, 2],
    pages: [structuredClone(playerPage), structuredClone(infoPage)],
    buttons: { short_press: 'next_page', long_press: 'prev_page' },
  },
}

export const allTemplates: DisplayTemplate[] = [standardTemplate, simpleTemplate, detailedTemplate]
