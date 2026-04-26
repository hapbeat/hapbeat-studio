import { useEffect, useMemo, useState } from 'react'
import { useHelperConnection } from '@/hooks/useHelperConnection'
import { useDeviceStore } from '@/stores/deviceStore'
import type { DeviceInfo, ManagerMessage } from '@/types/manager'
import { IdentityForm } from './IdentityForm'
import { WifiForm } from './WifiForm'
import { GroupForm } from './GroupForm'
import { UiConfigForm } from './UiConfigForm'

/**
 * Right-hand pane: forms for the device picked in the sidebar.
 *
 * Subscribes to the Helper connection's `lastMessage` stream so that
 * `get_info_result` / `wifi_status_result` push updates flow into the
 * device-store cache and forms re-render with fresh values.
 */
export function DeviceDetail() {
  const { devices, lastMessage, send } = useHelperConnection()
  const selectedIp = useDeviceStore((s) => s.selectedIp)
  const setInfo = useDeviceStore((s) => s.setInfo)
  const setWifiStatus = useDeviceStore((s) => s.setWifiStatus)
  const infoCache = useDeviceStore((s) => s.infoCache)
  const wifiStatusCache = useDeviceStore((s) => s.wifiStatusCache)

  const device: DeviceInfo | undefined = useMemo(
    () => devices.find((d) => d.ipAddress === selectedIp),
    [devices, selectedIp],
  )

  const [globalStatus, setGlobalStatus] = useState<{ kind: 'ok' | 'err' | 'warn' | 'muted'; msg: string } | null>(null)

  // Drain helper push messages relevant to this view.
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
    } else if (t === 'write_result') {
      const ok = p.success === true
      const msg = (p.message as string) || (p.error as string) || (ok ? 'ok' : 'failed')
      setGlobalStatus({ kind: ok ? 'ok' : 'err', msg })
    }
  }, [lastMessage, setInfo, setWifiStatus])

  // Auto-clear the floating status line after a few seconds.
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
  }

  const cachedInfo = infoCache[selectedIp]
  const wifiStatus = wifiStatusCache[selectedIp]

  return (
    <section className="devices-detail">
      <div className="devices-detail-header">
        <div className="devices-detail-name">
          {device.name || '(unnamed)'}
        </div>
        <div className="devices-detail-sub">
          {device.ipAddress}
          {device.firmwareVersion && <> · fw {device.firmwareVersion}</>}
          {!device.online && <> · offline</>}
        </div>
        <div className="form-action-row" style={{ marginTop: 10 }}>
          <button
            className="form-button-secondary"
            onClick={refreshInfo}
            disabled={!device.online}
            title="デバイスから get_info / get_wifi_status を取得"
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

      <IdentityForm
        device={device}
        cachedInfo={cachedInfo}
        sendTo={sendTo}
      />

      <GroupForm
        device={device}
        cachedInfo={cachedInfo}
        sendTo={sendTo}
      />

      <WifiForm
        device={device}
        wifiStatus={wifiStatus}
        sendTo={sendTo}
      />

      <UiConfigForm
        device={device}
        sendTo={sendTo}
      />
    </section>
  )
}
