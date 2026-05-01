import { useEffect, useState } from 'react'
import type { DeviceInfo, ManagerMessage } from '@/types/manager'
import type { WifiProfile } from '@/stores/deviceStore'
import { useInputHistory } from '@/hooks/useInputHistory'

interface Props {
  device: DeviceInfo
  profiles: WifiProfile[]
  count: number
  max: number
  wifiStatus?: {
    connected?: boolean
    ssid?: string
    ip?: string
    rssi?: number
    channel?: number
  }
  sendTo: (msg: ManagerMessage) => void
  onRefresh: () => void
}

/**
 * Multi-profile Wi-Fi management — mirrors the 5-slot list in
 * the manager's ConfigPage. Each row supports connect / edit / delete;
 * a "+新規追加" toggle reveals an inline form for adding a new SSID
 * (or editing an existing one with the SSID locked).
 */
export function WifiProfilesForm({
  device,
  profiles,
  count,
  max,
  wifiStatus,
  sendTo,
  onRefresh,
}: Props) {
  const [addOpen, setAddOpen] = useState(false)
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [ssid, setSsid] = useState('')
  const [password, setPassword] = useState('')
  const [showPass, setShowPass] = useState(false)
  const ssidHistory = useInputHistory('wifi-ssid')

  // Reset form state when the user picks a different device.
  useEffect(() => {
    setAddOpen(false)
    setEditingIndex(null)
    setSsid('')
    setPassword('')
    setShowPass(false)
  }, [device.ipAddress])

  const enterEditMode = (p: WifiProfile) => {
    setEditingIndex(p.index)
    setSsid(p.ssid)
    setPassword(p.pass ?? '')
    setAddOpen(true)
  }

  const exitEditMode = () => {
    setEditingIndex(null)
    setSsid('')
    setPassword('')
  }

  const submit = () => {
    if (!ssid.trim()) return
    // Send both `pass` and `password` so the call works on either
    // transport without per-route translation:
    //   - LAN → Helper: helper accepts both keys (server.py:269)
    //   - Serial → firmware: firmware reads `pass` (serial_config.cpp)
    sendTo({
      type: 'set_wifi',
      payload: { ssid: ssid.trim(), pass: password, password },
    })
    ssidHistory.commit(ssid.trim())
    exitEditMode()
    setAddOpen(false)
    // Refresh the profile list — the firmware doesn't push, we poll.
    setTimeout(onRefresh, 800)
  }

  const connectProfile = (idx: number) => {
    sendTo({ type: 'connect_wifi_profile', payload: { index: idx } })
  }

  const removeProfile = (idx: number) => {
    if (!confirm(`プロファイル #${idx} を削除しますか？`)) return
    sendTo({ type: 'remove_wifi_profile', payload: { index: idx } })
    setTimeout(onRefresh, 500)
  }

  const clearAll = () => {
    if (!confirm('保存済みの Wi-Fi 設定をすべて削除します。よろしいですか？')) return
    sendTo({ type: 'clear_wifi', payload: {} })
    setTimeout(onRefresh, 500)
  }

  return (
    <div className="form-section">
      <div
        className="form-section-title"
        style={{ display: 'flex', justifyContent: 'space-between' }}
      >
        <span>Wi-Fi 設定</span>
        <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>
          保存済み {count}/{max}
        </span>
      </div>

      {wifiStatus && (
        <div className="form-status muted" style={{ marginBottom: 8 }}>
          現在: {wifiStatus.connected ? '接続中' : '未接続'}
          {wifiStatus.ssid && <> · SSID={wifiStatus.ssid}</>}
          {wifiStatus.ip && <> · {wifiStatus.ip}</>}
          {wifiStatus.rssi !== undefined && <> · {wifiStatus.rssi}dBm</>}
          {wifiStatus.channel !== undefined && <> · ch{wifiStatus.channel}</>}
        </div>
      )}

      {/* ---- Profile list ---- */}
      {profiles.length === 0 && (
        <div className="form-status muted" style={{ marginBottom: 8 }}>
          保存済みプロファイルなし — 「⟳ 一覧取得」を押して同期してください
        </div>
      )}
      {profiles.map((p) => (
        <div key={p.index} className="wifi-profile-row">
          <span
            className={`wifi-profile-marker ${p.active ? 'active' : ''}`}
            title={p.active ? 'このプロファイルで接続中' : ''}
          >
            {p.active ? '●' : '○'}
          </span>
          <span className="wifi-profile-ssid">{p.ssid || '(no SSID)'}</span>
          {p.active ? (
            <span className="wifi-profile-badge">接続中</span>
          ) : (
            <button
              className="form-button-secondary wifi-profile-btn"
              onClick={() => connectProfile(p.index)}
              disabled={!device.online}
            >
              接続
            </button>
          )}
          <button
            className="form-button-secondary wifi-profile-btn"
            onClick={() => enterEditMode(p)}
            disabled={!device.online}
            title="パスワードを更新（SSID は変更不可）"
          >
            編集
          </button>
          <button
            className="form-button-danger wifi-profile-btn"
            onClick={() => removeProfile(p.index)}
            disabled={!device.online}
          >
            削除
          </button>
        </div>
      ))}

      {/* ---- Add / edit toggle ---- */}
      <div className="form-action-row" style={{ marginTop: 10 }}>
        <button
          className={addOpen ? 'form-button-secondary' : 'form-button'}
          onClick={() => {
            const next = !addOpen
            setAddOpen(next)
            if (!next) exitEditMode()
            else if (editingIndex === null) {
              setSsid('')
              setPassword('')
            }
          }}
          disabled={!device.online || (count >= max && editingIndex === null && !addOpen)}
          title={count >= max && editingIndex === null ? '最大数に達しています' : ''}
        >
          {addOpen ? '× 閉じる' : '＋ 新規追加'}
        </button>
        <button
          className="form-button-secondary"
          onClick={onRefresh}
          disabled={!device.online}
        >
          ⟳ 一覧取得
        </button>
        <button
          className="form-button-danger"
          onClick={clearAll}
          disabled={!device.online}
        >
          すべて削除 (clear_wifi)
        </button>
      </div>

      {/* ---- Add / edit form ---- */}
      {addOpen && (
        <div className="wifi-add-form">
          <div className="form-row">
            <label>SSID</label>
            <input
              className="form-input"
              value={ssid}
              onChange={(e) => setSsid(e.target.value)}
              placeholder="Wi-Fi SSID"
              disabled={!device.online || editingIndex !== null}
              list={ssidHistory.historyId}
            />
            <datalist id={ssidHistory.historyId}>
              {ssidHistory.history.map((h) => <option key={h} value={h} />)}
            </datalist>
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
                placeholder="(パスワード)"
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
              {editingIndex !== null ? '更新・接続' : '追加・接続'}
            </button>
          </div>
        </div>
      )}

      <div className="form-status muted" style={{ marginTop: 8 }}>
        Wi-Fi 設定変更後はデバイスの再起動が必要です（上部の「再起動」ボタン）。
      </div>
    </div>
  )
}
