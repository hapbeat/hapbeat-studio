import type { DeviceInfo, ManagerMessage } from '@/types/manager'

interface Props {
  device: DeviceInfo
  dump?: Record<string, unknown>
  sendTo: (msg: ManagerMessage) => void
}

/**
 * Mirrors the Manager's "デバッグ情報" section: one button to fetch
 * `get_debug_dump`, then a formatted multi-line readout.
 */
export function DebugDumpSection({ device, dump, sendTo }: Props) {
  const fetchDump = () => {
    sendTo({ type: 'get_debug_dump', payload: {} })
  }

  return (
    <div className="form-section">
      <div
        className="form-section-title"
        style={{ display: 'flex', justifyContent: 'space-between' }}
      >
        <span>デバッグ情報</span>
        <button
          className="form-button-secondary"
          onClick={fetchDump}
          disabled={!device.online}
          style={{ fontSize: 11, padding: '2px 8px' }}
        >
          取得
        </button>
      </div>

      {dump ? (
        <pre className="debug-dump-pre">{formatDump(dump)}</pre>
      ) : (
        <div className="form-status muted">
          「取得」を押すとデバイスから get_debug_dump 結果を表示します。
        </div>
      )}
    </div>
  )
}

function formatDump(d: Record<string, unknown>): string {
  // Key formatting mirrors `ConfigPage.show_debug_dump` in
  // `hapbeat-manager/src/hapbeat_manager/widgets/config_page.py`.
  const get = (k: string, fallback: string | number = '?') =>
    d[k] === undefined || d[k] === null ? fallback : d[k]
  const charging = d.charging ? 'Yes' : 'No'
  const fix = d.fix_mode ? 'Yes' : 'No'
  const wifiConn = d.wifi_connected ? 'Yes' : 'No'
  const audioPlay = d.audio_playing ? '再生中' : '停止'
  const appConn = d.app_connected ? '接続中' : '未接続'

  const used = num(d.audio_used) / 1024
  const cap = num(d.audio_cap) / (1024 * 1024)
  const heap = num(d.free_heap) / 1024
  const uptime = num(d.uptime_sec)
  const uptimeStr = `${Math.floor(uptime / 60)}m ${Math.floor(uptime % 60)}s`

  const lines = [
    `Battery: ${get('battery_ic')}  SOC: ${get('soc')}%  Voltage: ${get('voltage')}mV  Charging: ${charging}`,
    `Volume:  ${get('volume_level')}/${get('volume_steps')}  Wiper: ${get('volume_wiper')}  Fix: ${fix}`,
    `ESP-NOW: ch${get('espnow_channel')}  Group: ${get('group')}`,
    `Wi-Fi:   ${get('wifi_ssid', '-')}  ${get('wifi_rssi')}dBm  ${get('wifi_ip', '-')}  Connected: ${wifiConn}`,
    `App:     ${appConn}`,
    `Audio:   ${audioPlay}  Gain: ${get('audio_gain')}  Events: ${get('event_count')}  Storage: ${used.toFixed(1)}KB / ${cap.toFixed(1)}MB`,
    `FW:      ${get('fw')}  Uptime: ${uptimeStr}  Heap: ${heap.toFixed(0)}KB`,
  ]
  return lines.join('\n')
}

function num(x: unknown): number {
  const n = typeof x === 'number' ? x : Number(x)
  return Number.isFinite(n) ? n : 0
}
