import { useState } from 'react'
import type { DeviceInfo, ManagerMessage } from '@/types/manager'
import { useToast } from '@/components/common/Toast'
import { useI18n } from '@/i18n/I18nProvider'

interface ApInfo {
  mode?: 'sta' | 'ap'
  ap_ssid?: string
  ap_ip?: string
  ap_has_pass?: boolean
  ap_client_count?: number
}

interface Props {
  device: DeviceInfo
  apInfo: ApInfo
  sendTo: (msg: ManagerMessage) => void
  onRefreshApStatus: () => void
}

/**
 * SoftAP mode management section (device-firmware ≥ v0.1.0).
 *
 * Covers:
 *   Phase 1 — AP MODE badge / client count display
 *   Phase 2 — STA↔AP mode switch + AP password management
 *   Phase 3 — AP→Wi-Fi設定→STA フロー案内
 */
export function ApModeSection({ device, apInfo, sendTo, onRefreshApStatus }: Props) {
  const { t } = useI18n()
  const [apPass, setApPass] = useState('')
  const [showApPass, setShowApPass] = useState(false)
  const { toast, setAnchor } = useToast()

  const isAp = apInfo.mode === 'ap'
  const online = device.online

  const switchToAp = (e: React.MouseEvent<HTMLButtonElement>) => {
    const btn = e.currentTarget
    if (!confirm(t('ap.confirmEnter'))) return
    setAnchor(btn)
    sendTo({ type: 'enter_ap_mode', payload: {} })
    toast(t('ap.toastEnter'), 'info')
  }

  const switchToSta = (e: React.MouseEvent<HTMLButtonElement>) => {
    const btn = e.currentTarget
    if (!confirm(t('ap.confirmLeave'))) return
    setAnchor(btn)
    sendTo({ type: 'enter_sta_mode', payload: {} })
    toast(t('ap.toastLeave'), 'info')
  }

  const submitApPass = (e: React.MouseEvent<HTMLButtonElement>) => {
    setAnchor(e.currentTarget)
    const val = apPass.trim()
    if (val.length > 0 && (val.length < 8 || val.length > 63)) {
      toast(t('ap.passwordValidation'), 'error')
      return
    }
    // 成功/失敗は HelperFailureToastListener が write_result ベースで出す（結果ベース）。
    if (val.length === 0) {
      sendTo({ type: 'clear_ap_pass', payload: {} })  // empty → clear
    } else {
      sendTo({ type: 'set_ap_pass', payload: { pass: val } })
    }
    setApPass('')
  }

  const clearApPass = (e: React.MouseEvent<HTMLButtonElement>) => {
    setAnchor(e.currentTarget)
    sendTo({ type: 'clear_ap_pass', payload: {} })
    setApPass('')
  }

  return (
    <div className="form-section">
      <div
        className="form-section-title"
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
      >
        <span>
          {t('ap.title')}
          {isAp && (
            <span className="ap-mode-badge" style={{ marginLeft: 10 }}>
              AP MODE
            </span>
          )}
        </span>
        <button
          className="form-button-secondary"
          style={{ fontSize: 13, padding: '2px 8px' }}
          onClick={onRefreshApStatus}
          disabled={!online}
          title={t('ap.statusTitle')}
        >
          {t('ap.refresh')}
        </button>
      </div>

      {/* ---- AP mode info (when in AP mode) ---- */}
      {isAp && (
        <div
          className="ap-mode-info"
          style={{
            background: 'rgba(214, 73, 214, 0.08)',
            border: '1px solid rgba(214, 73, 214, 0.35)',
            borderRadius: 'var(--radius)',
            padding: '10px 12px',
            marginBottom: 10,
          }}
        >
          <div style={{ fontWeight: 600, color: '#d649d6', marginBottom: 4 }}>
            {t('ap.active')}
          </div>
          {apInfo.ap_ssid && (
            <div style={{ fontSize: 15, marginBottom: 2 }}>
              SSID: <span style={{ fontFamily: 'var(--font-mono)' }}>{apInfo.ap_ssid}</span>
            </div>
          )}
          {apInfo.ap_ip && (
            <div style={{ fontSize: 15, marginBottom: 2 }}>
              IP: <span style={{ fontFamily: 'var(--font-mono)' }}>{apInfo.ap_ip}</span>
            </div>
          )}
          <div style={{ fontSize: 15, marginBottom: 2 }}>
            {t('ap.clients', { count: apInfo.ap_client_count ?? 0 })}
          </div>
          <div style={{ fontSize: 14, color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.6 }}>
            {t('ap.autoSta')}
          </div>
        </div>
      )}

      {/* ---- AP → Wi-Fi setup guide (Phase 3: AP モード中の案内) ---- */}
      {isAp && (
        <div
          style={{
            background: 'var(--bg-primary)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            padding: '10px 12px',
            marginBottom: 10,
            fontSize: 14,
            color: 'var(--text-secondary)',
            lineHeight: 1.7,
          }}
        >
          <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
            {t('ap.guide.title')}
          </div>
          <ol style={{ margin: '0 0 0 18px', padding: 0 }}>
            <li>{t('ap.guide.one')}</li>
            <li>{t('ap.guide.two')}</li>
            <li>{t('ap.guide.three')}</li>
          </ol>
          <div style={{ marginTop: 6, color: 'var(--text-muted)', fontSize: 13 }}>
            {t('ap.guide.note')}
          </div>
        </div>
      )}

      {/* ---- STA ↔ AP mode switch buttons ---- */}
      <div className="form-action-row" style={{ marginBottom: 10 }}>
        {!isAp ? (
          <button
            className="form-button-secondary"
            onClick={switchToAp}
            disabled={!online}
            title={t('ap.enterTitle')}
          >
            {t('ap.enter')}
          </button>
        ) : (
          <button
            className="form-button"
            onClick={switchToSta}
            disabled={!online}
            title={t('ap.leaveTitle')}
          >
            {t('ap.leave')}
          </button>
        )}
        {apInfo.mode === undefined && (
          <span className="form-status muted" style={{ alignSelf: 'center', marginTop: 0 }}>
            {t('ap.modeUnknown')}
          </span>
        )}
      </div>

      {/* ---- AP password ---- */}
      <div className="form-section-title" style={{ fontSize: 13, marginBottom: 6 }}>
        {t('ap.password')}
      </div>
      <div className="form-row">
        <label>Password</label>
        <div className="form-row-multi" style={{ width: '100%', flexWrap: 'nowrap' }}>
          <input
            className="form-input"
            type={showApPass ? 'text' : 'password'}
            value={apPass}
            onChange={(e) => setApPass(e.target.value)}
            placeholder={
              apInfo.ap_has_pass
                ? t('ap.passwordChangeHint')
                : t('ap.passwordOpenHint')
            }
            disabled={!online}
            autoComplete="off"
            style={{ flex: 1, minWidth: 0 }}
          />
          <button
            className="form-button-secondary"
            onClick={() => setShowApPass((v) => !v)}
            type="button"
            style={{ flexShrink: 0, whiteSpace: 'nowrap' }}
          >
            {showApPass ? t('ap.hide') : t('ap.show')}
          </button>
        </div>
        <button
          className="form-button"
          onClick={submitApPass}
          disabled={!online}
          title={t('ap.passwordSetTitle')}
        >
          Set
        </button>
      </div>

      <div className="form-action-row">
        <button
          className="form-button-secondary"
          onClick={clearApPass}
          disabled={!online}
          title={t('ap.passwordClearTitle')}
        >
          {t('ap.clear')}
        </button>
        {apInfo.ap_has_pass !== undefined && (
          <span className="form-status muted" style={{ alignSelf: 'center', marginTop: 0 }}>
            {t('ap.currentPassword', { state: apInfo.ap_has_pass ? t('ap.passwordProtected') : t('ap.passwordOpen') })}
          </span>
        )}
      </div>

      <div className="form-status muted" style={{ marginTop: 8 }}>
        {t('ap.security')}
      </div>
    </div>
  )
}
