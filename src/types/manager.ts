// WebSocket messages between Studio and hapbeat-helper.
// (Helper supersedes the legacy hapbeat-manager from DEC-026 onward,
// but the wire protocol is the same — type names are kept Manager*-
// prefixed only because they are widely referenced; rename is a future
// cleanup task.)

export interface ManagerMessage {
  type: string
  payload: Record<string, unknown>
}

/**
 * Node role / transport taxonomy (contracts: node-roles.md, DEC-034).
 * A node declares these in get_info; Studio gates UI on them. A node
 * that doesn't report a role is treated as a `receiver` on `udp` —
 * so plain Wi-Fi-UDP devices look exactly as before (zero UX change).
 */
export type NodeRole = 'receiver' | 'sensor' | 'broker' | 'transmitter'
export type NodeTransport = 'udp' | 'mqtt' | 'espnow_stream'

/** A sensor color-match box (RGB thresholds). See mqtt-transport.md §5. */
export interface SensorColorMatch {
  r_min?: number
  r_max?: number
  g_min?: number
  g_max?: number
  b_min?: number
  b_max?: number
}

/** Live sensor reading (get_sensor_reading) — Studio's threshold-tuning view.
 *  r/g/b are clear-normalized 0-255, the same scale as SensorColorMatch. */
export interface SensorReading {
  /** Sensor hardware type, e.g. "tcs34725". */
  sensor?: string
  r: number
  g: number
  b: number
  /** Raw clear (brightness) value, informational. */
  clear?: number
  /** Mapping key currently matching this reading ("" = none). */
  key?: string
  /** Milliseconds since the sample was taken. */
  age_ms?: number
}

