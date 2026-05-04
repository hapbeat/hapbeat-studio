import { useEffect, useState } from 'react'
import type { DeviceInfo, ManagerMessage } from '@/types/manager'

interface Props {
  device: DeviceInfo
  wifiStatus?: {
    connected?: boolean
    ssid?: string
    ip?: string
    rssi?: number
    channel?: number
  }
  sendTo: (msg: ManagerMessage) => void
}

/**
 * Single-SSID Wi-Fi setter. Multi-profile management (the 5-slot list
 * the manager exposes) is intentionally out of scope for the MVP — once
 * Phase 2 lands we can add it back if real users hit the limit.
 */
export function WifiForm({ device, wifiStatus, sendTo }: Props) {
  const [ssid, setSsid] = useState('')
  const [password, setPassword] = useState('')
  const [showPass, setShowPass] = useState(false)

  // Pre-fill SSID from device's currently-connected network when known.
  useEffect(() => {
    if (wifiStatus?.ssid) setSsid(wifiStatus.ssid)
  }, [wifiStatus?.ssid])

  const submit = () => {
    if (!ssid.trim()) return
    sendTo({
      type: 'set_wifi',
      payload: { ssid: ssid.trim(), password },
    })
  }

  const clear = () => {
    if (!confirm('保存済みの Wi-Fi 設定をすべて削除します。よろしいですか？')) return
    sendTo({ type: 'clear_wifi', payload: {} })
  }

  return (
    <div className="form-section">
      <div className="form-section-title">Wi-Fi 設定</div>

      {wifiStatus && (
        <div className="form-status muted" style={{ marginBottom: 8 }}>
          現在: {wifiStatus.connected ? '接続中' : '未接続'}
          {wifiStatus.ssid && <> · SSID={wifiStatus.ssid}</>}
          {wifiStatus.ip && <> · {wifiStatus.ip}</>}
          {wifiStatus.rssi !== undefined && <> · {wifiStatus.rssi}dBm</>}
          {wifiStatus.channel !== undefined && <> · ch{wifiStatus.channel}</>}
        </div>
      )}

      <div className="form-row">
        <label>SSID</label>
        <input
          className="form-input"
          value={ssid}
          onChange={(e) => setSsid(e.target.value)}
          placeholder="Wi-Fi SSID"
          disabled={!device.online}
        />
        <span />
      </div>

      <div className="form-row">
        <label>パスワード</label>
        <div className="form-row-multi" style={{ width: '100%' }}>
          <input
            className="form-input"
            type={showPass ? 'text' : 'password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Wi-Fi パスワード（保存後は確認できなくなります）"
            disabled={!device.online}
            autoComplete="off"
          />
          <button
            className="form-button-secondary"
            onClick={() => setShowPass((v) => !v)}
            type="button"
          >
            {showPass ? '隠す' : '表示'}
          </button>
        </div>
        <button
          className="form-button"
          onClick={submit}
          disabled={!device.online || !ssid.trim()}
        >
          設定
        </button>
      </div>

      <div className="form-action-row">
        <button
          className="form-button-danger"
          onClick={clear}
          disabled={!device.online}
        >
          すべて削除 (clear_wifi)
        </button>
      </div>

      <div className="form-status muted" style={{ marginTop: 8 }}>
        Wi-Fi 設定変更後はデバイスの再起動が必要です（上部の「再起動」ボタン）。
      </div>
    </div>
  )
}
