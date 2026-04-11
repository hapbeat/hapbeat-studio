// WebSocket messages between Studio and Manager

export interface ManagerMessage {
  type: string
  payload: Record<string, unknown>
}

export interface DeviceInfo {
  name: string
  ipAddress: string
  group: number
  firmwareVersion: string
  batteryLevel: number
  /** MCP4018 wiper value 0-127 (null if not yet queried) */
  volumeWiper: number | null
  /** Volume level 0-N (null if not yet queried) */
  volumeLevel: number | null
  /** Volume steps count (null if not yet queried) */
  volumeSteps: number | null
}

// Studio -> Manager messages
export interface StudioToManagerMessage {
  type:
    | 'list_devices'
    | 'write_ui_config'
    | 'deploy_pack'
    | 'deploy_pack_data'
    | 'preview_event'
    | 'stream_begin'
    | 'stream_data'
    | 'stream_end'
    | 'query_space'
    | 'query_volume'
    | 'ping'
  payload: Record<string, unknown>
}

// Manager -> Studio messages
export interface ManagerToStudioMessage {
  type:
    | 'device_list'
    | 'write_result'
    | 'deploy_result'
    | 'stream_ack'
    | 'space_result'
    | 'volume_result'
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