/** One sensor → event mapping row (the "color → event" editor model). */
export interface SensorMapping {
  /** classification label, e.g. a color name */
  key: string
  /** sensor-type-specific match condition (color sensor: RGB box) */
  match: SensorColorMatch
  /** event to fire (Kit manifest `events` key) */
  event_id: string
  /** target address ("" = all) */
  target: string
  /** 0.0..1.0 */
  gain: number
  /** optional min interval between repeated fires of the same key */
  debounce_ms?: number
  /**
   * Optional per-mapping publish topic ROOT (no slashes), e.g. "ward-a".
   * When set the sensor publishes this color to "<topic>/play" instead of
   * its default "<topic_root>/play", so colors (or whole sensors) can be
   * routed to different receiver groups by topic (mqtt-transport.md §5).
   * Empty/undefined → the sensor's default root. Studio picks it from the
   * registered topic list (mqttTopicsStore).
   */
  topic?: string
  /**
   * Optional per-mapping publish topic ROOTS (multi). When set (length ≥ 1)
   * this color is published to EACH "<root>/play", so one color can reach
   * several receiver groups (mqtt-transport.md §5). Takes precedence over the
   * single `topic`; empty/undefined → fall back to `topic` then the sensor's
   * default root. Studio's per-row "送り先" multi-select writes this.
   */
  topics?: string[]
  /**
   * Optional per-color text shown on the receiver's OLED when this color
   * fires (item 9, e.g. "Red alert occured"). Sent in the play payload's
   * `oled` field; empty/undefined → no message. (mqtt-transport.md §4.1)
   */
  oled?: string
  /**
   * 重要フラグ (§6.3): when true, this color still plays on receivers that are
   * in 制限モード (restricted). Sent as the play payload's `critical` flag.
   */
  critical?: boolean
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
  /** Node role (DEC-034). Absent → treat as `receiver`. */
  role?: NodeRole
  /** Primary transport (DEC-034). Absent → treat as `udp`. */
  transport?: NodeTransport
  /** All transports a receiver supports (e.g. ["udp","mqtt"]). */
  transports?: NodeTransport[]
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
    | 'rescan'
    // In-process recovery: ask Helper to rebuild its UDP + mDNS discovery
    // layer without a full daemon restart (recovers from a wedged socket
    // that would otherwise lose all devices until `hapbeat-helper stop/start`).
    | 'reset_discovery'
    // --- node-roles config (DEC-034) ---
    | 'set_broker_host'      // receiver(mqtt) / sensor
    | 'set_espnow_channel'   // receiver(espnow_stream) / transmitter
    | 'set_gain'             // receiver(espnow_stream)
    | 'set_input_level'      // transmitter
    | 'set_broker_config'    // broker (static_octet / port)
    | 'set_sensor_mapping'   // sensor
    | 'get_sensor_mapping'   // sensor
    | 'get_sensor_reading'   // sensor (live tuning view)
    | 'set_alert_mode'       // receiver(mqtt) — alert-loop on/off (item 10)
    | 'set_recv_topics'      // receiver(mqtt) — subscribe topic list (item 8)
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
    | 'sensor_mapping_result'
    | 'sensor_reading_result'
    | 'reset_discovery_result'
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
  /** Firmware build commit short SHA (7 chars). Present on firmware ≥ 0.1.2d* (auto-generated FIRMWARE_VERSION). */
  build?: string
  group?: number
  wifi_connected?: boolean
  /** Hardware board id (e.g. band_wl_v3, atom_lite, atom_s3, xiao_c6). */
  board?: string
  /** Node role / transport (DEC-034). */
  role?: NodeRole
  transport?: NodeTransport
  transports?: NodeTransport[]
  // --- role-specific fields (present only for the relevant role) ---
  /** ESP-NOW channel (espnow_stream receiver / transmitter). */
  espnow_channel?: number
  /** Default streaming gain 0..1 (espnow_stream receiver). */
  gain?: number
  /** Line input level 0..100 (transmitter). */
  input_level?: number
  /** MQTT broker host ("auto" or host/IP) (receiver(mqtt) / sensor). */
  broker_host?: string
  /** MQTT connect port for manual hosts (receiver(mqtt) / sensor). */
  broker_port?: number
  /** MQTT topic root, default "default-topic" (receiver(mqtt) / sensor). */
  topic_root?: string
  /** MQTT QoS 0|1, default 1 (receiver(mqtt) / sensor). */
  mqtt_qos?: number
  /** Whether this client is connected to the broker (receiver(mqtt) / sensor). */
  mqtt_connected?: boolean
  /** Broker static host octet (broker). */
  static_octet?: number
  /** Broker MQTT port (broker). */
  mqtt_port?: number
  /** Whether the embedded broker is currently running (broker). */
  mqtt_running?: boolean
  /** Connected MQTT clients (broker; presence-sourced names). */
  mqtt_clients?: MqttClientEntry[]
  /** play/stop publish count since boot (broker). */
  mqtt_pub_count?: number
  /** Topic of the most recent publish (broker). */
  mqtt_last_topic?: string
  /** Payload preview of the most recent publish (broker). */
  mqtt_last_payload?: string
  /** Number of sensor→event mappings configured (sensor). */
  mappings_count?: number
  /** Sensor hardware type(s), e.g. ["tcs34725"] — an array so one sender can
   *  expose several sensors (item 3). Single-sensor builds report one element. */
  sensor_types?: string[]
  /** Alert-loop mode (MQTT receiver, item 10): true = loop an incoming alert
   *  until acknowledged by a deliberate button hold (~1s after release);
   *  false = one-shot. */
  alert_loop?: boolean
  /** Restricted mode (MQTT receiver, mqtt-transport.md §6.3): true = play only
   *  `critical` alerts; false (default) = play all. Read-only here — toggled on
   *  the device via the `limit_toggle` button action (no serial set command). */
  alert_limit?: boolean
  /** Deliberate-hold time (ms) to acknowledge/stop an alert (MQTT receiver,
   *  §6.1). Set via set_alert_mode ack_hold_ms; default 1000. */
  ack_hold_ms?: number
  /** Receive topic roots the MQTT receiver subscribes to (item 8). Empty =
   *  the default channel ("default-topic"). */
  recv_topics?: string[]
  error?: string
}

/** One connected client on the embedded broker (mqtt-transport.md §8). */
export interface MqttClientEntry {
  id: string
  /** Studio-assigned device name (presence message); absent on old firmware. */
  name?: string
  role: 'sensor' | 'receiver' | 'unknown'
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
