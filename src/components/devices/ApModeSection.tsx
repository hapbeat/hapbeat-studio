import { useState } from 'react'
import type { DeviceInfo, ManagerMessage } from '@/types/manager'

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
  const [apPass, setApPass] = useState('')
  const [showApPass, setShowApPass] = useState(false)
  const [passStatus, setPassStatus] = useState<{ kind: 'ok' | 'err' | 'warn'; msg: string } | null>(null)

  const isAp = apInfo.mode === 'ap'
  const online = device.online

  const switchToAp = () => {
    if (!confirm(
      'デバイスを AP モードに切り替えます。\n' +
      '現在の Wi-Fi 接続が切断され、\n' +
      `Hapbeat-XXXXXX という SSID で\n` +
      '直接接続できるようになります。\n\n' +
      '切り替えますか？'
    )) return
    sendTo({ type: 'enter_ap_mode', payload: {} })
  }

  const switchToSta = () => {
    if (!confirm(
      'デバイスを通常モード（STA）に戻します。\n' +
      '再起動後、設定済みの Wi-Fi に接続します。\n\n' +
      '切り替えますか？'
    )) return
    sendTo({ type: 'enter_sta_mode', payload: {} })
  }

  const submitApPass = () => {
    const val = apPass.trim()
    if (val.length > 0 && (val.length < 8 || val.length > 63)) {
      setPassStatus({ kind: 'err', msg: 'パスワードは 8〜63 文字で入力してください' })
      return
    }
    if (val.length === 0) {
      // Empty → clear
      sendTo({ type: 'clear_ap_pass', payload: {} })
      setPassStatus({ kind: 'ok', msg: 'AP パスワードを削除しました（オープン AP）' })
    } else {
      sendTo({ type: 'set_ap_pass', payload: { pass: val } })
      setPassStatus({
        kind: 'ok',
        msg: isAp
          ? 'パスワードを設定しました。次回 AP 起動時に有効になります（再起動が必要）'
          : 'AP パスワードを設定しました',
      })
    }
    setApPass('')
  }

  const clearApPass = () => {
    sendTo({ type: 'clear_ap_pass', payload: {} })
    setApPass('')
    setPassStatus({ kind: 'ok', msg: 'AP パスワードを削除しました（オープン AP）' })
  }

  return (
    <div className="form-section">
      <div
        className="form-section-title"
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
      >
        <span>
          Wi-Fi モード
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
          title="get_ap_status を取得"
        >
          ⟳ 更新
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
            ⚡ AP モードで動作中
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
            クライアント: {apInfo.ap_client_count ?? 0} 台接続中
          </div>
          <div style={{ fontSize: 14, color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.6 }}>
            クライアント未接続が 10 分続くと自動で STA モードに戻ります。
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
            Wi-Fi 設定して通常モードに戻す手順
          </div>
          <ol style={{ margin: '0 0 0 18px', padding: 0 }}>
            <li>「設定」タブ → 「Wi-Fi 設定」で SSID と Password を追加</li>
            <li>下の「通常モード（STA）に戻す」ボタンを押す</li>
            <li>デバイスが再起動し、設定した Wi-Fi に接続します</li>
          </ol>
          <div style={{ marginTop: 6, color: 'var(--text-muted)', fontSize: 13 }}>
            ※ AP モード中も Wi-Fi プロファイルの登録は可能です（NVS に保存され、STA 切替時に使われます）
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
            title="SoftAP モードに切り替え（デバイスが再起動します）"
          >
            AP モードに切り替え
          </button>
        ) : (
          <button
            className="form-button"
            onClick={switchToSta}
            disabled={!online}
            title="通常 Wi-Fi STA モードに戻す（デバイスが再起動します）"
          >
            通常モード（STA）に戻す
          </button>
        )}
        {apInfo.mode === undefined && (
          <span className="form-status muted" style={{ alignSelf: 'center', marginTop: 0 }}>
            get_info で mode フィールド未取得（firmware ≥ v0.1.0 が必要）
          </span>
        )}
      </div>

      {/* ---- AP password ---- */}
      <div className="form-section-title" style={{ fontSize: 13, marginBottom: 6 }}>
        AP パスワード
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
                ? '変更する場合のみ入力。空欄で Clear ボタンを押すとオープンに戻る'
                : '設定しない場合はオープン AP（誰でも接続可）'
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
            {showApPass ? '隠す' : '表示'}
          </button>
        </div>
        <button
          className="form-button"
          onClick={submitApPass}
          disabled={!online}
          title="AP パスワードを設定（8〜63 文字）"
        >
          Set
        </button>
      </div>

      <div className="form-action-row">
        <button
          className="form-button-secondary"
          onClick={clearApPass}
          disabled={!online}
          title="AP パスワードを削除してオープン AP に戻す"
        >
          Clear（オープン AP）
        </button>
        {apInfo.ap_has_pass !== undefined && (
          <span className="form-status muted" style={{ alignSelf: 'center', marginTop: 0 }}>
            現在: {apInfo.ap_has_pass ? '🔒 パスワード設定済み' : '🔓 オープン AP'}
          </span>
        )}
      </div>

      {passStatus && (
        <div className={`form-status ${passStatus.kind}`} style={{ marginTop: 8 }}>
          {passStatus.msg}
        </div>
      )}

      <div className="form-status muted" style={{ marginTop: 8 }}>
        ⚠️ オープン AP では誰でも接続してデバイスを操作できます。公共 LAN ではパスワードを推奨します。
      </div>
    </div>
  )
}
