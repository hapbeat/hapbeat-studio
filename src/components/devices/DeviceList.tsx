import { useEffect } from 'react'
import { useHelperConnection } from '@/hooks/useHelperConnection'
import { useDeviceStore } from '@/stores/deviceStore'

/**
 * Sidebar listing every Helper-discovered device.
 *
 * Auto-selects the first device on first non-empty list so detail pane
 * is populated without an extra click. Manual selection persists.
 */
export function DeviceList() {
  const { isConnected, devices } = useHelperConnection()
  const selectedIp = useDeviceStore((s) => s.selectedIp)
  const selectDevice = useDeviceStore((s) => s.selectDevice)

  // Auto-select on initial population if nothing is selected.
  useEffect(() => {
    if (!selectedIp && devices.length > 0) {
      selectDevice(devices[0].ipAddress)
    }
  }, [devices, selectedIp, selectDevice])

  if (!isConnected) {
    return (
      <aside className="devices-sidebar">
        <div className="devices-sidebar-header">
          <span className="devices-sidebar-title">Devices</span>
        </div>
        <div className="devices-empty">
          Helper 未接続<br />
          <code>hapbeat-helper start --foreground</code>
        </div>
      </aside>
    )
  }

  return (
    <aside className="devices-sidebar">
      <div className="devices-sidebar-header">
        <span className="devices-sidebar-title">Devices</span>
        <span className="devices-sidebar-count">{devices.length}</span>
      </div>
      <div className="devices-sidebar-list">
        {devices.length === 0 ? (
          <div className="devices-empty">
            検出中…<br />
            デバイスを Wi-Fi に接続してください
          </div>
        ) : (
          devices.map((dev) => (
            <div
              key={dev.ipAddress || dev.name}
              className={`device-row${selectedIp === dev.ipAddress ? ' selected' : ''}`}
              onClick={() => selectDevice(dev.ipAddress)}
            >
              <div className="device-row-top">
                <span className="device-row-name">{dev.name || '(unnamed)'}</span>
                <span
                  className={`device-row-status ${dev.online ? 'online' : 'offline'}`}
                >
                  {dev.online ? '●' : '○'}
                </span>
              </div>
              <div className="device-row-meta">
                <span className="device-row-meta-ip">{dev.ipAddress || '—'}</span>
                {dev.address && <span>{dev.address}</span>}
                {dev.firmwareVersion && <span>fw {dev.firmwareVersion}</span>}
              </div>
            </div>
          ))
        )}
      </div>
    </aside>
  )
}
