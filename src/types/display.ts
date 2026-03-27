import type { DeviceModel } from './device'

export interface DisplayElement {
  id: string
  type: DisplayElementType
  pos: [number, number]  // [col, row]
}

export type DisplayElementType =
  | 'volume'
  | 'battery'
  | 'wifi_status'
  | 'connection_status'
  | 'ip_address'
  | 'firmware_version'
  | 'device_name'
  | 'gain'
  | 'player_number'
  | 'position'

export interface DisplayPage {
  name: string
  elements: DisplayElement[]
}

export type ButtonActionType =
  | 'next_page'
  | 'prev_page'
  | 'goto_page'
  | 'player_inc'
  | 'player_dec'
  | 'position_inc'
  | 'position_dec'
  | 'toggle_volume_adc'
  | 'none'

export interface SingleButtonAction {
  short_press: ButtonActionType
  long_press: ButtonActionType
  hold?: ButtonActionType
}

export type PerButtonActions = Record<string, SingleButtonAction>

export interface ButtonAction {
  short_press: ButtonActionType
  long_press: ButtonActionType
  hold?: ButtonActionType
}

export type DisplayOrientation = 'normal' | 'flipped'

export interface DisplayLayout {
  grid: [number, number]
  pages: DisplayPage[]
  buttons: ButtonAction
  deviceModel?: DeviceModel
  perButtonActions?: PerButtonActions
  orientation?: DisplayOrientation
}

export interface DisplayTemplate {
  name: string
  description: string
  layout: DisplayLayout
}

export interface DisplayElementMeta {
  type: DisplayElementType
  label: string
  description: string
  icon: string
}

/** ファームウェア準拠の固定サイズ (grid units) */
export const ELEMENT_FIXED_SIZES: Record<DisplayElementType, [number, number]> = {
  volume: [3, 1],
  battery: [4, 1],
  wifi_status: [6, 1],
  connection_status: [4, 1],
  ip_address: [10, 1],
  firmware_version: [8, 1],
  device_name: [8, 1],
  gain: [3, 1],
  player_number: [4, 1],
  position: [5, 1],
}
