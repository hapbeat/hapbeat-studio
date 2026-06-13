import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useHelperConnection } from '@/hooks/useHelperConnection'
import { useDeviceStore } from '@/stores/deviceStore'
import {
  serialEntryLabel,
  useSerialMaster,
  type SerialPortEntry,
} from '@/stores/serialMaster'
import { isWebSerialSupported } from '@/utils/serialConfig'
import { roleBadge } from '@/utils/roleLabels'
import type { ManagerMessage } from '@/types/manager'

/**
 * `serial:<mac-or-rand>` is the convention for a pseudo-device entry
 * in the sidebar that's connected via USB Serial only (i.e. before
 * Wi-Fi setup). The detail pane recognizes the prefix and renders the
 * Serial-config forms instead of the LAN-based DeviceDetail tabs.
 */
export const SERIAL_DEVICE_PREFIX = 'serial:'

/**
 * Manual rescan trigger.
 * Sends `rescan` to Helper which fires an immediate UDP broadcast PING
 * and pushes the latest device_list ~250ms later.
 *
 * Visual feedback: spin the icon for 700ms (matches the broadcast +
 * pong + push round-trip) so the user sees the action registered even
 * if no device state actually changes.
 */
function RefreshButton({ send }: { send: (msg: ManagerMessage) => void }) {
  const [spinning, setSpinning] = useState(false)
  const onClick = useCallback(() => {
    send({ type: 'rescan', payload: {} })
    setSpinning(true)
    window.setTimeout(() => setSpinning(false), 700)
  }, [send])
  return (
    <button
      type="button"
      className={`devices-sidebar-refresh${spinning ? ' spinning' : ''}`}
      onClick={onClick}
      title="デバイス検索を再実行"
      aria-label="再スキャン"
    >
      ⟳
    </button>
  )
}

/**
 * USB serial port cards — every granted Web Serial port, flashed or
 * blank. Identity is bridge chip + VID:PID until a probe (or config
 * conn) fills in name/fw/role. Checkbox feeds the multi-flash target
 * set (`selectedPortIds`); 接続 opens the config conn on that port.
 * Independent of Helper — renders even when the daemon is down.
 */
