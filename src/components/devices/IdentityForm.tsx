import { useEffect, useState } from 'react'
import type { DeviceInfo, ManagerMessage } from '@/types/manager'
import {
  POSITION_NAMES,
  positionLabel,
  parseAddress,
  buildAddress,
} from './positions'

interface Props {
  device: DeviceInfo
  cachedInfo?: { name?: string; group?: number }
  sendTo: (msg: ManagerMessage) => void
}

/**
 * Name + path-based address (`[prefix/]player_N/pos_xxx`).
 *
 * Initial values come from the live `DeviceInfo` (PONG-discovered) and
 * any `get_info` cache. Editing is local until "変更" is clicked, at
 * which point the full set_* command is sent to Helper.
 */
export function IdentityForm({ device, cachedInfo, sendTo }: Props) {
  const [name, setName] = useState(device.name)

  const initial = parseAddress(device.address)
  const [prefix, setPrefix] = useState(initial.prefix)
  const [player, setPlayer] = useState<number>(initial.player)
  const [position, setPosition] = useState<string>(initial.position)

  // Re-sync local state when the user picks a different device
  // (avoids the form silently editing the wrong one).
  useEffect(() => {
    setName(cachedInfo?.name ?? device.name)
    const a = parseAddress(device.address)
    setPrefix(a.prefix)
    setPlayer(a.player)
    setPosition(a.position)
  }, [device.ipAddress, device.address, device.name, cachedInfo?.name])

  const submitName = () => {
    if (!name.trim()) return
    sendTo({ type: 'set_name', payload: { name: name.trim() } })
  }

  const submitAddress = () => {
    const addr = buildAddress(prefix, player, position)
    sendTo({ type: 'set_address', payload: { address: addr } })
  }

  return (
    <div className="form-section">
      <div className="form-section-title">デバイス識別</div>

      <div className="form-row">
        <label>名前</label>
        <input
          className="form-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={32}
          placeholder="hapbeat-XXXX"
          disabled={!device.online}
        />
        <button
          className="form-button"
          onClick={submitName}
          disabled={!device.online || !name.trim()}
        >
          変更
        </button>
      </div>

      <div className="form-row">
        <label>アドレス</label>
        <div className="form-row-multi">
          <input
            className="form-input"
            value={prefix}
            onChange={(e) => setPrefix(e.target.value)}
            placeholder="prefix (任意)"
            disabled={!device.online}
            style={{ flex: '1 1 100px' }}
          />
          <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>player_</span>
          <input
            className="form-input short"
            type="number"
            min={1}
            max={99}
            value={player}
            onChange={(e) => setPlayer(Math.max(1, Math.min(99, Number(e.target.value) || 1)))}
            disabled={!device.online}
          />
          <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>/</span>
          <select
            className="form-select"
            value={position}
            onChange={(e) => setPosition(e.target.value)}
            disabled={!device.online}
            style={{ flex: '1 1 110px' }}
          >
            {POSITION_NAMES.map((p) => (
              <option key={p} value={p}>{positionLabel(p)}</option>
            ))}
          </select>
        </div>
        <button
          className="form-button"
          onClick={submitAddress}
          disabled={!device.online}
        >
          設定
        </button>
      </div>

      <div className="form-status muted">
        現在: <code className="form-input mono" style={{ background: 'transparent', border: 'none', padding: 0, width: 'auto', color: 'var(--text-secondary)' }}>{device.address || '(未設定)'}</code>
      </div>
    </div>
  )
}
