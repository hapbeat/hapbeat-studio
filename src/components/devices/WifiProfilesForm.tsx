import { useCallback, useEffect, useRef, useState } from 'react'
import type { DeviceInfo, ManagerMessage } from '@/types/manager'
import type { WifiProfile } from '@/stores/deviceStore'
import { useHelperConnection } from '@/hooks/useHelperConnection'
import { useToast } from '@/components/common/Toast'
import { useSerialMaster, type SerialWifiNetwork } from '@/stores/serialMaster'
import { confirmsPresetConnection, useWifiPresets, type WifiPresetPending } from '@/stores/wifiPresets'
import type { WifiBulkSummary, WifiCredentials } from '@/utils/wifiSerialWrite'
import { useI18n } from '@/i18n/I18nProvider'
import { wifiBulkItemDone, wifiBulkItemText } from './wifiBulkText'

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
  /** Number of USB-serial cards currently selected (serial path only). When
   *  > 1, a "選択中の N 台に書き込む" button appears that writes the SAME
   *  Wi-Fi to all of them and confirms each (serialMaster.bulkSetWifi).
   *  0/undefined = the LAN path or a single device → no bulk button. */
  bulkCount?: number
  /** Write this Wi-Fi to all selected USB-serial devices. Resolves to the
   *  counts, or null when a run was already in progress. */
  onBulkApply?: (creds: WifiCredentials) => Promise<WifiBulkSummary | null>
  /** True when there's a live 設定-connected USB-serial device (the one
   *  this form is editing) whose port is NOT in the ✔ 書込対象 (bulk write
   *  target) set — the bulk button below would skip it. Surfaced as a
   *  warning next to the bulk button instead of silently diverging. */
  configConnectedNotChecked?: boolean
  /** Re-read the device's Wi-Fi status (get_wifi_status). Polled after a
   *  single-device write to see it connect before saving the network on
   *  this PC. */
  onRefreshStatus?: () => void
}

/** After a single-device write, how often to re-read the Wi-Fi status and
 *  how long to wait for it to connect before giving up on saving it here.
 *  The firmware retries a network every 5 s (wifi_manager.cpp). */
const REMEMBER_POLL_MS = 2000
const REMEMBER_WAIT_MS = 20000

