import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useHelperConnection } from '@/hooks/useHelperConnection'
import { useDeviceStore, type WifiProfile } from '@/stores/deviceStore'
import { ApModeSection } from './ApModeSection'
import { useLibraryStore } from '@/stores/libraryStore'
import { useLogStore } from '@/stores/logStore'
import type { DeviceInfo, ManagerMessage } from '@/types/manager'
import { IdentityForm } from './IdentityForm'
import { WifiProfilesForm } from './WifiProfilesForm'
import { UiConfigForm } from './UiConfigForm'
import { DebugDumpSection } from './DebugDumpSection'
import { InstalledKitsSection } from './InstalledKitsSection'
import { SerialConfigSection } from './SerialConfigSection'
import { TestSubTab } from './TestSubTab'
import { FirmwareSubTab } from './FirmwareSubTab'
import { OnboardingWizard } from './OnboardingWizard'
import { useDeviceTransport } from '@/hooks/useDeviceTransport'
import { useSerialMaster } from '@/stores/serialMaster'

type SubTab = 'config' | 'kit' | 'test' | 'firmware'

const SUB_TABS: { id: SubTab; label: string }[] = [
  { id: 'config', label: '設定' },
  { id: 'kit', label: 'Kit' },
  { id: 'test', label: '再生テスト' },
  { id: 'firmware', label: 'ファームウェア' },
]

const SUBTAB_KEY = 'hapbeat-studio-devices-subtab'

/**
 * Right-hand pane: per-device tabs that mirror the Manager's
 * DetailPanel (`設定 / Kit / 再生テスト / ファームウェア`). Live Audio
 * is intentionally out of scope and lives elsewhere.
 */
