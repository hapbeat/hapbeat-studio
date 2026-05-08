// WebSocket messages between Studio and hapbeat-helper.
// (Helper supersedes the legacy hapbeat-manager from DEC-026 onward,
// but the wire protocol is the same — type names are kept Manager*-
// prefixed only because they are widely referenced; rename is a future
// cleanup task.)

export interface ManagerMessage {
  type: string
  payload: Record<string, unknown>
}

export interface DeviceInfo {
  name: string
  ipAddress: string
  /** path-based device address e.g. "player_1/chest" (may be empty) */
  address: string
  firmwareVersion: string
  /** liveness flag pushed by Helper */
  online: boolean
  /** filled when the user installs hapbeat over USB serial directly (Phase 3) */
  serialConnected: boolean
  /** MCP4018 wiper value 0-127 (null if not yet queried) */
  volumeWiper: number | null
  /** Volume level 0-N (null if not yet queried) */
  volumeLevel: number | null
  /** Volume steps count (null if not yet queried) */
  volumeSteps: number | null
}

// Studio -> Helper messages
export interface StudioToManagerMessage {
  type:
    | 'list_devices'
    | 'write_ui_config'
    | 'deploy_kit'
    | 'deploy_kit_data'
    | 'preview_event'
    | 'stop_event'
    | 'stream_begin'
    | 'stream_data'
    | 'stream_end'
    | 'query_space'
    | 'query_volume'
    | 'set_name'
    | 'set_address'
    | 'set_group'
    | 'set_wifi'
    | 'clear_wifi'
    | 'reboot'
    | 'get_info'
    | 'get_wifi_status'
    | 'list_wifi_profiles'
    | 'connect_wifi_profile'
    | 'remove_wifi_profile'
    | 'get_debug_dump'
    | 'kit_list'
    | 'kit_delete'
    | 'play_event'
    | 'ping_device'
    | 'subscribe_logs'
    | 'unsubscribe_logs'
    | 'ota_data'
    | 'scan_wifi'
    | 'enter_ap_mode'
    | 'enter_sta_mode'
    | 'set_ap_pass'
    | 'clear_ap_pass'
    | 'get_ap_status'
    | 'set_oled_brightness'
    | 'get_oled_brightness'
    | 'ping'
  payload: Record<string, unknown>
}

// Helper -> Studio messages
export interface ManagerToStudioMessage {
  type:
    | 'helper_hello'
    | 'device_list'
    | 'write_result'
    | 'write_progress'
    | 'deploy_result'
    | 'stream_ack'
    | 'space_result'
    | 'volume_result'
    | 'volume_changed'
    | 'get_info_result'
    | 'wifi_status_result'
    | 'wifi_profiles_result'
    | 'debug_dump_result'
    | 'kit_list_result'
    | 'ping_result'
    | 'log_subscription'
    | 'device_log'
    | 'ota_progress'
    | 'ota_result'
    | 'scan_wifi_result'
    | 'ap_status_result'
    | 'oled_brightness_result'
    | 'error'
    | 'pong'
  payload: Record<string, unknown>
}

export interface SpaceResult {
  device: string
  total_bytes: number
  used_bytes: number
  free_bytes: number
}

export interface VolumeResult {
  device: string
  volume_level: number
  volume_wiper: number
  volume_steps: number
}

export interface WriteResult {
  success: boolean
  message?: string
  error?: string
  device_confirmed?: boolean
  results?: Array<{
    ip: string
    success: boolean
    response: Record<string, unknown>
  }>
}

export interface GetInfoResult {
  device: string
  name?: string
  mac?: string
  fw?: string
  group?: number
  wifi_connected?: boolean
  error?: string
}

export interface WifiStatusResult {
  device: string
  connected?: boolean
  ssid?: string
  ip?: string
  rssi?: number
  channel?: number
  error?: string
}
