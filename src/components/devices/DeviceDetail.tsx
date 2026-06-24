import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useHelperConnection } from '@/hooks/useHelperConnection'
import { useDeviceStore, type WifiProfile } from '@/stores/deviceStore'
import { ApModeSection } from './ApModeSection'
import { useLibraryStore } from '@/stores/libraryStore'
import type { KitDefinition, KitEvent } from '@/types/library'
import { useLogStore } from '@/stores/logStore'
import type { DeviceInfo, ManagerMessage, MqttClientEntry, NodeRole, NodeTransport, SensorMapping } from '@/types/manager'
import { IdentityForm } from './IdentityForm'
import { WifiProfilesForm } from './WifiProfilesForm'
import { UiConfigForm } from './UiConfigForm'
import { DebugDumpSection } from './DebugDumpSection'
import { InstalledKitsSection } from './InstalledKitsSection'
import { TestSubTab } from './TestSubTab'
import { FirmwareSubTab } from './FirmwareSubTab'
import { OnboardingWizard } from './OnboardingWizard'
import {
  EspNowConfigSection,
  MqttConfigSection,
  BrokerConfigSection,
  SensorMappingSection,
} from './NodeConfigSections'
import { useDeviceTransport } from '@/hooks/useDeviceTransport'
import { useSerialMaster } from '@/stores/serialMaster'
import { roleBadge } from '@/utils/roleLabels'

type SubTab =
  | 'wifi' | 'config' | 'kit' | 'test' | 'firmware' | 'espnow'
  | 'mqtt'      // single shared MQTT tab: broker panel OR client settings,
                // + flow chart. Shared id so switching sensor↔broker keeps it.
  | 'mapping'   // sensor live value + mapping editor

const SUB_TAB_LABEL: Record<SubTab, string> = {
  wifi: 'Wi-Fi',
  config: '設定',
  kit: 'Kit',
  test: '再生テスト',
  firmware: 'ファームウェア',
  espnow: 'ESP-NOW',
  mqtt: 'MQTT',
  mapping: 'センサー',
}

/**
 * Which sub-tabs a node shows, by role/transport (DEC-034). A node
 * that doesn't report a role is a `receiver` on `udp` → the classic
 * 5-tab layout, identical to before.
 */
function computeSubTabs(
  role: NodeRole,
  transport: NodeTransport,
  transports: NodeTransport[],
): SubTab[] {
  switch (role) {
    case 'sensor':
      // MQTT (client 設定 + 接続フロー) とセンサー (ライブ値 + マッピング)
      // を専用タブに (user feedback 2026-06-13)。MQTT タブ id は broker と
      // 共有 → sensor↔broker 切替でタブが維持される。
      return ['wifi', 'config', 'mqtt', 'mapping', 'firmware']
    case 'broker':
      // broker も同じ 'mqtt' タブ id (フロー図 + ブローカー設定)。
      return ['wifi', 'config', 'mqtt', 'firmware']
    case 'transmitter':
      return ['espnow', 'firmware']
    case 'receiver':
    default: {
      // Pure ESP-NOW stream receiver: no Wi-Fi STA, no kit/event playback.
      const pureStream =
        transport === 'espnow_stream'
        && !transports.includes('udp')
        && !transports.includes('mqtt')
      if (pureStream) return ['espnow', 'firmware']
      // mqtt receiver gets the MQTT client tab; plain udp doesn't.
      if (transports.includes('mqtt')) {
        return ['wifi', 'config', 'mqtt', 'kit', 'test', 'firmware']
      }
      return ['wifi', 'config', 'kit', 'test', 'firmware']
    }
  }
}

const SUBTAB_KEY = 'hapbeat-studio-devices-subtab'

