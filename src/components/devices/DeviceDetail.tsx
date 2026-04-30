import { useCallback, useEffect, useMemo, useState } from 'react'
import { useHelperConnection } from '@/hooks/useHelperConnection'
import { useDeviceStore, type WifiProfile } from '@/stores/deviceStore'
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
      const msg = (p.message as string) || (p.error as string) || (ok ? 'ok' : 'failed')
      setGlobalStatus({ kind: ok ? 'ok' : 'err', msg })
      // Mirror every helper write_result to the log drawer so the user
      // can audit the full request/response chain (set_wifi success,
      // play_sent gain, etc.) without having to keep the toast visible.
      pushLog('helper', `${ok ? '✓' : '✗'} ${msg}`)
    }
  }, [
    lastMessage,
    pushLog,
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

  if (!device || !selectedIp) {
    // No device selected — most likely the device hasn't joined Wi-Fi
    // yet (so it doesn't appear in the LAN PING list). Show Serial
    // connect at the top: a Hapbeat that already has firmware will
    // respond to `get_info` and the panel can graduate the user
    // straight into the config UI. Firmware flash sits below for the
    // brand-new / bricked case where `get_info` never answers.
    return (
      <section className="devices-detail devices-detail-onboarding">
        <div className="devices-onboarding-header">
          <div className="devices-onboarding-title">はじめに</div>
          <div className="devices-onboarding-sub">
            Wi-Fi 未接続のデバイス (新品 / 工場出荷状態 / Wi-Fi クリア後) は
            一覧に出ません。まず下の「Serial 接続」を試して、応答があれば
            Wi-Fi / 名前 / グループの初回設定に進めます。応答が無い (新品 /
            ブートローダー破損) 場合はその下の「ファームウェア書き込み」で
            焼き直してから再度 Serial 接続してください。
            既に Wi-Fi 接続済みのデバイスは <strong>サイドバー</strong>から選択できます。
          </div>
        </div>
        <div className="devices-onboarding-divider">
          <span>1. Serial 接続で初回設定</span>
          <span className="devices-onboarding-divider-sub">
            (USB ケーブルで接続 → Wi-Fi / 名前 / グループを設定)
          </span>
        </div>
        <SerialConfigSection />
        <div className="devices-onboarding-divider">
          <span>2. ファームウェア書き込み</span>
          <span className="devices-onboarding-divider-sub">
            (Serial 接続が応答しない場合 / チップが空 / ブートローダー破損時)
          </span>
        </div>
        <FirmwareSubTab serialOnly />
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
            <SerialConfigSection />
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
