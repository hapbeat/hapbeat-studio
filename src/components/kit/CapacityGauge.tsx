import { useEffect, useState, useCallback } from 'react'
import type { DeviceInfo, ManagerMessage, SpaceResult } from '@/types/manager'
import { formatFileSize } from '@/utils/wavIO'

const DEFAULT_CAPACITY = 4 * 1024 * 1024 // 4MB

interface CapacityGaugeProps {
  kitSize: number
  managerConnected: boolean
  devices: DeviceInfo[]
  send: (msg: ManagerMessage) => void
}

export function CapacityGauge({ kitSize, managerConnected, devices, send }: CapacityGaugeProps) {
  const [space, setSpace] = useState<SpaceResult | null>(null)
  const [queried, setQueried] = useState(false)

  const querySpace = useCallback(() => {
    if (!managerConnected || devices.length === 0) return
    // No target — Manager answers for its selected device(s)
    send({ type: 'query_space', payload: {} })
    setQueried(true)
  }, [managerConnected, devices, send])

  // Query space on mount / device change
  useEffect(() => {
    if (managerConnected && devices.length > 0 && !queried) {
      querySpace()
    }
  }, [managerConnected, devices.length, queried, querySpace])

  // Listen for space_result via custom event (set up in useManagerConnection)
  useEffect(() => {
    const handler = (e: CustomEvent<SpaceResult>) => {
      setSpace(e.detail)
    }
    window.addEventListener('hapbeat-space-result', handler as EventListener)
    return () => window.removeEventListener('hapbeat-space-result', handler as EventListener)
  }, [])

  const totalBytes = space?.total_bytes ?? DEFAULT_CAPACITY
  const usedBytes = space?.used_bytes ?? 0
  const freeBytes = space?.free_bytes ?? (totalBytes - usedBytes)
  const usedPct = (usedBytes / totalBytes) * 100
  const kitPct = (kitSize / totalBytes) * 100
  const wouldExceed = kitSize > freeBytes

  if (kitSize === 0 && !space) return null

  return (
    <div className="capacity-gauge">
      <div className="capacity-bar">
        <div
          className="capacity-used"
          style={{ width: `${Math.min(usedPct, 100)}%` }}
        />
        <div
          className={`capacity-kit ${wouldExceed ? 'exceed' : ''}`}
          style={{ width: `${Math.min(kitPct, 100 - usedPct)}%`, left: `${usedPct}%` }}
        />
      </div>
      <div className="capacity-labels">
        <span title="Device storage in use">
          Used: {formatFileSize(usedBytes)} / {formatFileSize(totalBytes)}
        </span>
        {kitSize > 0 && (
          <span className={wouldExceed ? 'capacity-warning' : ''} title="Size of the current kit">
            Kit: {formatFileSize(kitSize)}
            {wouldExceed && ' (exceeds free space!)'}
          </span>
        )}
        <span title="Remaining device storage">Free: {formatFileSize(freeBytes)}</span>
        {devices.length > 0 && devices[0].volumeWiper != null && (
          <span className="capacity-vol" title="Connected Hapbeat device volume (MCP4018 wiper 0–127, 128段階)">
            Vol {devices[0].volumeWiper}/128 ({Math.round((devices[0].volumeWiper / 127) * 100)}%)
          </span>
        )}
      </div>
      {!space && (
        <div className="capacity-note">
          {managerConnected && devices.length > 0
            ? 'Querying device...'
            : 'Estimated (no device connected)'}
        </div>
      )}
    </div>
  )
}
