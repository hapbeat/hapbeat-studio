import { useCallback, useEffect, useRef, useState } from 'react'
import { useLogStore } from '@/stores/logStore'
import {
  isWebSerialSupported,
  openConfigConnection,
  pickConfigPort,
  type SerialConfigConn,
} from '@/utils/serialConfig'

interface WifiProfileEntry {
  index: number
  ssid: string
  pass?: string
  active?: boolean
}

interface DeviceInfoSnapshot {
  name?: string
  group?: number
  fw?: string
  wifi_connected?: boolean
  wifi_ssid?: string
  wifi_ip?: string
}

interface WifiStatusSnapshot {
  connected?: boolean
  ssid?: string
  ip?: string
  rssi?: number
  channel?: number
}

/**
 * Serial 接続 panel — initial Wi-Fi provisioning via USB serial.
 *
 * Mirrors the Config tab's WifiProfilesForm UX (list + add/edit/delete +
 * per-profile connect, multi-slot status) but routes every command
 * over the open Web Serial port instead of the helper WS. Designed
 * to be the single panel a first-time user sees before their device
 * has joined Wi-Fi.
 */
export function SerialConfigSection() {
  const pushLog = useLogStore((s) => s.push)
  const [conn, setConn] = useState<SerialConfigConn | null>(null)
  const connRef = useRef<SerialConfigConn | null>(null)
  connRef.current = conn

  const [busy, setBusy] = useState(false)
  const [info, setInfo] = useState<DeviceInfoSnapshot | null>(null)
  const [wifiStatus, setWifiStatus] = useState<WifiStatusSnapshot | null>(null)
  const [profiles, setProfiles] = useState<WifiProfileEntry[]>([])
  const [profileMax, setProfileMax] = useState(5)
  const [status, setStatus] = useState<{ kind: 'ok' | 'err' | 'muted'; msg: string } | null>(null)

  // Identity form (right-side fields, parallels Config tab IdentityForm)
  const [name, setName] = useState('')
  const [groupStr, setGroupStr] = useState('0')

  // Wi-Fi add/edit form (mirrors WifiProfilesForm)
  const [addOpen, setAddOpen] = useState(false)
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [ssid, setSsid] = useState('')
  const [pass, setPass] = useState('')
  const [showPass, setShowPass] = useState(false)

  // Disconnect on unmount so the port is always released.
  useEffect(() => {
    return () => {
      const c = connRef.current
      if (c) void c.close().catch(() => { /* already closed */ })
    }
  }, [])

  const refreshAll = useCallback(async (c: SerialConfigConn) => {
    try {
      const r = await c.send({ cmd: 'get_info' })
      setInfo(r as DeviceInfoSnapshot)
      if (typeof r.name === 'string') setName(r.name)
      if (typeof r.group === 'number') setGroupStr(String(r.group))
    } catch (err) {
      pushLog('serial-cfg', `get_info failed: ${(err as Error).message}`)
    }
    try {
      const r = await c.send({ cmd: 'get_wifi_status' })
      setWifiStatus(r as WifiStatusSnapshot)
    } catch { /* old firmware may lack get_wifi_status — skip */ }
    try {
      const r = await c.send({ cmd: 'list_wifi_profiles' })
      const arr = (r.profiles as WifiProfileEntry[] | undefined) ?? []
      const max = (r.max as number | undefined) ?? 5
      setProfiles(arr)
      setProfileMax(max)
    } catch { /* old firmware may lack list_wifi_profiles */ }
  }, [pushLog])

  const onConnect = useCallback(async () => {
    if (conn) return
    setStatus({ kind: 'muted', msg: 'COM ポート選択待ち…' })
    let port: SerialPort
    try {
      port = await pickConfigPort()
    } catch (err) {
      const msg = (err as Error).message ?? String(err)
      if ((err as Error).name === 'AbortError' || /cancel/i.test(msg)) {
        setStatus(null)
        return
      }
      setStatus({ kind: 'err', msg })
      return
    }
    try {
      const c = await openConfigConnection(port, {
        onLog: (line) => pushLog('serial-cfg', line),
        onDisconnect: (reason) => {
          pushLog('serial-cfg', `disconnected (${reason})`)
          setConn(null)
          setInfo(null)
          setProfiles([])
          setWifiStatus(null)
        },
      })
      setConn(c)
      pushLog('serial-cfg', 'connected (921600 baud)')
      setStatus({ kind: 'muted', msg: 'デバイス情報を取得中…' })
      await refreshAll(c)
      setStatus({ kind: 'ok', msg: '接続済み' })
    } catch (err) {
      setStatus({ kind: 'err', msg: `接続失敗: ${(err as Error).message}` })
    }
  }, [conn, pushLog, refreshAll])

  const onDisconnect = useCallback(async () => {
    if (!conn) return
    await conn.close().catch(() => { /* already closed */ })
    setConn(null)
    setInfo(null)
    setWifiStatus(null)
    setProfiles([])
    setStatus({ kind: 'muted', msg: '切断しました' })
  }, [conn])

  /** Run a single command with status/busy plumbing. */
  const runCmd = useCallback(
    async (cmd: Record<string, unknown>, label: string): Promise<Record<string, unknown> | null> => {
      if (!conn) return null
      setBusy(true)
      setStatus({ kind: 'muted', msg: `${label}…` })
      try {
        const r = await conn.send(cmd)
        const ok = r.status === 'ok' || r.status === undefined
        setStatus({
          kind: ok ? 'ok' : 'err',
          msg: `${label}: ${r.message ?? r.status ?? 'done'}`,
        })
        pushLog('serial-cfg', `${label} → ${JSON.stringify(r)}`)
        return r
      } catch (err) {
        setStatus({ kind: 'err', msg: `${label} 失敗: ${(err as Error).message}` })
        return null
      } finally {
        setBusy(false)
      }
    },
    [conn, pushLog],
  )

  // ── Identity ────────────────────────────────────────────────
  const onSetName = useCallback(async () => {
    if (!name.trim()) return
    await runCmd({ cmd: 'set_name', name: name.trim() }, 'set_name')
    if (conn) void refreshAll(conn)
  }, [name, runCmd, conn, refreshAll])

  const onSetGroup = useCallback(async () => {
    const g = Number(groupStr)
    if (!Number.isFinite(g) || g < 0 || g > 255) return
    await runCmd({ cmd: 'set_group', group: g }, 'set_group')
    if (conn) void refreshAll(conn)
  }, [groupStr, runCmd, conn, refreshAll])

  const onReboot = useCallback(async () => {
    if (!confirm('デバイスをリブートしますか？')) return
    await runCmd({ cmd: 'reboot' }, 'reboot')
  }, [runCmd])

  // ── Wi-Fi profile actions ───────────────────────────────────
  const enterEditMode = (p: WifiProfileEntry) => {
    setEditingIndex(p.index)
    setSsid(p.ssid)
    setPass(p.pass ?? '')
    setShowPass(false)
    setAddOpen(true)
  }

  const exitEditMode = () => {
    setEditingIndex(null)
    setSsid('')
    setPass('')
    setShowPass(false)
  }

  const submitProfile = useCallback(async () => {
    if (!ssid.trim()) return
    // Firmware's set_wifi adds-or-updates by SSID; matches the Config
    // tab's add/edit semantics over helper WS.
    await runCmd(
      { cmd: 'set_wifi', ssid: ssid.trim(), pass },
      editingIndex != null ? 'set_wifi (edit)' : 'set_wifi (add)',
    )
    exitEditMode()
    setAddOpen(false)
    if (conn) void refreshAll(conn)
  }, [ssid, pass, editingIndex, runCmd, conn, refreshAll])

  const connectProfile = useCallback(async (idx: number) => {
    await runCmd({ cmd: 'connect_wifi_profile', index: idx }, `connect #${idx}`)
    if (conn) void refreshAll(conn)
  }, [runCmd, conn, refreshAll])

  const removeProfile = useCallback(async (idx: number) => {
    if (!confirm(`プロファイル #${idx} を削除しますか？`)) return
    await runCmd({ cmd: 'remove_wifi_profile', index: idx }, `remove #${idx}`)
    if (conn) void refreshAll(conn)
  }, [runCmd, conn, refreshAll])

  const clearAllProfiles = useCallback(async () => {
    if (!confirm('保存済みの Wi-Fi 設定をすべて削除します。よろしいですか？')) return
    await runCmd({ cmd: 'clear_wifi' }, 'clear_wifi')
    if (conn) void refreshAll(conn)
  }, [runCmd, conn, refreshAll])

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

  // Disconnected: show big Connect CTA. Once connected, render the
  // Identity + Wi-Fi forms (mirrors Config tab layout but driven by
  // serial commands).
  if (!conn) {
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
            onClick={onConnect}
          >
            🔌 USB Serial で接続
          </button>
          <div className="serial-connect-hint">
            デバイスを USB ケーブルで PC に接続し、上のボタンを押すと COM ポート
            選択ダイアログが開きます。接続後は Wi-Fi 設定 / 名前 / グループの
            初期設定がここから行えます。
          </div>
          {status && (
            <div className={`form-status ${status.kind}`} style={{ marginTop: 6 }}>
              {status.msg}
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <>
      {/* ── Header card with disconnect ───────────────────── */}
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
          <button
            className="form-button-secondary"
            onClick={onDisconnect}
            style={{ fontSize: 12, padding: '4px 12px' }}
          >
            切断
          </button>
        </div>
        {status && (
          <div className={`form-status ${status.kind}`}>
            {status.msg}
          </div>
        )}
        {info && (
          <div className="form-status muted" style={{ marginTop: 4 }}>
            <strong>{info.name ?? '(unnamed)'}</strong> · group {info.group ?? '?'} ·
            {' '}fw {info.fw ?? '?'} ·
            {' '}{info.wifi_connected
              ? <>Wi-Fi 接続中 ({info.wifi_ssid ?? '?'} / {info.wifi_ip ?? '?'})</>
              : <>Wi-Fi 未接続</>}
          </div>
        )}
      </div>

      {/* ── Identity (name + group) ──────────────────────── */}
      <div className="form-section">
        <div className="form-section-title">デバイス識別</div>
        <div className="form-row">
          <label>名前</label>
          <input
            className="form-input mono"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="hapbeat-XXXX"
            maxLength={32}
          />
          <button className="form-button" onClick={onSetName} disabled={busy || !name.trim()}>
            変更
          </button>
        </div>
        <div className="form-row">
          <label>グループ</label>
          <input
            className="form-input mono short"
            type="number"
            min={0}
            max={255}
            value={groupStr}
            onChange={(e) => setGroupStr(e.target.value)}
          />
          <button className="form-button" onClick={onSetGroup} disabled={busy}>
            変更
          </button>
        </div>
      </div>

      {/* ── Wi-Fi profiles (mirrors WifiProfilesForm) ────── */}
      <div className="form-section">
        <div className="form-section-title">
          Wi-Fi 設定
          <span className="form-section-sub-inline">
            {' '}保存済み {profiles.length}/{profileMax}
          </span>
        </div>
        {wifiStatus && (
          <div className="form-status muted" style={{ marginBottom: 6 }}>
            現在: {wifiStatus.connected
              ? <>接続中 · SSID={wifiStatus.ssid} · {wifiStatus.ip}
                  {typeof wifiStatus.rssi === 'number' && <> · {wifiStatus.rssi} dBm</>}
                  {typeof wifiStatus.channel === 'number' && <> · ch{wifiStatus.channel}</>}
                </>
              : '未接続'}
          </div>
        )}

        {profiles.length === 0 && (
          <div className="form-status muted">
            （保存された Wi-Fi 設定はありません）
          </div>
        )}
        {profiles.map((p) => (
          <div key={p.index} className="wifi-profile-row">
            <span className={`wifi-profile-marker${p.active ? ' active' : ''}`}>
              {p.active ? '●' : '○'}
            </span>
            <span className="wifi-profile-ssid mono">{p.ssid}</span>
            {!p.active && (
              <button
                className="form-button-secondary wifi-profile-btn"
                onClick={() => connectProfile(p.index)}
                disabled={busy}
              >
                接続
              </button>
            )}
            {p.active && <span className="wifi-profile-badge">接続中</span>}
            <button
              className="form-button-secondary wifi-profile-btn"
              onClick={() => enterEditMode(p)}
              disabled={busy}
            >
              編集
            </button>
            <button
              className="form-button-danger wifi-profile-btn"
              onClick={() => removeProfile(p.index)}
              disabled={busy}
            >
              削除
            </button>
          </div>
        ))}

        {addOpen ? (
          <div className="wifi-add-form">
            <div className="form-row">
              <label>SSID</label>
              <input
                className="form-input mono"
                value={ssid}
                onChange={(e) => setSsid(e.target.value)}
                placeholder="例: MyHomeWiFi"
                disabled={editingIndex != null}
              />
              <span />
            </div>
            <div className="form-row">
              <label>パスワード</label>
              <div className="form-row-multi" style={{ width: '100%' }}>
                <input
                  className="form-input mono"
                  type={showPass ? 'text' : 'password'}
                  value={pass}
                  onChange={(e) => setPass(e.target.value)}
                  placeholder="(空欄 = 無認証 / 既存 pass を流用)"
                  style={{ flex: 1 }}
                />
                <button
                  type="button"
                  className="form-button-secondary"
                  onClick={() => setShowPass((v) => !v)}
                  style={{ fontSize: 11, padding: '4px 8px' }}
                >
                  {showPass ? '隠す' : '表示'}
                </button>
              </div>
              <span />
            </div>
            <div className="form-action-row">
              <button
                className="form-button"
                onClick={submitProfile}
                disabled={busy || !ssid.trim()}
              >
                {editingIndex != null ? '更新' : '追加'}
              </button>
              <button
                className="form-button-secondary"
                onClick={() => {
                  exitEditMode()
                  setAddOpen(false)
                }}
                disabled={busy}
              >
                キャンセル
              </button>
            </div>
          </div>
        ) : (
          <div className="form-action-row">
            <button
              className="form-button"
              onClick={() => {
                exitEditMode()
                setAddOpen(true)
              }}
              disabled={busy || profiles.length >= profileMax}
              title={profiles.length >= profileMax
                ? `保存上限 (${profileMax}) に達しています — 既存プロファイルを削除してください`
                : ''}
            >
              ＋ 新規追加
            </button>
            <button
              className="form-button-secondary"
              onClick={() => conn && refreshAll(conn)}
              disabled={busy}
            >
              ⟳ 一覧取得
            </button>
            <button
              className="form-button-danger"
              onClick={clearAllProfiles}
              disabled={busy || profiles.length === 0}
            >
              すべて削除 (clear_wifi)
            </button>
          </div>
        )}

        <div className="form-status muted" style={{ marginTop: 6 }}>
          Wi-Fi 設定変更後はデバイスのリブートが必要です。
        </div>
        <div className="form-action-row">
          <button
            className="form-button-secondary"
            onClick={onReboot}
            disabled={busy}
          >
            リブート
          </button>
        </div>
      </div>
    </>
  )
}