function UsbPortCard({ entry }: { entry: SerialPortEntry }) {
  const activePortId = useSerialMaster((s) => s.activePortId)
  const mode = useSerialMaster((s) => s.mode)
  const selectedPortIds = useSerialMaster((s) => s.selectedPortIds)
  const toggleSelectPort = useSerialMaster((s) => s.toggleSelectPort)
  const probePort = useSerialMaster((s) => s.probePort)
  const openConfigFor = useSerialMaster((s) => s.openConfigFor)
  const selectedIp = useDeviceStore((s) => s.selectedIp)
  const selectDevice = useDeviceStore((s) => s.selectDevice)

  const checked = selectedPortIds.includes(entry.id)
  const isActive = entry.id === activePortId && mode === 'config'
  // The active card doubles as the sidebar entry for the serial
  // pseudo-device (`serial:<mac>`) — there's no separate card in the
  // LAN section anymore.
  const pseudoId = `${SERIAL_DEVICE_PREFIX}${entry.info?.mac ?? 'active'}`
  const isPrimary = isActive && selectedIp === pseudoId
  const probing = entry.probe === 'connecting'
  const f = entry.flash

  return (
    <div
      className={`device-row usb${checked ? ' checked' : ''}${isPrimary ? ' primary' : ''}`}
      onClick={(e) => {
        const target = e.target as HTMLElement
        if (target.closest('button')) return
        if (target.closest('.device-row-checkbox-input')) return
        // Active (config-connected) card click opens the detail pane on
        // the serial pseudo-device; otherwise the click is the flash-
        // target checkbox toggle, mirroring the LAN cards.
        if (isActive) selectDevice(pseudoId)
        else toggleSelectPort(entry.id)
      }}
    >
      <div className="device-row-top">
        <label
          className="device-row-checkbox"
          title={checked ? '書き込み対象から外す' : '書き込み対象に選択'}
          onClick={(e) => e.stopPropagation()}
        >
          <input
            type="checkbox"
            className="device-row-checkbox-input"
            checked={checked}
            onChange={() => toggleSelectPort(entry.id)}
            aria-label={`${serialEntryLabel(entry)} を書き込み対象に選択`}
          />
        </label>
        {/* Stable per-session index (#1, #2…) — Web Serial does not expose
            the COM port name, so this + the probe result are how the user
            tells two identical FTDI cables apart. */}
        <span className="mono" style={{ color: 'var(--text-muted)', fontSize: 11, flexShrink: 0 }}>
          #{entry.id.replace('usb-', '')}
        </span>
        <span className="device-row-name">{serialEntryLabel(entry)}</span>
        {entry.info?.role && entry.info.role !== 'receiver' && (
          <span
            className="device-detail-pill role-pill"
            title={`ノード役割: ${entry.info.role}`}
          >
            {roleBadge(entry.info.role)}
          </span>
        )}
        <span
          className="device-row-status online"
          title={isActive ? '設定接続中の USB ポート' : 'USB Serial ポート'}
        >
          <span style={{ fontSize: 13 }}>🔌</span>
          <span>{isActive ? '接続中' : 'USB'}</span>
        </span>
      </div>
      <div className="device-row-meta">
        <span>{entry.bridge}</span>
        {entry.vid !== undefined && (
          <span className="device-row-meta-ip">
            {entry.vid.toString(16).padStart(4, '0')}:{(entry.pid ?? 0).toString(16).padStart(4, '0')}
          </span>
        )}
        {entry.info?.fw && <span>fw {entry.info.fw}</span>}
        {entry.probe === 'failed' && <span title="get_info 無応答 — ファーム未書込の可能性">未書込?</span>}
      </div>
      {f.state !== 'idle' && (
        <div className="device-row-meta" style={{ marginTop: 2 }}>
          {f.state === 'waiting' && <span>⏳ 書き込み待機中…</span>}
          {f.state === 'flashing' && (
            <span>⚡ {f.progress ? `[${f.progress.phase}] ${f.progress.percent}%` : '書き込み中…'}</span>
          )}
          {f.state === 'done' && <span>✓ 書き込み完了 — 電源 OFF→ON してください</span>}
          {f.state === 'error' && <span title={f.message}>✗ 失敗: {f.message?.slice(0, 40)}</span>}
        </div>
      )}
      {f.state !== 'flashing' && f.state !== 'waiting' && (
        <div
          className="device-row-meta"
          style={{ marginTop: 4, gap: 6, display: 'flex', justifyContent: 'flex-end' }}
        >
          {!isActive && (
            <button
              type="button"
              className="form-button-secondary"
              style={{ fontSize: 12, padding: '3px 10px' }}
              onClick={(e) => { e.stopPropagation(); void openConfigFor(entry.id) }}
              title="このポートに設定接続する (設定タブが開きます)"
            >
              🔌 接続
            </button>
          )}
          <button
            type="button"
            className="form-button-secondary"
            style={{ fontSize: 12, padding: '3px 10px' }}
            onClick={(e) => { e.stopPropagation(); void probePort(entry.id) }}
            disabled={probing}
            title="get_info でデバイス情報を取得 (ファーム入りなら名前/fw が出ます)。書き込み完了表示もクリアされます"
          >
            {probing ? '識別中…' : '↻ 識別'}
          </button>
        </div>
      )}
    </div>
  )
}

function UsbPortsSection() {
  const knownPorts = useSerialMaster((s) => s.knownPorts)
  const selectedPortIds = useSerialMaster((s) => s.selectedPortIds)
  const addPort = useSerialMaster((s) => s.addPort)
  if (!isWebSerialSupported()) return null
  return (
    <div className="devices-usb-section">
      <div className="devices-sidebar-header" style={{ borderTop: '1px solid var(--border, #333)' }}>
        <span className="devices-sidebar-title" style={{ fontSize: 12 }}>USB Serial</span>
        <span className="devices-sidebar-count">
          {knownPorts.length}
          {selectedPortIds.length > 0 && (
            <>
              {' '}
              <span className="devices-sidebar-checked">({selectedPortIds.length}選択)</span>
            </>
          )}
        </span>
        <button
          type="button"
          className="devices-sidebar-refresh"
          onClick={() => void addPort()}
          title="USB Serial デバイスを追加 (COM ポート選択ダイアログが開きます)"
          aria-label="USB デバイス追加"
        >
          ＋
        </button>
      </div>
      {knownPorts.length === 0 ? (
        <div className="devices-empty" style={{ padding: '6px 10px', fontSize: 12 }}>
          ＋ で USB デバイスを追加
        </div>
      ) : (
        <>
          {knownPorts.map((e) => <UsbPortCard key={e.id} entry={e} />)}
          <div className="devices-empty" style={{ padding: '4px 10px', fontSize: 11, textAlign: 'left' }}>
            ※ ブラウザ (Web Serial) は COM ポート名を取得できないため、#番号 と
            「↻ 識別」結果 (デバイス名) で区別してください。
          </div>
        </>
      )}
    </div>
  )
}