type RememberNote = { kind: 'checking' | 'saved' | 'notSaved' | 'unavailable'; ssid: string }
const REMEMBER_NOTE_ID = {
  checking: 'wifi.presets.note.checking',
  saved: 'wifi.presets.note.saved',
  notSaved: 'wifi.presets.note.notSaved',
  unavailable: 'wifi.presets.note.unavailable',
} as const

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
  bulkCount = 0,
  onBulkApply,
  configConnectedNotChecked = false,
  onRefreshStatus,
}: Props) {
  const { t } = useI18n()
  // Networks saved on this PC (localStorage, stores/wifiPresets.ts).
  const presets = useWifiPresets((s) => s.presets)
  const rememberPreset = useWifiPresets((s) => s.remember)
  const removePreset = useWifiPresets((s) => s.remove)
  const clearPresets = useWifiPresets((s) => s.clear)
  const [remember, setRemember] = useState(true)
  const [rememberNote, setRememberNote] = useState<RememberNote | null>(null)
  // The single-device write waiting to be seen connected. A ref, so the
  // password is not kept in render state longer than the form needs it.
  const pendingRef = useRef<(WifiPresetPending & { pass: string }) | null>(null)
  const refreshStatusRef = useRef(onRefreshStatus)
  refreshStatusRef.current = onRefreshStatus
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

  // SSID candidates always come from Helper-side OS scan
  // (netsh / airport / nmcli on the PC running Studio).
  // The PC and Hapbeat share a LAN by assumption (otherwise Helper
  // can't talk to LAN devices), so PC neighborhood ≈ device neighborhood.
  // Device-side `WiFi.scanNetworks()` was previously used for Serial
  // path but failed during onboarding (radio not initialized in
  // factory state), so we unified to Helper-only.
  const { send: helperSend, lastMessage } = useHelperConnection()
  // 書込み結果トーストは HelperFailureToastListener が write_result ベースで出す。
  const { setAnchor } = useToast()
  const [scanResults, setScanResults] = useState<SerialWifiNetwork[]>([])
  const [scanState, setScanState] = useState<'idle' | 'scanning' | 'done' | 'error'>('idle')

  const runScan = useCallback(() => {
    setScanState('scanning')
    helperSend({ type: 'scan_wifi', payload: {} })
  }, [helperSend])

  // Drain Helper's scan_wifi_result. Only set state while a scan is
  // actually in flight (scanState === 'scanning') so a late reply from
  // a device-switch race doesn't overwrite the new view's results.
  useEffect(() => {
    if (!lastMessage || lastMessage.type !== 'scan_wifi_result') return
    if (scanState !== 'scanning') return
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
  }, [lastMessage, scanState])

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

  // Dropdown: networks saved on this PC first (picking one fills the
  // password too), then the Helper-side OS scan results (netsh / airport /
  // nmcli) in signal-strength order. A scanned network that is also saved
  // shows once, as the saved row with its signal.
  const scanMeta = (n: SerialWifiNetwork) =>
    `${n.rssi}dBm${n.channel ? ` ch${n.channel}` : ''}${n.auth ? ` ${n.auth}` : ''}`
  const dropdownOptions: Array<{ kind: 'preset' | 'scan'; ssid: string; meta: string; password?: string }> = [
    ...presets.map((p) => {
      const seen = scanResults.find((n) => n.ssid === p.ssid)
      return {
        kind: 'preset' as const,
        ssid: p.ssid,
        password: p.password,
        meta: seen ? `${t('wifi.presets.optionMeta')} · ${scanMeta(seen)}` : t('wifi.presets.optionMeta'),
      }
    }),
    ...scanResults
      .filter((n) => !presets.some((p) => p.ssid === n.ssid))
      .map((n) => ({ kind: 'scan' as const, ssid: n.ssid, meta: scanMeta(n) })),
  ]

  // Reset form state when the user picks a different device.
  useEffect(() => {
    setAddOpen(false)
    setEditingIndex(null)
    setSsid('')
    setPassword('')
    setShowPass(false)
    setScanResults([])
    setScanState('idle')
    pendingRef.current = null
    setRememberNote(null)
  }, [device.ipAddress])

  // Auto-scan when the user opens the add form, unless networks are saved
  // on this PC: then they pick one and scan only with the button (so the
  // form works without the helper).
  const hasPresets = presets.length > 0
  useEffect(() => {
    if (addOpen && editingIndex === null && scanState === 'idle' && !hasPresets) {
      void runScan()
    }
  }, [addOpen, editingIndex, scanState, runScan, hasPresets])

  // A single-device write is saved on this PC only once a fresh status shows
  // the device connected to that network (a typo is never saved).
  useEffect(() => {
    const p = pendingRef.current
    if (p && confirmsPresetConnection(p, wifiStatus, Date.now())) {
      pendingRef.current = null
      const ok = rememberPreset({ ssid: p.ssid, pass: p.pass })
      setRememberNote({ kind: ok ? 'saved' : 'unavailable', ssid: p.ssid })
    }
  }, [wifiStatus, rememberPreset])

  // While waiting, re-read the status; give up after REMEMBER_WAIT_MS.
  const checking = rememberNote?.kind === 'checking'
  useEffect(() => {
    if (!checking) return
    const poll = setInterval(() => refreshStatusRef.current?.(), REMEMBER_POLL_MS)
    const giveUp = setTimeout(() => {
      pendingRef.current = null
      setRememberNote((n) => (n?.kind === 'checking' ? { kind: 'notSaved', ssid: n.ssid } : n))
    }, REMEMBER_WAIT_MS)
    return () => {
      clearInterval(poll)
      clearTimeout(giveUp)
    }
  }, [checking])

  const enterEditMode = (p: WifiProfile) => {
    setEditingIndex(p.index)
    setSsid(p.ssid)
    setPassword('')   // 編集時は常に空欄。上書きするには再入力必須。
    setAddOpen(true)
  }

  const exitEditMode = () => {
    setEditingIndex(null)
    setSsid('')
    setPassword('')
  }

  const submit = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (!ssid.trim()) return
    setAnchor(e.currentTarget)
    const targetSsid = ssid.trim()
    // password が空欄の場合は pass フィールド自体を含めない
    // (空文字送信で既存パスワードを破壊しないよう write-only 仕様に準拠)
    // Send both `pass` and `password` so the call works on either
    // transport without per-route translation:
    //   - LAN → Helper: helper accepts both keys (server.py:269)
    //   - Serial → firmware: firmware reads `pass` (serial_config.cpp)
    const passFields = password.length > 0 ? { pass: password, password } : {}
    sendTo({
      type: 'set_wifi',
      payload: { ssid: targetSsid, ...passFields },
    })
    // Save it on this PC once the device is seen connected. Editing with an
    // empty password keeps the device's password, which this PC never knew.
    if (remember && (editingIndex === null || password.length > 0)) {
      pendingRef.current = { ssid: targetSsid, pass: password, at: Date.now(), baseline: wifiStatus }
      setRememberNote({ kind: 'checking', ssid: targetSsid })
    }
    exitEditMode()
    setAddOpen(false)
    // 成功/失敗は HelperFailureToastListener が write_result ベースで出す（結果ベース）。
    // Refresh the profile list — the firmware doesn't push, we poll.
    setTimeout(onRefresh, 800)
  }

  // Bulk: write the SAME Wi-Fi to every checked USB-serial device and
  // confirm each (serialMaster.bulkSetWifi via the parent's onBulkApply).
  // The form stays open while it runs; it closes only when every device
  // took it, so a retry needs no retyping.
  const bulkRunning = useSerialMaster((s) => s.wifiBulk?.running ?? false)
  const submitBulk = async (e: React.MouseEvent<HTMLButtonElement>) => {
    if (!ssid.trim() || !onBulkApply || bulkRunning) return
    setAnchor(e.currentTarget)
    const creds = { ssid: ssid.trim(), pass: password }
    const r = await onBulkApply(creds)
    // Saved on this PC when at least one device connected with it.
    if (r && remember) {
      const ok = r.connected > 0 && rememberPreset(creds)
      setRememberNote({ kind: r.connected === 0 ? 'notSaved' : ok ? 'saved' : 'unavailable', ssid: creds.ssid })
    }
    if (r && r.failed === 0) {
      exitEditMode()
      setAddOpen(false)
    }
  }

  const connectProfile = (e: React.MouseEvent<HTMLButtonElement>, idx: number) => {
    setAnchor(e.currentTarget)
    sendTo({ type: 'connect_wifi_profile', payload: { index: idx } })
  }

  const removeProfile = (e: React.MouseEvent<HTMLButtonElement>, idx: number) => {
    const btn = e.currentTarget
    if (!confirm(t('wifi.deleteProfileConfirm', { index: idx }))) return
    setAnchor(btn)
    sendTo({ type: 'remove_wifi_profile', payload: { index: idx } })
    setTimeout(onRefresh, 500)
  }

  const clearAll = (e: React.MouseEvent<HTMLButtonElement>) => {
    const btn = e.currentTarget
    if (!confirm(t('wifi.clearProfilesConfirm'))) return
    setAnchor(btn)
    sendTo({ type: 'clear_wifi', payload: {} })
    setTimeout(onRefresh, 500)
  }

  return (
    <div className="form-section">
      <div
        className="form-section-title"
        style={{ display: 'flex', justifyContent: 'space-between' }}
      >
        <span>{t('wifi.title')}</span>
        <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>
          {t('wifi.savedCount', { count, max })}
        </span>
      </div>

      {wifiStatus && (
        <div className="form-status muted" style={{ marginBottom: 8 }}>
          {t('wifi.current', { state: wifiStatus.connected ? t('wifi.connected') : t('wifi.disconnected') })}
          {wifiStatus.ssid && <> · SSID={wifiStatus.ssid}</>}
          {wifiStatus.ip && <> · {wifiStatus.ip}</>}
          {wifiStatus.rssi !== undefined && <> · {wifiStatus.rssi}dBm</>}
          {wifiStatus.channel !== undefined && <> · ch{wifiStatus.channel}</>}
        </div>
      )}

      {/* ---- Profile list ---- */}
      {profiles.length === 0 && (
        <div className="form-status muted" style={{ marginBottom: 8 }}>
          {t('wifi.none')}
        </div>
      )}
      {profiles.map((p) => (
        <div key={p.index} className="wifi-profile-row">
          {p.active ? (
            <span
              className="wifi-profile-marker active"
              title={t('wifi.activeTitle')}
              aria-label={t('wifi.connected')}
            >
              ●
            </span>
          ) : (
            // 非接続プロファイルは marker を出さない (○ があるとクリックで
            // チェック切替できるように見えてしまうため)。レイアウトずれを
            // 防ぐため空の span でスペースだけ確保する。
            <span className="wifi-profile-marker" aria-hidden="true" />
          )}
          <span className="wifi-profile-ssid">
            {p.ssid || '(no SSID)'}
            {p.has_pass && (
              <span
                title={t('wifi.passwordSavedTitle')}
                style={{ marginLeft: 4, opacity: 0.6, fontSize: '0.85em' }}
              >
                🔒
              </span>
            )}
          </span>
          {p.active ? (
            <span className="wifi-profile-badge">{t('wifi.connected')}</span>
          ) : (
            <button
              className="form-button-secondary wifi-profile-btn"
              onClick={(e) => connectProfile(e, p.index)}
              disabled={!device.online}
            >
              {t('wifi.connect')}
            </button>
          )}
          <button
            className="form-button-secondary wifi-profile-btn"
            onClick={() => enterEditMode(p)}
            disabled={!device.online}
            title={t('wifi.editPasswordTitle')}
          >
            {t('wifi.edit')}
          </button>
          <button
            className="form-button-danger wifi-profile-btn"
            onClick={(e) => removeProfile(e, p.index)}
            disabled={!device.online}
          >
            {t('wifi.remove')}
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
          {addOpen ? t('wifi.close') : t('wifi.new')}
        </button>
        <button
          className="form-button-secondary"
          onClick={onRefresh}
          disabled={!device.online}
        >
          {t('wifi.refresh')}
        </button>
        <button
          className="form-button-danger"
          onClick={clearAll}
          disabled={!device.online}
        >
          {t('wifi.clearAll')}
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
                  aria-label={t('wifi.openCandidates')}
                  title={t('wifi.chooseCandidate')}
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
                          if (opt.kind === 'preset') {
                            setPassword(opt.password ?? '')
                            setShowPass(false)
                          }
                          setMenuOpen(false)
                        }}
                      >
                        <span className="ssid-combobox-name">
                          {opt.kind === 'preset' && <span className="ssid-combobox-mark" aria-hidden="true">★</span>}
                          {opt.ssid}
                        </span>
                        <span className="ssid-combobox-meta">{opt.meta}</span>
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
                title={t('wifi.scanTitle')}
                style={{ flexShrink: 0, whiteSpace: 'nowrap' }}
              >
                {scanState === 'scanning' ? t('wifi.scanning') : t('wifi.scan')}
              </button>
            </div>
            <span />
          </div>
          {editingIndex === null && (
            <div className="form-status muted" style={{ padding: '0 4px', minHeight: 18 }}>
              {scanState === 'idle' && hasPresets && t('wifi.presets.pickOrScan')}
              {scanState === 'scanning' && t('wifi.scanStatus.scanning')}
              {scanState === 'done' && scanResults.length === 0 && t('wifi.scanStatus.none')}
              {scanState === 'done' && scanResults.length > 0 && t('wifi.scanStatus.found', { count: scanResults.length })}
              {scanState === 'error' && t('wifi.scanStatus.error')}
            </div>
          )}
          <div className="form-row">
            <label>{t('wifi.password')}</label>
            <div
              className="form-row-multi"
              style={{ width: '100%', flexWrap: 'nowrap' }}
            >
              <input
                className="form-input"
                type={showPass ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={
                  editingIndex !== null
                    ? '変更する場合のみ入力。空欄なら現在のパスワードを維持'
                    : '(パスワード)'
                }
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
          <label className="wifi-remember" title={t('wifi.presets.rememberTitle')}>
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            <span>{t('wifi.presets.remember')}</span>
          </label>
          {/* Bulk apply: same Wi-Fi to all selected (✔ 書込対象) USB-serial
              devices, one at a time. Only in add mode (edit targets one
              profile) and when >1 device is selected. A fixed-height status
              line sits above the button — normally the target summary, or a
              warning when the 設定-connected device (the one this form is
              editing) isn't itself in the checked set, since the bulk write
              would then skip it (layout-shift rule: same slot either way). */}
          {editingIndex === null && bulkCount > 1 && onBulkApply && (
            <>
              <div
                className={`form-status ${configConnectedNotChecked ? 'warn' : 'muted'}`}
                style={{ marginTop: 8, minHeight: 18 }}
              >
                {configConnectedNotChecked
                  ? t('wifi.bulk.activeNotChecked')
                  : t('wifi.bulk.targets', { count: bulkCount })}
              </div>
              <div className="form-action-row" style={{ marginTop: 4 }}>
                <button
                  className="form-button"
                  onClick={(e) => void submitBulk(e)}
                  disabled={!ssid.trim() || bulkRunning}
                  title={t('wifi.bulkTitle')}
                  style={{ width: '100%' }}
                >
                  {t('wifi.bulkWrite', { count: bulkCount })}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {onBulkApply && <WifiBulkResult />}

      {/* ---- Networks saved on this PC (SSID only; never the password) ---- */}
      {(presets.length > 0 || rememberNote) && (
        <div className="wifi-presets">
          <div className="wifi-presets-head">
            <span className="wifi-presets-title">{t('wifi.presets.title')}</span>
            {presets.length > 0 && (
              <button
                type="button"
                className="form-button-secondary wifi-profile-btn"
                onClick={() => {
                  if (confirm(t('wifi.presets.clearConfirm'))) clearPresets()
                }}
              >
                {t('wifi.presets.clearAll')}
              </button>
            )}
          </div>
          {rememberNote && (
            <div
              className={`form-status ${
                rememberNote.kind === 'saved' ? 'ok' : rememberNote.kind === 'checking' ? 'muted' : 'warn'
              }`}
            >
              {t(REMEMBER_NOTE_ID[rememberNote.kind], { ssid: rememberNote.ssid })}
            </div>
          )}
          {presets.length > 0 && (
            <ul className="wifi-presets-list">
              {presets.map((p) => (
                <li key={p.ssid} className="wifi-presets-item">
                  <span className="wifi-presets-ssid">{p.ssid}</span>
                  <button
                    type="button"
                    className="form-button-danger wifi-profile-btn"
                    onClick={() => removePreset(p.ssid)}
                    title={t('wifi.presets.removeTitle', { ssid: p.ssid })}
                    aria-label={t('wifi.presets.removeTitle', { ssid: p.ssid })}
                  >
                    🗑
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="form-status muted" style={{ marginTop: 8 }}>
        {t('wifi.restartNote')}
      </div>
    </div>
  )
}

/** The last bulk Wi-Fi write: progress while it runs, then each device's
 *  result with what to check. Stays until dismissed or the next run. */
function WifiBulkResult() {
  const { t } = useI18n()
  const run = useSerialMaster((s) => s.wifiBulk)
  const clearWifiBulk = useSerialMaster((s) => s.clearWifiBulk)
  if (!run) return null
  const done = run.items.filter(wifiBulkItemDone).length
  const connected = run.items.filter((i) => i.state === 'connected').length
  const saved = connected + run.items.filter((i) => i.state === 'saved').length
  const failed = run.items.filter((i) => i.state === 'failed').length
  return (
    <div className="wifi-bulk-result">
      <div className="wifi-bulk-result-head">
        <span className="wifi-bulk-result-title">{t('wifi.bulk.panelTitle', { ssid: run.ssid })}</span>
        <button
          type="button"
          className="form-button-secondary wifi-profile-btn"
          onClick={clearWifiBulk}
          disabled={run.running}
        >
          {t('wifi.bulk.dismiss')}
        </button>
      </div>
      <div className={`form-status ${run.running ? 'muted' : failed > 0 ? 'err' : saved > connected ? 'warn' : 'ok'}`}>
        {run.running
          ? t('wifi.bulk.progress', { done, total: run.items.length })
          : t('wifi.bulk.summary', { saved, total: run.items.length, connected, failed })}
      </div>
      <ul className="wifi-bulk-result-list">
        {run.items.map((item) => {
          const v = wifiBulkItemText(t, item)
          return (
            <li key={item.id} className="wifi-bulk-result-item">
              <span className="wifi-bulk-result-name">{item.label}</span>
              <span className={`wifi-bulk-result-state ${v.tone}`}>{v.text}</span>
              {v.hint && <span className="wifi-bulk-result-hint">{v.hint}</span>}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
