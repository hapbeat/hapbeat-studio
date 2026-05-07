import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useHelperConnection } from '@/hooks/useHelperConnection'
import { useDeviceStore } from '@/stores/deviceStore'
import { useSerialMaster } from '@/stores/serialMaster'
import type { DeviceInfo, ManagerMessage } from '@/types/manager'

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
  const dismissDevice = useDeviceStore((s) => s.dismissDevice)
  const syncOnlineDevices = useDeviceStore((s) => s.syncOnlineDevices)

  // Promote the active SerialMaster connection (if any) to a
  // synthetic device entry so an unconfigured Hapbeat — visible only
  // through USB Serial — still appears in the same Devices list.
  // The detail pane keys off the `serial:` prefix to render the
  // Serial-config forms instead of the LAN tabs.
  const serialMode = useSerialMaster((s) => s.mode)
  const serialInfo = useSerialMaster((s) => s.info)
  const serialDevice = useMemo<DeviceInfo | null>(() => {
    if (serialMode !== 'config' || !serialInfo) return null
    const id = `${SERIAL_DEVICE_PREFIX}${serialInfo.mac ?? 'active'}`
    return {
      ipAddress: id,
      name: serialInfo.name ?? '(unnamed)',
      address: 'USB Serial',
      firmwareVersion: serialInfo.fw,
      online: true,
    } as DeviceInfo
  }, [serialMode, serialInfo])

  // Filter out dismissed offline devices. (A previously-dismissed IP
  // that comes back online drops out of dismissedIps automatically via
  // `syncOnlineDevices`, so it'll re-appear without user action.)
  const dismissedSet = useMemo(() => new Set(dismissedIps), [dismissedIps])
  const visibleDevices = useMemo(() => {
    const lan = devices.filter((d) => d.online || !dismissedSet.has(d.ipAddress))
    return serialDevice ? [serialDevice, ...lan] : lan
  }, [devices, dismissedSet, serialDevice])

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
              toggleSelect(dev.ipAddress)
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
                      title="接続中"
                    >
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.4"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M9 7H6a4 4 0 1 0 0 8h3" />
                        <path d="M15 17h3a4 4 0 1 0 0-8h-3" />
                        <line x1="8" y1="12" x2="16" y2="12" />
                      </svg>
                      <span>接続中</span>
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
      </div>
    </aside>
  )
}