/**
 * Sidebar listing every Helper-discovered device.
 *
 * Card UX (Manager parity):
 *   - top-left checkbox toggles multi-select (`selectedIps`)
 *   - top-right pill mirrors the connection state:
 *       online  → green ●︎ + 🔗 link icon (read-only)
 *       offline → red ✕ button that *dismisses* the card
 *   - body shows name / IP / address / fw
 *
 * Auto-selects the first device on first non-empty list so detail pane
 * is populated without an extra click.
 */
export function DeviceList() {
  const { isConnected, devices, send } = useHelperConnection()
  const selectedIp = useDeviceStore((s) => s.selectedIp)
  const selectedIps = useDeviceStore((s) => s.selectedIps)
  const dismissedIps = useDeviceStore((s) => s.dismissedIps)
  const infoCache = useDeviceStore((s) => s.infoCache)
  const selectDevice = useDeviceStore((s) => s.selectDevice)
  const toggleSelect = useDeviceStore((s) => s.toggleSelect)
  const selectExclusive = useDeviceStore((s) => s.selectExclusive)
  const selectRange = useDeviceStore((s) => s.selectRange)
  const dismissDevice = useDeviceStore((s) => s.dismissDevice)
  const syncOnlineDevices = useDeviceStore((s) => s.syncOnlineDevices)

  // NOTE: the serial-connected device is NOT promoted into this (LAN)
  // list anymore — it lives in the USB Serial section below, and the
  // active USB card doubles as the selectable entry for the detail
  // pane. Having it in both sections confused users (2026-06-13:
  // 「wifi のところと usb serial に同時にカードが出る」).

  // Filter out dismissed offline devices. (A previously-dismissed IP
  // that comes back online drops out of dismissedIps automatically via
  // `syncOnlineDevices`, so it'll re-appear without user action.)
  const dismissedSet = useMemo(() => new Set(dismissedIps), [dismissedIps])
  const visibleDevices = useMemo(
    () => devices.filter((d) => d.online || !dismissedSet.has(d.ipAddress)),
    [devices, dismissedSet],
  )

  // Push every online IP through dismissedIps so users don't get
  // stuck with a permanently-hidden card after a reboot.
  useEffect(() => {
    const onlineIps = devices.filter((d) => d.online).map((d) => d.ipAddress)
    syncOnlineDevices(onlineIps)
  }, [devices, syncOnlineDevices])

  // One-shot prune of stale selections from previous Studio sessions.
  // Background: localStorage carries `selectedIps` across reloads, so a
  // device whose DHCP lease changed (or that was unplugged for good)
  // leaves a phantom IP in the selection — the sidebar count says
  // "2選択" even though only 1 device is actually here. We wait for the
  // first non-empty `devices` push (helper has done initial mDNS scan)
  // before pruning; after that, the user's own toggles drive the set.
  const didPruneRef = useRef(false)
  const pruneSelectionsToKnown = useDeviceStore((s) => s.pruneSelectionsToKnown)
  useEffect(() => {
    if (didPruneRef.current) return
    if (devices.length === 0) return
    didPruneRef.current = true
    pruneSelectionsToKnown(devices.map((d) => d.ipAddress))
  }, [devices, pruneSelectionsToKnown])

  // First-time auto-select: when devices first appear, pick the first
  // one so the detail pane is populated without an extra click.
  // Critically, this runs ONCE — when the user explicitly unchecks the
  // last device the selection should stay null, otherwise the auto-
  // select would immediately re-add the same IP and the checkbox
  // would feel "stuck" (1 device case the user reported).
  const didAutoSelectRef = useRef(false)
  useEffect(() => {
    if (didAutoSelectRef.current) return
    if (visibleDevices.length === 0) return
    didAutoSelectRef.current = true
    if (!selectedIp) selectDevice(visibleDevices[0].ipAddress)
  }, [visibleDevices, selectedIp, selectDevice])

  if (!isConnected) {
    return (
      <aside className="devices-sidebar">
        <div className="devices-sidebar-header">
          <span className="devices-sidebar-title">Devices</span>
        </div>
        <div className="devices-empty">
          Helper 未接続<br />
          <code>hapbeat-helper start</code>
        </div>
        {/* USB Serial は Helper 不要 — daemon が落ちていても焼ける */}
        <UsbPortsSection />
      </aside>
    )
  }

  const checkedSet = new Set(selectedIps)

  return (
    <aside className="devices-sidebar">
      <div className="devices-sidebar-header">
        <span className="devices-sidebar-title">Devices</span>
        <span className="devices-sidebar-count">
          {visibleDevices.length}
          {checkedSet.size > 0 && (
            <>
              {' '}
              <span className="devices-sidebar-checked">({checkedSet.size}選択)</span>
            </>
          )}
        </span>
        <RefreshButton send={send} />
      </div>
      {/* Wi-Fi (LAN) group header — mirrors the "USB Serial" sub-header
          below so the two transports read as parallel sections. */}
      <div className="devices-sidebar-header devices-group-subheader">
        <span className="devices-sidebar-title" style={{ fontSize: 12 }}>
          <span style={{ fontSize: 13, marginRight: 4 }}>📶</span>Wi-Fi
        </span>
        <span className="devices-sidebar-count">{visibleDevices.length}</span>
      </div>
      <div className="devices-sidebar-list">
        {visibleDevices.length === 0 ? (
          <div className="devices-empty">
            検出中…<br />
            デバイスを Wi-Fi に接続してください
          </div>
        ) : (
          visibleDevices.map((dev) => {
            const checked = checkedSet.has(dev.ipAddress)
            const isPrimary = selectedIp === dev.ipAddress
            const onCardClick = (e: React.MouseEvent) => {
              // Avoid double-firing when the user clicks directly on
              // the checkbox or dismiss button — those handle their
              // own logic.
              const target = e.target as HTMLElement
              if (target.closest('.device-row-dismiss')) return
              if (target.closest('.device-row-checkbox-input')) return
              // Explorer-style selection (user feedback 2026-06-13):
              //   plain click        → exclusive single select
              //   Ctrl/Cmd + click   → additive toggle
              //   Shift + click      → contiguous range from the primary
              if (e.shiftKey) {
                selectRange(dev.ipAddress, visibleDevices.map((d) => d.ipAddress))
              } else if (e.ctrlKey || e.metaKey) {
                toggleSelect(dev.ipAddress)
              } else {
                selectExclusive(dev.ipAddress)
              }
            }
            const isApMode = infoCache[dev.ipAddress]?.mode === 'ap'
            return (
              <div
                key={dev.ipAddress || dev.name}
                className={`device-row${checked ? ' checked' : ''}${isPrimary ? ' primary' : ''}${dev.online ? '' : ' offline'}`}
                onClick={onCardClick}
                aria-selected={isPrimary}
              >
                <div className="device-row-top">
                  <label
                    className="device-row-checkbox"
                    title={checked ? '選択解除' : '選択'}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <input
                      type="checkbox"
                      className="device-row-checkbox-input"
                      checked={checked}
                      onChange={() => toggleSelect(dev.ipAddress)}
                      aria-label={`${dev.name || dev.ipAddress} を選択`}
                    />
                  </label>
                  <span className="device-row-name">{dev.name || '(unnamed)'}</span>
                  {dev.role && dev.role !== 'receiver' && (
                    <span
                      className="device-detail-pill role-pill"
                      title={`ノード役割: ${dev.role}`}
                    >
                      {roleBadge(dev.role)}
                    </span>
                  )}
                  {isApMode && (
                    <span className="ap-mode-badge ap-mode-badge-sm" title="SoftAP モードで動作中">
                      AP
                    </span>
                  )}
                  {dev.ipAddress.startsWith(SERIAL_DEVICE_PREFIX) ? (
                    <span
                      className="device-row-status online"
                      title="USB Serial 経由で接続中 (Wi-Fi 未設定)"
                    >
                      <span style={{ fontSize: 13 }}>🔌</span>
                      <span>Serial</span>
                    </span>
                  ) : dev.online ? (
                    <span
                      className="device-row-status online"
                      title="Wi-Fi (LAN) で接続中"
                    >
                      <span style={{ fontSize: 13 }}>📶</span>
                      {/* override the pill's uppercase so it reads "Wi-Fi"
                          not "WI-FI" */}
                      <span style={{ textTransform: 'none' }}>Wi-Fi</span>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="device-row-dismiss"
                      title="この未接続デバイスをリストから消す (再接続時に自動で復活します)"
                      onClick={(e) => {
                        e.stopPropagation()
                        dismissDevice(dev.ipAddress)
                      }}
                      aria-label={`未接続デバイス ${dev.name || dev.ipAddress} をリストから消す`}
                    >
                      ✕
                    </button>
                  )}
                </div>
                <div className="device-row-meta">
                  <span className="device-row-meta-ip">{dev.ipAddress || '—'}</span>
                  {dev.address && <span>{dev.address}</span>}
                  {dev.firmwareVersion && <span>fw {dev.firmwareVersion}</span>}
                </div>
              </div>
            )
          })
        )}
        <UsbPortsSection />
      </div>
    </aside>
  )
}
