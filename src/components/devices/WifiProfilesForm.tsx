import { useCallback, useEffect, useRef, useState } from 'react'
import type { DeviceInfo, ManagerMessage } from '@/types/manager'
import type { WifiProfile } from '@/stores/deviceStore'
import { useHelperConnection } from '@/hooks/useHelperConnection'
import { useInputHistory } from '@/hooks/useInputHistory'
import { useSerialMaster, type SerialWifiNetwork } from '@/stores/serialMaster'

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
  // Custom combobox state — replaces the native HTML <datalist>.
  // Reasons we replaced datalist:
  //   - the native ▼ is browser-/OS-skin-dependent and sometimes
  //     hidden until the field is focused, so users couldn't tell
  //     options were available
  //   - we want to auto-pick the strongest scan result the moment a
  //     scan finishes, without forcing the user to open the menu
  //   - we want history rows to be styled differently (greyed) and
  //     dB/channel to render with consistent typography across browsers
  const [menuOpen, setMenuOpen] = useState(false)
  const ssidWrapRef = useRef<HTMLDivElement | null>(null)

  // SSID candidates can come from any of three sources, ranked by
  // relevance:
  //   1. Device's own scan (Serial path: `WiFi.scanNetworks()`)
  //   2. PC-side scan via Helper (`scan_wifi` WS message → OS netsh /
  //      airport / nmcli). Studio assumes PC + Hapbeat are on the
  //      same LAN, so the PC's neighborhood is a good stand-in when
  //      the device can't be queried (e.g. it isn't reachable yet).
  //   3. localStorage SSID history (SSID-only, never the password)
  // Sources 1+3 are both used on Serial; sources 2+3 on LAN.
  const isSerial = device.ipAddress.startsWith('serial:')
  const masterScanWifi = useSerialMaster((s) => s.scanWifi)
  const { send: helperSend, lastMessage } = useHelperConnection()
  const [scanResults, setScanResults] = useState<SerialWifiNetwork[]>([])
  const [scanState, setScanState] = useState<'idle' | 'scanning' | 'done' | 'error'>('idle')
  const ssidHistory = useInputHistory('wifi-ssid')

  const runScan = useCallback(async () => {
    setScanState('scanning')
    if (isSerial) {
      // Device's own WiFi.scanNetworks() — most accurate, reflects
      // what the Hapbeat itself can see when it's powered on at the
      // user's location.
      try {
        const r = await masterScanWifi()
        setScanResults(r)
        setScanState('done')
      } catch {
        setScanResults([])
        setScanState('error')
      }
      return
    }
    // LAN device — ask Helper to run an OS-side scan. The reply
    // arrives async via lastMessage (`scan_wifi_result`); the effect
    // below picks it up. Studio + PC + Hapbeat share a LAN by
    // assumption, so the PC's neighborhood approximates the device's.
    helperSend({ type: 'scan_wifi', payload: {} })
  }, [isSerial, masterScanWifi, helperSend])

  // Drain Helper's scan_wifi_result. Only set state while a scan is
  // actually in flight (scanState === 'scanning') so a late reply from
  // a device-switch race doesn't overwrite the new view's results.
  useEffect(() => {
    if (!lastMessage || lastMessage.type !== 'scan_wifi_result') return
    if (scanState !== 'scanning' || isSerial) return
    const p = lastMessage.payload as Record<string, unknown>
    const networks = (p.networks as SerialWifiNetwork[] | undefined) ?? []
    const error = p.error as string | undefined
    if (error && networks.length === 0) {
      setScanResults([])
      setScanState('error')
    } else {
      setScanResults(networks)
      setScanState('done')
    }
  }, [lastMessage, scanState, isSerial])

  // Auto-fill the field with the strongest scan result the moment a
  // scan finishes — only when the user hasn't typed anything yet
  // (so manual edits aren't clobbered) and we're not editing an
  // existing profile (SSID is locked in edit mode anyway).
  useEffect(() => {
    if (scanState !== 'done' || scanResults.length === 0) return
    if (editingIndex !== null) return
    if (ssid.trim() !== '') return
    setSsid(scanResults[0].ssid)
  }, [scanState, scanResults, editingIndex, ssid])

  // Close the dropdown when the user clicks outside its wrapper.
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (ev: MouseEvent) => {
      const root = ssidWrapRef.current
      if (root && !root.contains(ev.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [menuOpen])

  // Combined option list shown in the dropdown — scan first (with
  // signal info), then history (greyed). Skip history items already
  // in scan to avoid duplicates.
  const dropdownOptions = (() => {
    type Opt = { ssid: string; kind: 'scan' | 'history'; meta?: string }
    const opts: Opt[] = scanResults.map((n) => ({
      ssid: n.ssid,
      kind: 'scan',
      meta: `${n.rssi}dBm${n.channel ? ` ch${n.channel}` : ''}${n.auth ? ` ${n.auth}` : ''}`,
    }))
    for (const h of ssidHistory.history) {
      if (!opts.some((o) => o.ssid === h)) {
        opts.push({ ssid: h, kind: 'history' })
      }
    }
    return opts
  })()

  // Reset form state when the user picks a different device.
  useEffect(() => {
    setAddOpen(false)
    setEditingIndex(null)
    setSsid('')
    setPassword('')
    setShowPass(false)
    setScanResults([])
    setScanState('idle')
  }, [device.ipAddress])

  // Auto-scan when the user opens the add form (Serial only — LAN
  // scan isn't wired through firmware yet).
  useEffect(() => {
    if (addOpen && editingIndex === null && scanState === 'idle') {
      void runScan()
    }
  }, [addOpen, editingIndex, scanState, runScan])

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
    // Save SSID only — never the password — so a re-onboarding user
    // can pick a previously-typed SSID from the datalist without
    // having to re-type. Password is intentionally excluded from
    // localStorage to avoid plaintext credential persistence.
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
            <div
              className="form-row-multi"
              style={{ width: '100%', flexWrap: 'nowrap' }}
              ref={ssidWrapRef}
            >
              <div
                className="ssid-combobox"
                style={{ flex: 1, position: 'relative', minWidth: 0 }}
              >
                <input
                  className="form-input"
                  value={ssid}
                  onChange={(e) => setSsid(e.target.value)}
                  onFocus={() => {
                    if (dropdownOptions.length > 0) setMenuOpen(true)
                  }}
                  placeholder="Wi-Fi SSID"
                  disabled={!device.online || editingIndex !== null}
                  style={{ width: '100%', paddingRight: 28 }}
                />
                <button
                  type="button"
                  className="ssid-combobox-toggle"
                  onClick={() => setMenuOpen((v) => !v)}
                  /* Always enabled — the user explicitly asked for the
                   * dropdown to be reachable even after typing. The
                   * dropdown is the primary picker; manual entry is
                   * the last-resort path. */
                  disabled={editingIndex !== null}
                  aria-label="SSID 候補を開く"
                  title="候補から選ぶ"
                >
                  ▼
                </button>
                {menuOpen && dropdownOptions.length > 0 && (
                  <ul
                    className="ssid-combobox-menu"
                    role="listbox"
                  >
                    {dropdownOptions.map((opt) => (
                      <li
                        key={`${opt.kind}-${opt.ssid}`}
                        role="option"
                        aria-selected={opt.ssid === ssid}
                        className={`ssid-combobox-item ${opt.kind}${opt.ssid === ssid ? ' selected' : ''}`}
                        onMouseDown={(e) => {
                          // mousedown so the input doesn't blur away
                          // the menu before the click registers.
                          e.preventDefault()
                          setSsid(opt.ssid)
                          setMenuOpen(false)
                        }}
                      >
                        <span className="ssid-combobox-name">{opt.ssid}</span>
                        <span className="ssid-combobox-meta">
                          {opt.kind === 'scan' ? opt.meta : '履歴'}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <button
                type="button"
                className="form-button-secondary"
                onClick={() => void runScan()}
                disabled={scanState === 'scanning' || editingIndex !== null}
                title={
                  isSerial
                    ? 'デバイスに WiFi.scanNetworks() を実行させる (約 3 秒)'
                    : 'PC 側で OS-native な Wi-Fi スキャンを実行'
                }
                style={{ flexShrink: 0, whiteSpace: 'nowrap' }}
              >
                {scanState === 'scanning' ? 'スキャン中…' : '⟳ スキャン'}
              </button>
            </div>
            <span />
          </div>
          {editingIndex === null && (
            <div className="form-status muted" style={{ padding: '0 4px' }}>
              {scanState === 'scanning' && (
                isSerial
                  ? 'デバイス側で SSID をスキャン中…'
                  : 'PC 側で SSID をスキャン中…'
              )}
              {scanState === 'done' && scanResults.length === 0 && (
                'スキャン結果なし — SSID を手動で入力してください'
              )}
              {scanState === 'done' && scanResults.length > 0 && (
                `候補 ${scanResults.length} 件 (信号強度順)`
              )}
              {scanState === 'error' && 'スキャン失敗 — SSID を手動で入力してください'}
            </div>
          )}
          <div className="form-row">
            <label>パスワード</label>
            <div
              className="form-row-multi"
              style={{ width: '100%', flexWrap: 'nowrap' }}
            >
              <input
                className="form-input"
                type={showPass ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="(パスワード)"
                disabled={!device.online}
                autoComplete="off"
                /* flex:1 so the input absorbs available width — without
                 * this the .form-input `width: 100%` claims the whole
                 * row and the 表示 button got pushed to a new line. */
                style={{ flex: 1, minWidth: 0 }}
              />
              <button
                className="form-button-secondary"
                onClick={() => setShowPass((v) => !v)}
                type="button"
                /* keep the 2-char label on one line regardless of
                 * font / locale changes. */
                style={{ flexShrink: 0, whiteSpace: 'nowrap' }}
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
