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
import { isHapbeatBoard, isKnownNonHapbeatBoard } from '@/utils/hapbeatBoard'
import { useOtaStore, OTA_DEFAULT } from '@/stores/otaStore'
import type { ManagerMessage } from '@/types/manager'

/**
 * Wi-Fi OTA progress for a LAN device card. Mirrors the USB serial card's
 * flash readout but with an actual progress bar (user 2026-06-14: 「wifi ota の
 * プログレスバーを各カードにも」). The per-IP OTA state is drained into otaStore
 * by OtaController regardless of which device is selected, so the bar shows on
 * the sidebar card even while the user is looking at another device.
 */
function OtaCardProgress({ ip, online }: { ip: string; online: boolean }) {
  const st = useOtaStore((s) => s.byIp[ip] ?? OTA_DEFAULT)
  const clearResult = useOtaStore((s) => s.clearResult)
  const { progress, running, result, stuck } = st
  // Auto-clear the "✓ OTA 完了 — 再起動中…" line once the device has rebooted
  // back online: the OTA caused the device to drop offline then reconnect, so
  // the offline→online edge is exactly "the reboot finished" (user 2026-06-15).
  const prevOnlineRef = useRef(online)
  useEffect(() => {
    const was = prevOnlineRef.current
    prevOnlineRef.current = online
    // Only the SUCCESS "再起動中…" line auto-dismisses on reconnect. A failure
    // (✗) must persist — the user power-cycling to retry would otherwise wipe
    // the only on-card explanation right when they need it.
    if (!was && online && result?.ok && !running) clearResult(ip)
  }, [online, result, running, ip, clearResult])
  if (!running && !result) return null
  const pct = Math.max(0, Math.min(100, progress?.percent ?? 0))
  return (
    <div className="device-row-ota" onClick={(e) => e.stopPropagation()}>
      {running && (
        <>
          <div className="device-row-ota-label">
            <span>⚡ OTA{progress?.phase ? ` ${progress.phase}` : ''}</span>
            <span className="mono">{pct}%</span>
          </div>
          <div className="device-row-ota-bar">
            <div className={`device-row-ota-fill${stuck ? ' stuck' : ''}`} style={{ width: `${pct}%` }} />
          </div>
          {stuck && <div className="device-row-ota-note warn">⚠ 3 秒進捗なし — Helper 再起動を検討</div>}
        </>
      )}
      {!running && result && (
        <div className={`device-row-ota-note ${result.ok ? 'ok' : 'err'}`}>
          {result.ok ? '✓ OTA 完了 — 再起動中…' : `✗ OTA 失敗: ${(result.message || '').slice(0, 40)}`}
        </div>
      )}
    </div>
  )
}

/**
 * Connection indicator: a single state dot (green=linked, grey=not). No icon,
 * no text — the dot alone is enough (user feedback 2026-06-13).
 */
function ConnIndicator({ online, title }: { online: boolean; title?: string }) {
  return <span className={`device-conn-dot${online ? ' online' : ''}`} title={title} />
}

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
  const clearAllOtaResults = useOtaStore((s) => s.clearAllResults)
  const onClick = useCallback(() => {
    send({ type: 'rescan', payload: {} })
    clearAllOtaResults()  // a manual refresh also dismisses stale OTA result lines
    setSpinning(true)
    window.setTimeout(() => setSpinning(false), 700)
  }, [send, clearAllOtaResults])
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
 * blank. Selection works like the Wi-Fi cards: **click the card body (or
 * the checkbox) to select / deselect it as a flash target**
 * (`selectedPortIds`), so 5–10 devices can be picked for one parallel
 * flash without connecting each first. Connecting for config (get_info /
 * Wi-Fi setup) is a separate explicit 接続 button — the live config port
 * is single-master, so it stays one device at a time. Identity is bridge
 * chip + VID:PID until a probe fills in name/fw/role. Independent of
 * Helper — renders even when the daemon is down.
 */