export function DeviceDetail() {
  const { devices, lastMessage, send } = useHelperConnection()
  const pushLog = useLogStore((s) => s.push)
  const selectedIp = useDeviceStore((s) => s.selectedIp)
  const setInfo = useDeviceStore((s) => s.setInfo)
  const setApStatus = useDeviceStore((s) => s.setApStatus)
  const setWifiStatus = useDeviceStore((s) => s.setWifiStatus)
  const setWifiProfiles = useDeviceStore((s) => s.setWifiProfiles)
  const setDebugDump = useDeviceStore((s) => s.setDebugDump)
  const setKitList = useDeviceStore((s) => s.setKitList)
  const infoCache = useDeviceStore((s) => s.infoCache)
  const wifiStatusCache = useDeviceStore((s) => s.wifiStatusCache)
  const wifiProfilesCache = useDeviceStore((s) => s.wifiProfilesCache)
  const debugDumpCache = useDeviceStore((s) => s.debugDumpCache)
  const kitListCache = useDeviceStore((s) => s.kitListCache)

  // Pull master state for the Serial pseudo-device path. Subscribing
  // unconditionally is fine — selectors re-render only when the
  // tracked field actually changes.
  const masterMode = useSerialMaster((s) => s.mode)
  const masterInfo = useSerialMaster((s) => s.info)
  const masterWifiStatus = useSerialMaster((s) => s.wifiStatus)
  const masterWifiProfiles = useSerialMaster((s) => s.wifiProfiles)
  const masterWifiProfileMax = useSerialMaster((s) => s.wifiProfileMax)

  const device: DeviceInfo | undefined = useMemo(() => {
    if (selectedIp?.startsWith('serial:')) {
      // Synthesize a DeviceInfo from the master so the rest of the
      // component (IdentityForm / WifiProfilesForm / etc.) sees the
      // same shape it expects for a LAN device.
      if (masterMode !== 'config' || !masterInfo) return undefined
      return {
        ipAddress: selectedIp,
        name: masterInfo.name ?? '(unnamed)',
        address: 'USB Serial',
        firmwareVersion: masterInfo.fw,
        online: true,
      } as DeviceInfo
    }
    return devices.find((d) => d.ipAddress === selectedIp)
  }, [devices, selectedIp, masterMode, masterInfo])

  const [subTab, setSubTab] = useState<SubTab>(() => {
    const saved = localStorage.getItem(SUBTAB_KEY)
    return SUB_TABS.some((t) => t.id === saved) ? (saved as SubTab) : 'config'
  })
  useEffect(() => {
    localStorage.setItem(SUBTAB_KEY, subTab)
  }, [subTab])

  const [globalStatus, setGlobalStatus] = useState<{ kind: 'ok' | 'err' | 'warn' | 'muted'; msg: string } | null>(null)

  // 選択中 LAN デバイス変更時に info / wifi を毎回 fresh fetch する。
  // 旧実装は wifiProfilesCache hit で短絡していたが、ユーザ要望
  // (2026-05-09): デバイス情報はキャッシュ保持せず都度デバイスから取得すること。
  // 切替時に旧 IP の cache を捨ててから新 IP の get_* を並列発行する。
  const clearCachesFor = useDeviceStore((s) => s.clearCachesFor)
  const prevSelectedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!selectedIp || selectedIp.startsWith('serial:')) {
      prevSelectedRef.current = selectedIp ?? null
      return
    }
    // Drop the previously-selected device's cache (if any) so stale
    // values don't bleed into the new selection's UI for the brief
    // window before fresh responses arrive.
    const prev = prevSelectedRef.current
    if (prev && prev !== selectedIp && !prev.startsWith('serial:')) {
      clearCachesFor(prev)
    }
    prevSelectedRef.current = selectedIp
    if (!device?.online) return
    send({ type: 'list_wifi_profiles', payload: { ip: selectedIp } })
    send({ type: 'get_info', payload: { ip: selectedIp } })
    send({ type: 'get_wifi_status', payload: { ip: selectedIp } })
    send({ type: 'get_ap_status', payload: { ip: selectedIp } })
    send({ type: 'get_oled_brightness', payload: { ip: selectedIp } })
  }, [selectedIp, device?.online, send, clearCachesFor])

  // Drain helper push messages.
  useEffect(() => {
    if (!lastMessage) return
    const t = lastMessage.type
    const p = lastMessage.payload as Record<string, unknown>

    if (t === 'get_info_result' && typeof p.device === 'string') {
      setInfo(p.device, {
        name: p.name as string | undefined,
        mac: p.mac as string | undefined,
        fw: p.fw as string | undefined,
        group: p.group as number | undefined,
        wifi_connected: p.wifi_connected as boolean | undefined,
        board: p.board as string | undefined,
        // SoftAP extension fields (firmware ≥ v0.1.0)
        mode: p.mode as 'sta' | 'ap' | undefined,
        ap_ssid: p.ap_ssid as string | undefined,
        ap_ip: p.ap_ip as string | undefined,
        ap_has_pass: p.ap_has_pass as boolean | undefined,
        ap_client_count: p.ap_client_count as number | undefined,
      })
    } else if (t === 'ap_status_result' && typeof p.device === 'string') {
      setApStatus(p.device, {
        mode: p.mode as 'sta' | 'ap' | undefined,
        ap_ssid: p.ap_ssid as string | undefined,
        ap_ip: p.ap_ip as string | undefined,
        ap_has_pass: p.ap_has_pass as boolean | undefined,
        ap_client_count: p.ap_client_count as number | undefined,
      })
    } else if (t === 'oled_brightness_result' && typeof p.device === 'string') {
      // setInfo は infoCache の partial merge を行うのでこの 1 フィールドも乗せられる。
      setInfo(p.device, { oled_brightness: p.level as number | undefined })
    } else if (t === 'wifi_status_result' && typeof p.device === 'string') {
      setWifiStatus(p.device, {
        connected: p.connected as boolean | undefined,
        ssid: p.ssid as string | undefined,
        ip: p.ip as string | undefined,
        rssi: p.rssi as number | undefined,
        channel: p.channel as number | undefined,
      })
    } else if (t === 'wifi_profiles_result' && typeof p.device === 'string') {
      const profiles = (p.profiles as WifiProfile[] | undefined) ?? []
      const cnt = (p.count as number | undefined) ?? profiles.length
      const max = (p.max as number | undefined) ?? 5
      setWifiProfiles(p.device, profiles, cnt, max)
    } else if (t === 'debug_dump_result' && typeof p.device === 'string') {
      setDebugDump(p.device, p as Record<string, unknown>)
    } else if (t === 'kit_list_result' && typeof p.device === 'string') {
      // Firmware ≥ 2026-04-29 returns events as `{name, mode}` objects
      // so we can split FIRE vs CLIP in the UI. Older builds (and any
      // proxied response that strips the shape) still send `string[]`,
      // so we accept either shape and normalize downstream.
      const kits = (p.kits as Array<{
        kit_id: string
        version?: string
        events?: Array<string | { name: string; mode?: string }>
      }> | undefined) ?? []
      setKitList(p.device, kits)
    } else if (t === 'write_result') {
      const ok = p.success === true
      // Helper now sends both `summary` (one-liner) and `message`
      // (multi-line with per-target diagnostics). Use the summary in
      // the floating status pill (room is tight) and the full message
      // in the log drawer (auditable history).
      const summary = (p.summary as string)
        || (p.message as string)
        || (p.error as string)
        || (ok ? 'ok' : 'failed')
      const fullMsg = (p.message as string)
        || (p.error as string)
        || (ok ? 'ok' : 'failed')
      // Pill: collapse to first line for fit.
      setGlobalStatus({
        kind: ok ? 'ok' : 'err',
        msg: summary.split('\n')[0],
      })
      // Drawer: every line on its own row so per-target failure
      // reasons are visible without expanding the entry.
      const tag = ok ? '✓' : '✗'
      for (const line of fullMsg.split('\n')) {
        if (line.trim().length === 0) continue
        pushLog('helper', `${tag} ${line}`)
      }
      // Surface the embedded raw `results` for full forensics — these
      // are the per-target objects with `phase` ('connect' / 'io' /
      // 'no_reply'), `cmd`, and the raw firmware response.
      const results = p.results as Array<Record<string, unknown>> | undefined
      if (Array.isArray(results)) {
        for (const r of results) {
          if (r.success) continue // green path already in fullMsg
          const ip = r.ip as string ?? '?'
          const resp = (r.response as Record<string, unknown>) ?? {}
          const phase = (resp.phase as string) ?? '?'
          const cmd = (resp.cmd as string) ?? (p.cmd as string) ?? '?'
          pushLog('helper', `   ↳ ${ip} cmd=${cmd} phase=${phase} resp=${JSON.stringify(resp)}`)
        }
      }
    }
  }, [
    lastMessage,
    pushLog,
    setInfo,
    setApStatus,
    setWifiStatus,
    setWifiProfiles,
    setDebugDump,
    setKitList,
  ])

  useEffect(() => {
    if (!globalStatus) return
    const t = setTimeout(() => setGlobalStatus(null), 4000)
    return () => clearTimeout(t)
  }, [globalStatus])

  /**
   * PLAY a Kit event. Look the manifest `intensity` for the eventId
   * up in Studio's local Kit library and send it as the wire `gain`.
   *
   * Why: the device firmware (since 2026-04-29) no longer auto-applies
   * manifest intensity at runtime — it just plays the wire gain
   * verbatim. So a missing/default `gain=1.0` payload would cause
   * authored intensities to be silently ignored when the user clicks
   * a Kit event button. Falling back to 1.0 only when the eventId
   * isn't found locally (e.g. the kit was installed by a different
   * Studio install) preserves the legacy behavior for that edge case.
   *
   * Defined unconditionally (above the `!device` early return) so the
   * hook order stays stable across renders — React will warn loudly
   * if a useCallback is conditionally skipped, even when the early
   * return is "obviously" the no-device branch.
   */
  const playEvent = useCallback((eventId: string) => {
    if (!selectedIp) return
    const kits = useLibraryStore.getState().kits
    let intensity = 1.0
    let kitId: string | null = null
    let mode: string | null = null
    for (const k of kits) {
      const ev = k.events.find((e) => e.eventId === eventId)
      if (ev && typeof ev.intensity === 'number') {
        intensity = ev.intensity
        kitId = k.id
        mode = ev.mode ?? 'command'
        break
      }
    }
    const payload = { event_id: eventId, target: '', gain: intensity }
    send({ type: 'preview_event', payload })
    // Verbose log so the user can verify the manifest amp actually
    // landed on the wire — the previous "play sent" line gave no
    // information at all when intensity wasn't reflected.
    const ampLabel = kitId
      ? `gain=${intensity.toFixed(2)} (manifest amp ${(intensity * 100).toFixed(0)}%, kit=${kitId}${mode ? `, mode=${mode}` : ''})`
      : `gain=${intensity.toFixed(2)} (manifest 未取得 — fallback to 1.0)`
    pushLog(
      'preview',
      `→ ${selectedIp}: preview_event event_id=${eventId} ${ampLabel}`,
    )
  }, [selectedIp, send, pushLog])

  // Transport-agnostic sender: LAN device → Helper WS, Serial
  // pseudo-device → SerialMaster.sendConfigCmd. Same call shape so
  // the per-form code (IdentityForm, WifiProfilesForm, …) is
  // unchanged. Hook is invoked unconditionally (above the early
  // return) — React's rules-of-hooks would otherwise see a different
  // hook count between the no-device and device-present renders.
  const transport = useDeviceTransport(selectedIp)
  const sendTo = (msg: ManagerMessage) => { void transport.sendTo(msg) }

  // No device selected → show the OnboardingWizard.
  // (Serial pseudo-device selection falls through to the regular
  // sub-tab UI below; the same Identity / Wi-Fi forms drive both
  // LAN and Serial transports via `useDeviceTransport`.)
  if (!device || !selectedIp) {
    return <OnboardingWizard />
  }

  const refreshInfo = () => {
    if (transport.isSerial) {
      // Serial path: master.refreshAll re-queries get_info /
      // get_wifi_status / list_wifi_profiles in one go and pushes
      // them into the shared store; the LAN-side caches don't apply.
      void useSerialMaster.getState().refreshAll()
      return
    }
    send({ type: 'get_info', payload: { ip: selectedIp } })
    send({ type: 'get_wifi_status', payload: { ip: selectedIp } })
    send({ type: 'list_wifi_profiles', payload: { ip: selectedIp } })
    send({ type: 'get_ap_status', payload: { ip: selectedIp } })
    send({ type: 'get_oled_brightness', payload: { ip: selectedIp } })
  }

  const refreshApStatus = () => {
    if (!transport.isSerial) {
      send({ type: 'get_ap_status', payload: { ip: selectedIp } })
    }
  }

  const refreshWifiProfiles = () => {
    if (transport.isSerial) {
      void useSerialMaster.getState().refreshAll()
      return
    }
    send({ type: 'list_wifi_profiles', payload: { ip: selectedIp } })
  }

  // For Serial pseudo-device, surface master state in the same
  // shape the LAN cache uses so per-form components don't need to
  // know about the transport.
  const cachedInfo = transport.isSerial
    ? (masterInfo ? {
        name: masterInfo.name,
        mac: masterInfo.mac,
        fw: masterInfo.fw,
        group: masterInfo.group,
        wifi_connected: masterInfo.wifi_connected,
      } : undefined)
    : infoCache[selectedIp]
  const wifiStatus = transport.isSerial
    ? (masterWifiStatus ?? undefined)
    : wifiStatusCache[selectedIp]
  const wifiProfiles = transport.isSerial
    ? { profiles: masterWifiProfiles, count: masterWifiProfiles.length, max: masterWifiProfileMax }
    : wifiProfilesCache[selectedIp]
  const debugDump = debugDumpCache[selectedIp]
  const kitList = kitListCache[selectedIp]
  const apInfo = {
    mode: cachedInfo?.mode,
    ap_ssid: cachedInfo?.ap_ssid,
    ap_ip: cachedInfo?.ap_ip,
    ap_has_pass: cachedInfo?.ap_has_pass,
    ap_client_count: cachedInfo?.ap_client_count,
  }

  return (
    <section className="devices-detail">
      <div className="devices-detail-header">
        <div className="devices-detail-name">
          {device.name || '(unnamed)'}
        </div>
        <div className="devices-detail-sub">
          <span className="device-detail-pill selected-pill">SELECTED</span>
          {apInfo.mode === 'ap' && (
            <span className="device-detail-pill ap-mode-badge">AP MODE</span>
          )}
          {device.ipAddress}
          {device.firmwareVersion && <> · fw {device.firmwareVersion}</>}
          {device.address && <> · {device.address}</>}
          {!device.online && <> · offline</>}
        </div>
        <div className="form-action-row" style={{ marginTop: 10 }}>
          <button
            className="form-button-secondary"
            onClick={refreshInfo}
            disabled={!device.online}
            title="デバイスから get_info / get_wifi_status / list_wifi_profiles を取得"
          >
            ⟳ デバイスから読み込み
          </button>
          <button
            className="form-button-secondary"
            onClick={() => sendTo({ type: 'reboot', payload: {} })}
            disabled={!device.online}
            title="デバイスを再起動"
          >
            再起動
          </button>
          {globalStatus && (
            <span className={`form-status ${globalStatus.kind}`} style={{ alignSelf: 'center' }}>
              {globalStatus.msg}
            </span>
          )}
        </div>
      </div>

      <div className="device-subtabs">
        {SUB_TABS.map((t) => (
          <button
            key={t.id}
            className={`device-subtab-btn${subTab === t.id ? ' active' : ''}`}
            onClick={() => setSubTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="device-subtab-body">
        {subTab === 'config' && (
          <>
            <IdentityForm
              device={device}
              cachedInfo={cachedInfo}
              sendTo={sendTo}
            />
            <WifiProfilesForm
              device={device}
              profiles={wifiProfiles?.profiles ?? []}
              count={wifiProfiles?.count ?? 0}
              max={wifiProfiles?.max ?? 5}
              wifiStatus={wifiStatus}
              sendTo={sendTo}
              onRefresh={refreshWifiProfiles}
            />
            <ApModeSection
              device={device}
              apInfo={apInfo}
              sendTo={sendTo}
              onRefreshApStatus={refreshApStatus}
            />
            {/* OLED 輝度は UI タブ → "UI 設定" モーダルへ移動 (2026-05-08)。
              * Per-device の即時調整は UI モーダル内のスライダで行い、
              * 永続化は通常の Deploy 経路 (ui-config.json) に集約する。 */}
            <UiConfigForm device={device} sendTo={sendTo} />
            <DebugDumpSection
              device={device}
              dump={debugDump}
              sendTo={sendTo}
            />
            {/* Fallback path: Serial-config link last, low-key, only
              * useful when LAN-side 設定 isn't responding. */}
            <SerialConfigSection compact />
          </>
        )}

        {subTab === 'kit' && (
          <InstalledKitsSection
            device={device}
            kits={kitList}
            sendTo={sendTo}
            onPlayEvent={playEvent}
          />
        )}

        {subTab === 'test' && <TestSubTab device={device} sendTo={sendTo} />}

        {subTab === 'firmware' && (
          <FirmwareSubTab device={device} sendTo={sendTo} />
        )}
      </div>
    </section>
  )
}
