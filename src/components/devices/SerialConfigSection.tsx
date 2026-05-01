import { useSerialMaster } from '@/stores/serialMaster'
import { isWebSerialSupported } from '@/utils/serialConfig'

interface Props {
  /** Hide the「切断」button (e.g. when the parent owns the back-step
   *  UI). */
  hideDisconnectButton?: boolean
  /**
   * Compact mode: when **disconnected**, render only a tiny inline
   * "🔌 USB Serial で接続" link instead of a full section card.
   * Used inside the per-device 設定 sub-tab where the LAN forms are
   * the primary UI and Serial is a low-key fallback.
   */
  compact?: boolean
}

/**
 * Serial 接続 trigger / disconnect panel.
 *
 * Form fields (デバイス識別 / Wi-Fi profiles) used to live here too,
 * but the user-explicit ask (2026-04-30) was to **consolidate into
 * the LAN-side IdentityForm + WifiProfilesForm** so there's a single
 * place to edit each thing. Those forms now drive both transports
 * via `useDeviceTransport`. This component is reduced to:
 *
 *   - disconnected → "🔌 USB Serial で接続" link/button (compact /
 *     full)
 *   - connected     → tiny status pill + 切断 button
 *
 * Once connected, the wizard auto-selects the Serial pseudo-device
 * in the sidebar and the regular sub-tab UI takes over.
 */
export function SerialConfigSection({
  hideDisconnectButton = false,
  compact = false,
}: Props = {}) {
  const mode = useSerialMaster((s) => s.mode)
  const conn = useSerialMaster((s) => s.conn)
  const info = useSerialMaster((s) => s.info)
  const probeStatus = useSerialMaster((s) => s.probeStatus)
  const probeMessage = useSerialMaster((s) => s.probeMessage)
  const openConfig = useSerialMaster((s) => s.openConfig)
  const release = useSerialMaster((s) => s.release)

  if (!isWebSerialSupported()) {
    return (
      <div className="form-section">
        <div className="form-section-title">Serial 接続</div>
        <div className="form-status err">
          お使いのブラウザは Web Serial API をサポートしていません
          (Chrome / Edge を使用してください)。Web Serial は HTTPS または
          {' '}<code>http://localhost</code> でのみ動作します。
        </div>
      </div>
    )
  }

  // ── Disconnected ────────────────────────────────────────
  if (mode !== 'config' || !conn) {
    if (compact) {
      return (
        <div className="form-section serial-cfg-compact">
          <div className="form-status muted">
            LAN 経由の設定が応答しない時 / Wi-Fi を別 SSID に張り替えたい時は
            {' '}<button
              type="button"
              className="form-link-button"
              onClick={() => openConfig()}
              disabled={probeStatus === 'connecting'}
            >
              {probeStatus === 'connecting' ? '接続中…' : '🔌 USB Serial で直接設定'}
            </button>
            {' '}が使えます。
          </div>
          {probeMessage && (
            <div className={`form-status ${probeStatus === 'failed' ? 'err' : 'muted'}`}
              style={{ marginTop: 6 }}>
              {probeMessage}
            </div>
          )}
        </div>
      )
    }
    return (
      <div className="form-section">
        <div className="form-section-title">
          Serial 接続
          <span className="form-section-sub-inline">
            {' '}— Wi-Fi 未接続デバイスへの初回設定 (USB ケーブル経由)
          </span>
        </div>
        <div className="serial-connect-cta">
          <button
            className="form-button serial-connect-btn"
            onClick={() => openConfig()}
            disabled={probeStatus === 'connecting'}
          >
            {probeStatus === 'connecting' ? '接続中…' : '🔌 USB Serial で接続'}
          </button>
          <div className="serial-connect-hint">
            デバイスを USB ケーブルで PC に接続し、上のボタンを押すと COM ポート
            選択ダイアログが開きます (一度許可した COM ポートは以降そのまま再利用されます)。
            接続後はサイドバーの「USB Serial」カードを選択すると、設定タブで
            デバイス識別 / Wi-Fi が編集できます。
          </div>
          {probeMessage && (
            <div className={`form-status ${probeStatus === 'failed' ? 'err' : 'muted'}`}
              style={{ marginTop: 6 }}>
              {probeMessage}
            </div>
          )}
        </div>
      </div>
    )
  }

  // ── Connected ───────────────────────────────────────────
  return (
    <div className="form-section">
      <div
        className="form-section-title"
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
      >
        <span>
          Serial 接続中
          <span className="form-section-sub-inline">
            {' '}— USB 経由でデバイスと通信中
          </span>
        </span>
        {!hideDisconnectButton && (
          <button
            className="form-button-secondary"
            onClick={() => void release()}
            style={{ fontSize: 12, padding: '4px 12px' }}
          >
            切断
          </button>
        )}
      </div>
      {info && (
        <div className="form-status muted" style={{ marginTop: 4 }}>
          <strong>{info.name ?? '(unnamed)'}</strong> · group {info.group ?? '?'} ·
          {' '}fw {info.fw ?? '?'} ·
          {' '}{info.wifi_connected
            ? <>Wi-Fi 接続中 ({info.wifi_ssid ?? '?'} / {info.wifi_ip ?? '?'})</>
            : <>Wi-Fi 未接続</>}
        </div>
      )}
      <div className="form-status muted" style={{ marginTop: 6 }}>
        サイドバーの「🔌 Serial」カードを選択すると、設定タブでデバイス識別 / Wi-Fi 設定が編集できます。
      </div>
    </div>
  )
}
