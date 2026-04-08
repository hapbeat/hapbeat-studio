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
}

// Studio -> Manager messages
export interface StudioToManagerMessage {
  type:
    | 'list_devices'
    | 'write_ui_config'
    | 'deploy_pack'
    | 'preview_event'
    | 'ping'
  payload: Record<string, unknown>
}

// Manager -> Studio messages
export interface ManagerToStudioMessage {
  type:
    | 'device_list'
    | 'write_result'
    | 'deploy_result'
    | 'error'
    | 'pong'
  payload: Record<string, unknown>
}