/**
 * Right-hand pane: per-device tabs, gated by the node's role/transport.
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
  const setSensorMapping = useDeviceStore((s) => s.setSensorMapping)
  const setSensorReading = useDeviceStore((s) => s.setSensorReading)
  const infoCache = useDeviceStore((s) => s.infoCache)
  const wifiStatusCache = useDeviceStore((s) => s.wifiStatusCache)
  const wifiProfilesCache = useDeviceStore((s) => s.wifiProfilesCache)
  const debugDumpCache = useDeviceStore((s) => s.debugDumpCache)
  const kitListCache = useDeviceStore((s) => s.kitListCache)
  const sensorMappingCache = useDeviceStore((s) => s.sensorMappingCache)
  const sensorReadingCache = useDeviceStore((s) => s.sensorReadingCache)

  const masterMode = useSerialMaster((s) => s.mode)
  const masterInfo = useSerialMaster((s) => s.info)
  const masterWifiStatus = useSerialMaster((s) => s.wifiStatus)
  const masterWifiProfiles = useSerialMaster((s) => s.wifiProfiles)
  const masterWifiProfileMax = useSerialMaster((s) => s.wifiProfileMax)

  const device: DeviceInfo | undefined = useMemo(() => {
    if (selectedIp?.startsWith('serial:')) {
      if (masterMode !== 'config' || !masterInfo) return undefined
      return {
        ipAddress: selectedIp,
        name: masterInfo.name ?? '(unnamed)',
        address: 'USB Serial',
        firmwareVersion: masterInfo.fw,
        online: true,
        role: masterInfo.role,
        transport: masterInfo.transport,
        transports: masterInfo.transports,
      } as DeviceInfo
    }
    return devices.find((d) => d.ipAddress === selectedIp)
  }, [devices, selectedIp, masterMode, masterInfo])

  const [subTab, setSubTab] = useState<SubTab>(() => {
    const saved = localStorage.getItem(SUBTAB_KEY)
    return saved && saved in SUB_TAB_LABEL ? (saved as SubTab) : 'wifi'
  })
  useEffect(() => {
    localStorage.setItem(SUBTAB_KEY, subTab)
  }, [subTab])

  // Auto-jump to the Wi-Fi tab ONLY when a device is confirmed to be
  // Wi-Fi-disconnected (so it obviously needs setup), and only once per
  // device. Previously this fired whenever the wifi status was merely
  // *unknown* — which is the case right after every device switch
  // (caches are cleared, get_wifi_status is still in flight) — so the
  // tab reset to Wi-Fi on every switch. Keeping the current tab when the
  // status is unknown lets the user stay on e.g. the MQTT tab while
  // switching between sensor and broker (user feedback 2026-06-13). The
  // activeSubTab fallback below still redirects if the tab isn't valid
  // for the newly-selected device's role.
  const autoJumpedIpRef = useRef<string | null>(null)
  useEffect(() => {
    if (!selectedIp) return
    const wifiStatus = selectedIp.startsWith('serial:')
      ? useSerialMaster.getState().wifiStatus
      : wifiStatusCache[selectedIp]
    if (wifiStatus?.connected === false && autoJumpedIpRef.current !== selectedIp) {
      autoJumpedIpRef.current = selectedIp
      setSubTab('wifi')
    }
  }, [selectedIp, wifiStatusCache])

  const [globalStatus, setGlobalStatus] = useState<{ kind: 'ok' | 'err' | 'warn' | 'muted'; msg: string } | null>(null)

  const clearCachesFor = useDeviceStore((s) => s.clearCachesFor)
  const prevSelectedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!selectedIp || selectedIp.startsWith('serial:')) {
      prevSelectedRef.current = selectedIp ?? null
      return
    }
    const prev = prevSelectedRef.current
    if (prev && prev !== selectedIp && !prev.startsWith('serial:')) {
      clearCachesFor(prev)
    }
    prevSelectedRef.current = selectedIp
    if (!device?.online) return
    // Helper opens one TCP connection per command, so each query is a
    // "[TCP] Client connected" line on the device. AP mode + OLED
    // brightness only exist on wearable receivers — skip those 2 for
    // sensor/broker/transmitter so a slow classic-ESP32 node only sees a
    // 3-command burst on selection, not 5 (user report 2026-06-13).
    send({ type: 'get_info', payload: { ip: selectedIp } })
    send({ type: 'get_wifi_status', payload: { ip: selectedIp } })
    send({ type: 'list_wifi_profiles', payload: { ip: selectedIp } })
    if ((device?.role ?? 'receiver') === 'receiver') {
      send({ type: 'get_ap_status', payload: { ip: selectedIp } })
      send({ type: 'get_oled_brightness', payload: { ip: selectedIp } })
    }
  }, [selectedIp, device?.online, device?.role, send, clearCachesFor])

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
        build: p.build as string | undefined,
        group: p.group as number | undefined,
        wifi_connected: p.wifi_connected as boolean | undefined,
        board: p.board as string | undefined,
        // node-roles (DEC-034)
        role: p.role as NodeRole | undefined,
        transport: p.transport as NodeTransport | undefined,
        transports: p.transports as NodeTransport[] | undefined,
        espnow_channel: p.espnow_channel as number | undefined,
        gain: p.gain as number | undefined,
        input_level: p.input_level as number | undefined,
        broker_host: p.broker_host as string | undefined,
        broker_port: p.broker_port as number | undefined,
        topic_root: p.topic_root as string | undefined,
        mqtt_qos: p.mqtt_qos as number | undefined,
        mqtt_connected: p.mqtt_connected as boolean | undefined,
        static_octet: p.static_octet as number | undefined,
        mqtt_port: p.mqtt_port as number | undefined,
        mqtt_running: p.mqtt_running as boolean | undefined,
        mqtt_clients: p.mqtt_clients as MqttClientEntry[] | undefined,
        mqtt_pub_count: p.mqtt_pub_count as number | undefined,
        mqtt_last_topic: p.mqtt_last_topic as string | undefined,
        mqtt_last_payload: p.mqtt_last_payload as string | undefined,
        mappings_count: p.mappings_count as number | undefined,
        sensor_types: p.sensor_types as string[] | undefined,
        alert_loop: p.alert_loop as boolean | undefined,
        alert_limit: p.alert_limit as boolean | undefined,
        ack_hold_ms: p.ack_hold_ms as number | undefined,
        recv_topics: p.recv_topics as string[] | undefined,
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
    } else if (t === 'sensor_mapping_result' && typeof p.device === 'string') {
      // Accept both top-level `mappings` and serial-style `data.mappings`.
      const maps =
        (p.mappings as SensorMapping[] | undefined)
        ?? ((p.data as { mappings?: SensorMapping[] } | undefined)?.mappings)
        ?? []
      setSensorMapping(p.device, maps)
    } else if (t === 'sensor_reading_result' && typeof p.device === 'string') {
      // Live tuning view: accept `data.{r,g,b,...}` (firmware shape) or
      // top-level fields. Error responses (sensor not ready) are skipped —
      // the UI keeps showing the last good sample with its age.
      const d = (p.data as Record<string, unknown> | undefined) ?? p
      if (typeof d.r === 'number' && typeof d.g === 'number' && typeof d.b === 'number') {
        setSensorReading(p.device, {
          sensor: d.sensor as string | undefined,
          r: d.r as number,
          g: d.g as number,
          b: d.b as number,
          clear: d.clear as number | undefined,
          key: d.key as string | undefined,
          age_ms: d.age_ms as number | undefined,
        })
      }
    } else if (t === 'kit_list_result' && typeof p.device === 'string') {
      const kits = (p.kits as Array<{
        kit_id: string
        version?: string
        events?: Array<string | { name: string; mode?: string }>
      }> | undefined) ?? []
      setKitList(p.device, kits)
    } else if (t === 'write_result') {
      const ok = p.success === true
      const summary = (p.summary as string)
        || (p.message as string)
        || (p.error as string)
        || (ok ? 'ok' : 'failed')
      const fullMsg = (p.message as string)
        || (p.error as string)
        || (ok ? 'ok' : 'failed')
      setGlobalStatus({
        kind: ok ? 'ok' : 'err',
        msg: summary.split('\n')[0],
      })
      const tag = ok ? '✓' : '✗'
      for (const line of fullMsg.split('\n')) {
        if (line.trim().length === 0) continue
        pushLog('helper', `${tag} ${line}`)
      }
      const results = p.results as Array<Record<string, unknown>> | undefined
      if (Array.isArray(results)) {
        for (const r of results) {
          if (r.success) continue
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
    setSensorMapping,
    setSensorReading,
  ])

  useEffect(() => {
    if (!globalStatus) return
    const t = setTimeout(() => setGlobalStatus(null), 4000)
    return () => clearTimeout(t)
  }, [globalStatus])

  const playEvent = useCallback((eventId: string, fromKitList: number | null = null) => {
    if (!selectedIp) return
    let intensity = 1.0
    let source = 'fallback 1.0'
    if (fromKitList != null) {
      intensity = fromKitList
      source = `device kit_list (amp ${(intensity * 100).toFixed(0)}%)`
    } else {
      const kits = useLibraryStore.getState().kits
      const tryFind = (matchId: string): { ev: KitEvent; k: KitDefinition } | null => {
        for (const k of kits) {
          const ev = k.events.find((e) => e.eventId === matchId)
          if (ev && typeof ev.intensity === 'number') return { ev, k }
        }
        return null
      }
      const hit = tryFind(eventId)
      if (hit) {
        intensity = hit.ev.intensity
        const mode = hit.ev.modes?.[0] ?? 'command'
        source = `libraryStore (kit=${hit.k.id}, mode=${mode}, amp ${(intensity * 100).toFixed(0)}%)`
      }
    }

    // Send to the CHECKED devices by IP (helper unicasts when `targets` is
    // present), so the user doesn't have to set an address/target string.
    // preview_event rides the helper's UDP path, so only LAN IPs are valid
    // targets — drop any `serial:` pseudo-device in the selection (helper
    // would otherwise sendto() a bogus host and the UI would show a false
    // success). Fall back to the focused device when nothing is checked; the
    // list is non-empty here so the helper never drops to broadcast-all.
    const isLan = (ip: string) => !ip.startsWith('serial:')
    const lanChecked = useDeviceStore.getState().selectedIps.filter(isLan)
    const targets = lanChecked.length > 0
      ? lanChecked
      : (isLan(selectedIp) ? [selectedIp] : [])
    if (targets.length === 0) {
      // Serial-only (USB) selection: preview_event can't ride the serial
      // config channel, so don't send a doomed packet that reads as success.
      setGlobalStatus({ kind: 'warn', msg: 'シリアル接続デバイスではテスト再生できません（LAN 接続が必要）' })
      pushLog('preview', `× preview_event skipped: serial-only selection (event_id=${eventId})`)
      return
    }
    const payload = { event_id: eventId, target: '', gain: intensity, targets }
    send({ type: 'preview_event', payload })
    pushLog(
      'preview',
      `→ ${targets.join(', ')}: preview_event event_id=${eventId} gain=${intensity.toFixed(2)} (${source})`,
    )
  }, [selectedIp, send, pushLog])

  const transport = useDeviceTransport(selectedIp)
  const sendTo = useCallback((msg: ManagerMessage) => { void transport.sendTo(msg) }, [transport])

  if (!device || !selectedIp) {
    return <OnboardingWizard />
  }

  const refreshInfo = () => {
    if (transport.isSerial) {
      void useSerialMaster.getState().refreshAll()
      return
    }
    send({ type: 'get_info', payload: { ip: selectedIp } })
    send({ type: 'get_wifi_status', payload: { ip: selectedIp } })
    send({ type: 'list_wifi_profiles', payload: { ip: selectedIp } })
    // AP/OLED are receiver-only — skip for sensor/broker/transmitter.
    if ((device?.role ?? 'receiver') === 'receiver') {
      send({ type: 'get_ap_status', payload: { ip: selectedIp } })
      send({ type: 'get_oled_brightness', payload: { ip: selectedIp } })
    }
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

  const cachedInfo = transport.isSerial
    ? (masterInfo ? {
        name: masterInfo.name,
        mac: masterInfo.mac,
        fw: masterInfo.fw,
        build: masterInfo.build,
        group: masterInfo.group,
        wifi_connected: masterInfo.wifi_connected,
        role: masterInfo.role,
        transport: masterInfo.transport,
        transports: masterInfo.transports,
        espnow_channel: masterInfo.espnow_channel,
        gain: masterInfo.gain,
        input_level: masterInfo.input_level,
        broker_host: masterInfo.broker_host,
        broker_port: masterInfo.broker_port,
        topic_root: masterInfo.topic_root,
        mqtt_qos: masterInfo.mqtt_qos,
        mqtt_connected: masterInfo.mqtt_connected,
        static_octet: masterInfo.static_octet,
        mqtt_port: masterInfo.mqtt_port,
        mqtt_running: masterInfo.mqtt_running,
        mqtt_clients: masterInfo.mqtt_clients,
        mqtt_pub_count: masterInfo.mqtt_pub_count,
        mqtt_last_topic: masterInfo.mqtt_last_topic,
        mqtt_last_payload: masterInfo.mqtt_last_payload,
        mappings_count: masterInfo.mappings_count,
        sensor_types: masterInfo.sensor_types,
        alert_loop: masterInfo.alert_loop,
        alert_limit: masterInfo.alert_limit,
        ack_hold_ms: masterInfo.ack_hold_ms,
        recv_topics: masterInfo.recv_topics,
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
  const sensorMapping = sensorMappingCache[selectedIp]
  const sensorReading = sensorReadingCache[selectedIp]
  const apInfo = {
    mode: cachedInfo?.mode,
    ap_ssid: cachedInfo?.ap_ssid,
    ap_ip: cachedInfo?.ap_ip,
    ap_has_pass: cachedInfo?.ap_has_pass,
    ap_client_count: cachedInfo?.ap_client_count,
  }

  // ---- Resolve node role / transport (default receiver/udp) ----
  const nodeRole: NodeRole = cachedInfo?.role ?? device.role ?? 'receiver'
  const nodeTransports: NodeTransport[] =
    cachedInfo?.transports
    ?? (cachedInfo?.transport ? [cachedInfo.transport] : undefined)
    ?? device.transports
    ?? (device.transport ? [device.transport] : undefined)
    ?? ['udp']
  const nodeTransport: NodeTransport =
    cachedInfo?.transport ?? device.transport ?? nodeTransports[0] ?? 'udp'

  const subTabs = computeSubTabs(nodeRole, nodeTransport, nodeTransports)
  const activeSubTab: SubTab = subTabs.includes(subTab) ? subTab : (subTabs[0] ?? 'firmware')

  return (
    <section className="devices-detail">
      <div className="devices-detail-header">
        <div className="devices-detail-name">
          {device.name || '(unnamed)'}
        </div>
        <div className="devices-detail-sub">
          <span className="device-detail-pill selected-pill">SELECTED</span>
          {nodeRole !== 'receiver' && (
            <span className="device-detail-pill role-pill">{roleBadge(nodeRole)}</span>
          )}
          {apInfo.mode === 'ap' && (
            <span className="device-detail-pill ap-mode-badge">AP MODE</span>
          )}
          {device.ipAddress}
          {device.firmwareVersion && (
            <>
              {' '}· fw {device.firmwareVersion}
              {cachedInfo?.build && (
                <span className="device-detail-build-sha"> ({cachedInfo.build})</span>
              )}
            </>
          )}
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
        {subTabs.map((id) => (
          <button
            key={id}
            className={`device-subtab-btn${activeSubTab === id ? ' active' : ''}`}
            onClick={() => setSubTab(id)}
          >
            {SUB_TAB_LABEL[id]}
          </button>
        ))}
      </div>

      <div className="device-subtab-body">
        {activeSubTab === 'wifi' && (
          <>
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
          </>
        )}

        {activeSubTab === 'config' && (
          <>
            <IdentityForm
              device={device}
              cachedInfo={cachedInfo}
              sendTo={sendTo}
            />
            {nodeRole === 'receiver' && (
              <UiConfigForm device={device} sendTo={sendTo} />
            )}
            <DebugDumpSection
              device={device}
              dump={debugDump}
              sendTo={sendTo}
            />
            {/* The compact Serial-connect link was removed here — USB
                connection now happens by clicking the card in the left
                Devices panel (user feedback 2026-06-13). */}
          </>
        )}

        {activeSubTab === 'mqtt' && (
          nodeRole === 'broker'
            ? <BrokerConfigSection device={device} cachedInfo={cachedInfo} sendTo={sendTo} />
            : <MqttConfigSection
                device={device}
                cachedInfo={cachedInfo}
                sendTo={sendTo}
                role={nodeRole === 'sensor' ? 'sensor' : 'receiver'}
              />
        )}

        {activeSubTab === 'espnow' && (
          <EspNowConfigSection
            device={device}
            cachedInfo={cachedInfo}
            sendTo={sendTo}
            role={nodeRole === 'transmitter' ? 'transmitter' : 'receiver'}
          />
        )}

        {activeSubTab === 'mapping' && (
          <SensorMappingSection
            device={device}
            mappings={sensorMapping}
            reading={sensorReading}
            sensorType={cachedInfo?.sensor_types?.[0]}
            sendTo={sendTo}
            onRefresh={() => sendTo({ type: 'get_sensor_mapping', payload: {} })}
          />
        )}

        {activeSubTab === 'kit' && (
          <InstalledKitsSection
            device={device}
            kits={kitList}
            sendTo={sendTo}
            onPlayEvent={playEvent}
          />
        )}

        {activeSubTab === 'test' && <TestSubTab device={device} sendTo={sendTo} />}

        {activeSubTab === 'firmware' && (
          <FirmwareSubTab device={device} sendTo={sendTo} />
        )}
      </div>
    </section>
  )
}
