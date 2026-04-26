import { useEffect, useMemo, useState } from 'react'
import { useHelperConnection } from '@/hooks/useHelperConnection'
import { useDeviceStore, type WifiProfile } from '@/stores/deviceStore'
import type { DeviceInfo, ManagerMessage } from '@/types/manager'
import { IdentityForm } from './IdentityForm'
import { WifiProfilesForm } from './WifiProfilesForm'
import { UiConfigForm } from './UiConfigForm'
import { DebugDumpSection } from './DebugDumpSection'
import { InstalledKitsSection } from './InstalledKitsSection'
import { TestSubTab } from './TestSubTab'
import { FirmwareSubTab } from './FirmwareSubTab'

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
  const selectedIp = useDeviceStore((s) => s.selectedIp)
  const setInfo = useDeviceStore((s) => s.setInfo)
  const setWifiStatus = useDeviceStore((s) => s.setWifiStatus)
  const setWifiProfiles = useDeviceStore((s) => s.setWifiProfiles)
  const setDebugDump = useDeviceStore((s) => s.setDebugDump)
  const setKitList = useDeviceStore((s) => s.setKitList)
  const infoCache = useDeviceStore((s) => s.infoCache)
  const wifiStatusCache = useDeviceStore((s) => s.wifiStatusCache)
  const wifiProfilesCache = useDeviceStore((s) => s.wifiProfilesCache)
  const debugDumpCache = useDeviceStore((s) => s.debugDumpCache)
  const kitListCache = useDeviceStore((s) => s.kitListCache)

  const device: DeviceInfo | undefined = useMemo(
    () => devices.find((d) => d.ipAddress === selectedIp),
    [devices, selectedIp],
  )

  const [subTab, setSubTab] = useState<SubTab>(() => {
    const saved = localStorage.getItem(SUBTAB_KEY)
    return SUB_TABS.some((t) => t.id === saved) ? (saved as SubTab) : 'config'
  })
  useEffect(() => {
    localStorage.setItem(SUBTAB_KEY, subTab)
  }, [subTab])

  const [globalStatus, setGlobalStatus] = useState<{ kind: 'ok' | 'err' | 'warn' | 'muted'; msg: string } | null>(null)

  // Auto-fetch info / wifi when first selecting a device.
  useEffect(() => {
    if (!selectedIp || !device?.online) return
    if (wifiProfilesCache[selectedIp]) return
    send({ type: 'list_wifi_profiles', payload: { ip: selectedIp } })
    send({ type: 'get_info', payload: { ip: selectedIp } })
    send({ type: 'get_wifi_status', payload: { ip: selectedIp } })
  }, [selectedIp, device?.online, wifiProfilesCache, send])

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
      })
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
      const kits = (p.kits as Array<{
        kit_id: string
        version?: string
        events?: string[]
      }> | undefined) ?? []
      setKitList(p.device, kits)
    } else if (t === 'write_result') {
      const ok = p.success === true
      const msg = (p.message as string) || (p.error as string) || (ok ? 'ok' : 'failed')
      setGlobalStatus({ kind: ok ? 'ok' : 'err', msg })
    }
  }, [
    lastMessage,
    setInfo,
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

  if (!device || !selectedIp) {
    return (
      <section className="devices-detail">
        <div className="devices-detail-empty">
          サイドバーからデバイスを選択してください
        </div>
      </section>
    )
  }

  const sendTo = (msg: ManagerMessage) => {
    const next: ManagerMessage = {
      type: msg.type,
      payload: { ...msg.payload, ip: selectedIp },
    }
    send(next)
  }

  const refreshInfo = () => {
    send({ type: 'get_info', payload: { ip: selectedIp } })
    send({ type: 'get_wifi_status', payload: { ip: selectedIp } })
    send({ type: 'list_wifi_profiles', payload: { ip: selectedIp } })
  }

  const refreshWifiProfiles = () => {
    send({ type: 'list_wifi_profiles', payload: { ip: selectedIp } })
  }

  const cachedInfo = infoCache[selectedIp]
  const wifiStatus = wifiStatusCache[selectedIp]
  const wifiProfiles = wifiProfilesCache[selectedIp]
  const debugDump = debugDumpCache[selectedIp]
  const kitList = kitListCache[selectedIp]

  const playEvent = (eventId: string) => {
    sendTo({
      type: 'preview_event',
      payload: { event_id: eventId, target: device.address || '' },
    })
  }

  return (
    <section className="devices-detail">
      <div className="devices-detail-header">
        <div className="devices-detail-name">
          {device.name || '(unnamed)'}
        </div>
        <div className="devices-detail-sub">
          <span className="device-detail-pill selected-pill">SELECTED</span>
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
            <UiConfigForm device={device} sendTo={sendTo} />
            <DebugDumpSection
              device={device}
              dump={debugDump}
              sendTo={sendTo}
            />
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
