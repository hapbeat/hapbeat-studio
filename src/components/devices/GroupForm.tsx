import { useEffect, useState } from 'react'
import type { DeviceInfo, ManagerMessage } from '@/types/manager'

interface Props {
  device: DeviceInfo
  cachedInfo?: { group?: number }
  sendTo: (msg: ManagerMessage) => void
}

/**
 * Single-knob group ID setter (broadcast group filter on Layer 1).
 * Group 0 means "receive everything" — we still allow it because the
 * firmware does, but mark it visually.
 */
export function GroupForm({ device, cachedInfo, sendTo }: Props) {
  const [group, setGroup] = useState<number>(cachedInfo?.group ?? 0)

  useEffect(() => {
    setGroup(cachedInfo?.group ?? 0)
  }, [device.ipAddress, cachedInfo?.group])

  const submit = () => {
    sendTo({ type: 'set_group', payload: { group } })
  }

  return (
    <div className="form-section">
      <div className="form-section-title">グループ ID</div>
      <div className="form-row">
        <label>group</label>
        <div className="form-row-multi">
          <input
            className="form-input short"
            type="number"
            min={0}
            max={255}
            value={group}
            onChange={(e) => setGroup(Math.max(0, Math.min(255, Number(e.target.value) || 0)))}
            disabled={!device.online}
          />
          {group === 0 && (
            <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
              (0 = ブロードキャスト / 全受信)
            </span>
          )}
        </div>
        <button className="form-button" onClick={submit} disabled={!device.online}>
          設定
        </button>
      </div>
      {cachedInfo?.group !== undefined && (
        <div className="form-status muted">
          デバイスから読み込み: group={cachedInfo.group}
        </div>
      )}
    </div>
  )
}
