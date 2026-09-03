import { useEffect, useState } from 'react'
import type { DeviceInfo, ManagerMessage } from '@/types/manager'
import { useToast } from '@/components/common/Toast'
import { useI18n } from '@/i18n/I18nProvider'

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
  const { t } = useI18n()
  const [ssid, setSsid] = useState('')
  const [password, setPassword] = useState('')
  const [showPass, setShowPass] = useState(false)
  // 書込み結果トーストは HelperFailureToastListener が write_result ベースで出す。
  // ここは押下時の anchor 設定のみ（結果ベース）。
  const { setAnchor } = useToast()

  // Pre-fill SSID from device's currently-connected network when known.
  useEffect(() => {
    if (wifiStatus?.ssid) setSsid(wifiStatus.ssid)
  }, [wifiStatus?.ssid])

  const submit = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (!ssid.trim()) return
    setAnchor(e.currentTarget)
    sendTo({
      type: 'set_wifi',
      payload: { ssid: ssid.trim(), password },
    })
  }

  const clear = (e: React.MouseEvent<HTMLButtonElement>) => {
    const btn = e.currentTarget
    if (!confirm(t('wifi.clearConfirm'))) return
    setAnchor(btn)
    sendTo({ type: 'clear_wifi', payload: {} })
  }

  return (
    <div className="form-section">
      <div className="form-section-title">{t('wifi.legacyTitle')}</div>

      {wifiStatus && (
        <div className="form-status muted" style={{ marginBottom: 8 }}>
          {t('wifi.currentShort')} {wifiStatus.connected ? t('wifi.connected') : t('wifi.disconnected')}
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
        <label>{t('wifi.password')}</label>
        <div className="form-row-multi" style={{ width: '100%' }}>
          <input
            className="form-input"
            type={showPass ? 'text' : 'password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={t('wifi.passwordPlaceholder')}
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
          {t('wifi.apply')}
        </button>
      </div>

      <div className="form-action-row">
        <button
          className="form-button-danger"
          onClick={clear}
          disabled={!device.online}
        >
          {t('wifi.clearLegacy')}
        </button>
      </div>

      <div className="form-status muted" style={{ marginTop: 8 }}>
        {t('wifi.restartLegacy')}
      </div>
    </div>
  )
}