function UsbPortCard({ entry, orderedIds }: { entry: SerialPortEntry; orderedIds: string[] }) {
  const activePortId = useSerialMaster((s) => s.activePortId)
  const mode = useSerialMaster((s) => s.mode)
  const selectedPortIds = useSerialMaster((s) => s.selectedPortIds)
  const selectedPortId = useSerialMaster((s) => s.selectedPortId)
  const toggleSelectPort = useSerialMaster((s) => s.toggleSelectPort)
  const selectExclusivePort = useSerialMaster((s) => s.selectExclusivePort)
  const selectPortRange = useSerialMaster((s) => s.selectPortRange)
  const probePort = useSerialMaster((s) => s.probePort)
  const openConfigFor = useSerialMaster((s) => s.openConfigFor)
  const selectDevice = useDeviceStore((s) => s.selectDevice)

  const checked = selectedPortIds.includes(entry.id)
  const isActive = entry.id === activePortId && mode === 'config'
  const pseudoId = `${SERIAL_DEVICE_PREFIX}${entry.info?.mac ?? 'active'}`
  // Primary = the selection anchor, unified with the Wi-Fi cards' `.primary`
  // (the focused/anchor selection). The live config-connection state is shown
  // separately by the ConnIndicator dot + the 接続/設定 button.
  const isPrimary = selectedPortId === entry.id
  const probing = entry.probe === 'connecting'
  const f = entry.flash

  return (
    <div
      className={`device-row usb${checked ? ' checked' : ''}${isPrimary ? ' primary' : ''}`}
      title="クリック=このデバイスだけ選択 / Ctrl+クリック=追加選択 / Shift+クリック=範囲選択"
      onClick={(e) => {
        const target = e.target as HTMLElement
        if (target.closest('button')) return
        if (target.closest('.device-row-checkbox-input')) return
        // Explorer-style selection, identical to the Wi-Fi cards
        // (user 2026-07-01: 単=排他 / Ctrl=加算トグル / Shift=範囲). Selection
        // is the flash-target set; connecting for config is the separate 接続
        // button (single-master live port, one at a time).
        if (e.shiftKey) selectPortRange(entry.id, orderedIds)
        else if (e.ctrlKey || e.metaKey) toggleSelectPort(entry.id)
        else selectExclusivePort(entry.id)
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
            // Pure flash-target toggle now (no connect side-effect). Works
            // on blank chips too — selection never needs an open port; the
            // flash opens/closes each port itself.
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
        {/* No "USB" transport tag — the section header says it. Dot shows
            the live config-connection state (接続 button), independent of
            the flash-target selection (card click / checkbox). */}
        <ConnIndicator online={isActive} title={isActive ? '設定接続中 (USB Serial)' : '未接続（設定は「接続」ボタン）'} />
      </div>
      <div className="device-row-meta">
        {entry.info && (() => {
          const role = entry.info.role ?? 'receiver'
          return (
            <span className={`device-row-roletag ${role}`} title={`ノード役割: ${role}`}>
              {roleBadge(role)}
            </span>
          )
        })()}
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
          {/* 接続 = open the single-master config conn on THIS port (for
              get_info / Wi-Fi setup). Kept separate from selection so the
              card click can be a pure multi-select like the Wi-Fi cards. */}
          <button
            type="button"
            className="form-button-secondary"
            style={{ fontSize: 12, padding: '3px 10px' }}
            onClick={(e) => {
              e.stopPropagation()
              if (isActive) selectDevice(pseudoId)
              else void openConfigFor(entry.id)
            }}
            title={isActive ? '設定タブを開く' : 'USB Serial で接続して設定 (get_info / Wi-Fi)。1 台ずつ'}
          >
            {isActive ? '設定' : '接続'}
          </button>
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
  const selectAllPorts = useSerialMaster((s) => s.selectAllPorts)
  const clearSelectedPorts = useSerialMaster((s) => s.clearSelectedPorts)
  if (!isWebSerialSupported()) return null
  const allSelected = knownPorts.length > 0 && selectedPortIds.length === knownPorts.length
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
        {/* Bulk select for the 5–10-device production flash: one click to
            select every granted port, instead of ticking each card. */}
        {knownPorts.length > 1 && (
          <button
            type="button"
            className="devices-sidebar-refresh"
            style={{ fontSize: 11, width: 'auto', padding: '0 6px' }}
            onClick={() => (allSelected ? clearSelectedPorts() : selectAllPorts())}
            title={allSelected ? '全ての書き込み対象を解除' : '全 USB デバイスを書き込み対象に選択'}
          >
            {allSelected ? '全解除' : '全選択'}
          </button>
        )}
        <button
          type="button"
          className="devices-sidebar-refresh"
          onClick={() => void addPort()}
          title="USB Serial デバイスを追加（初回のみブラウザの選択ダイアログ。一度許可すれば次回以降は自動で表示されます）"
          aria-label="USB デバイス追加"
        >
          ＋
        </button>
      </div>
      {knownPorts.length === 0 ? (
        <div className="devices-empty" style={{ padding: '6px 10px', fontSize: 12 }}>
          ＋ で USB デバイスを追加
          <br />
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            初回は 1 台ずつブラウザの許可が必要（ブラウザ仕様）。一度許可すれば次回から自動表示されます。
          </span>
        </div>
      ) : (
        <>
          {knownPorts.map((e) => (
            <UsbPortCard key={e.id} entry={e} orderedIds={knownPorts.map((p) => p.id)} />
          ))}
          <div className="devices-empty" style={{ padding: '4px 10px', fontSize: 11, textAlign: 'left' }}>
            ※ カードをクリックで書き込み対象を選択。「全選択」→ Firmware タブで一斉並列書き込みできます。
            ブラウザは COM 名を取得できないため #番号 と「↻ 識別」で区別してください。
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
export function DeviceList({ hapbeatOnly = false }: { hapbeatOnly?: boolean } = {}) {
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

  // Hapbeat = duo_wl_* / band_wl_* board (from get_info). Used for the card
  // badge and, in `hapbeatOnly` mode (UI/Display tab picker), to disable
  // selecting non-Hapbeat nodes — the display config only applies to Hapbeat.
  const boardOf = (ip: string): string | undefined => infoCache[ip]?.board
  const isHapbeat = (ip: string): boolean => isHapbeatBoard(boardOf(ip))
  // Only block devices KNOWN to be non-Hapbeat (board present and not a
  // wearable); an un-probed device stays selectable so we never wrongly block.
  const isBlocked = (ip: string): boolean =>
    hapbeatOnly && isKnownNonHapbeatBoard(boardOf(ip))

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
            const blocked = isBlocked(dev.ipAddress)
            const onCardClick = (e: React.MouseEvent) => {
              if (blocked) return  // non-Hapbeat not selectable in hapbeatOnly mode
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
                className={`device-row${checked ? ' checked' : ''}${isPrimary ? ' primary' : ''}${dev.online ? '' : ' offline'}${blocked ? ' blocked' : ''}`}
                onClick={onCardClick}
                aria-selected={isPrimary}
                title={blocked ? 'UI 設定は Hapbeat 本体のみ — 非 Hapbeat は選択できません' : undefined}
              >
                <div className="device-row-top">
                  <label
                    className="device-row-checkbox"
                    title={blocked ? 'Hapbeat 本体のみ選択可' : (checked ? '選択解除' : '選択')}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <input
                      type="checkbox"
                      className="device-row-checkbox-input"
                      checked={checked}
                      disabled={blocked}
                      onChange={() => toggleSelect(dev.ipAddress)}
                      aria-label={`${dev.name || dev.ipAddress} を選択`}
                    />
                  </label>
                  <span className="device-row-name">{dev.name || '(unnamed)'}</span>
                  {/* No "Wi-Fi" transport tag (the section header says it) —
                      just a dot + 接続/未接続 state label. Offline = red ✕
                      dismiss (user feedback 2026-06-13). */}
                  {dev.online ? (
                    <ConnIndicator online title="Wi-Fi 接続中" />
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
                  {(() => {
                    const role = dev.role ?? 'receiver'
                    return (
                      <span className={`device-row-roletag ${role}`} title={`ノード役割: ${role}`}>
                        {roleBadge(role)}
                      </span>
                    )
                  })()}
                  {/* Hapbeat 本体 (duo_wl_* / band_wl_*) は role タグの隣に
                      Hapbeat タグも出す — 非 Hapbeat の receiver と区別する。 */}
                  {isHapbeat(dev.ipAddress) && (
                    <span className="device-row-roletag hapbeat" title="Hapbeat 本体">Hapbeat</span>
                  )}
                  {isApMode && (
                    <span className="device-row-roletag ap" title="SoftAP モードで動作中">AP</span>
                  )}
                  <span className="device-row-meta-ip">{dev.ipAddress || '—'}</span>
                  {dev.address && <span>{dev.address}</span>}
                  {dev.firmwareVersion && <span>fw {dev.firmwareVersion}</span>}
                </div>
                <OtaCardProgress ip={dev.ipAddress} online={dev.online} />
              </div>
            )
          })
        )}
        <UsbPortsSection />
      </div>
    </aside>
  )
}
