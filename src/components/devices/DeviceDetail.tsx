import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useHelperConnection } from '@/hooks/useHelperConnection'
import { useDeviceStore, type WifiProfile } from '@/stores/deviceStore'
import { ApModeSection } from './ApModeSection'
import { useLibraryStore } from '@/stores/libraryStore'
import type { KitDefinition, KitEvent } from '@/types/library'
import { useLogStore } from '@/stores/logStore'
import type { DeviceInfo, ManagerMessage, NodeRole, NodeTransport, SensorMapping } from '@/types/manager'
import { IdentityForm } from './IdentityForm'
import { WifiProfilesForm } from './WifiProfilesForm'
import { UiConfigForm } from './UiConfigForm'
import { DebugDumpSection } from './DebugDumpSection'
import { InstalledKitsSection } from './InstalledKitsSection'
import { SerialConfigSection } from './SerialConfigSection'
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

type SubTab = 'wifi' | 'config' | 'kit' | 'test' | 'firmware' | 'espnow' | 'broker' | 'mapping'

const SUB_TAB_LABEL: Record<SubTab, string> = {
  wifi: 'Wi-Fi',
  config: '設定',
  kit: 'Kit',
  test: '再生テスト',
  firmware: 'ファームウェア',
  espnow: 'ESP-NOW',
  broker: 'ブローカー',
  mapping: 'マッピング',
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
      return ['wifi', 'config', 'mapping', 'firmware']
    case 'broker':
      return ['wifi', 'config', 'broker', 'firmware']
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
      // udp / mqtt receiver (mqtt host appears inside 設定).
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
  const infoCache = useDeviceStore((s) => s.infoCache)
  const wifiStatusCache = useDeviceStore((s) => s.wifiStatusCache)
  const wifiProfilesCache = useDeviceStore((s) => s.wifiProfilesCache)
  const debugDumpCache = useDeviceStore((s) => s.debugDumpCache)
  const kitListCache = useDeviceStore((s) => s.kitListCache)
  const sensorMappingCache = useDeviceStore((s) => s.sensorMappingCache)

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

  const lastEvaluatedIpRef = useRef<string | null>(null)
  useEffect(() => {
    if (!selectedIp) return
    if (lastEvaluatedIpRef.current === selectedIp) return
    lastEvaluatedIpRef.current = selectedIp
    const wifiOk = selectedIp.startsWith('serial:')
      ? !!useSerialMaster.getState().wifiStatus?.connected
      : !!wifiStatusCache[selectedIp]?.connected
    if (!wifiOk) setSubTab('wifi')
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
        static_octet: p.static_octet as number | undefined,
        mqtt_port: p.mqtt_port as number | undefined,
        mqtt_running: p.mqtt_running as boolean | undefined,
        mappings_count: p.mappings_count as number | undefined,
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

    const payload = { event_id: eventId, target: '', gain: intensity }
    send({ type: 'preview_event', payload })
    pushLog(
      'preview',
      `→ ${selectedIp}: preview_event event_id=${eventId} gain=${intensity.toFixed(2)} (${source})`,
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
        static_octet: masterInfo.static_octet,
        mqtt_port: masterInfo.mqtt_port,
        mqtt_running: masterInfo.mqtt_running,
        mappings_count: masterInfo.mappings_count,
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
            <span className="device-detail-pill role-pill">{nodeRole.toUpperCase()}</span>
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
            {(nodeRole === 'sensor'
              || (nodeRole === 'receiver' && nodeTransports.includes('mqtt'))) && (
              <MqttConfigSection device={device} cachedInfo={cachedInfo} sendTo={sendTo} />
            )}
            {nodeRole === 'receiver' && (
              <UiConfigForm device={device} sendTo={sendTo} />
            )}
            <DebugDumpSection
              device={device}
              dump={debugDump}
              sendTo={sendTo}
            />
            <SerialConfigSection compact />
          </>
        )}

        {activeSubTab === 'espnow' && (
          <EspNowConfigSection
            device={device}
            cachedInfo={cachedInfo}
            sendTo={sendTo}
            role={nodeRole === 'transmitter' ? 'transmitter' : 'receiver'}
          />
        )}

        {activeSubTab === 'broker' && (
          <BrokerConfigSection device={device} cachedInfo={cachedInfo} sendTo={sendTo} />
        )}

        {activeSubTab === 'mapping' && (
          <SensorMappingSection
            device={device}
            mappings={sensorMapping}
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
