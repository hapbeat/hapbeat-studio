import { useEffect, useState } from 'react'
import type { DeviceInfo, ManagerMessage } from '@/types/manager'
import { useConfirm } from '@/components/common/useConfirm'
import { useInputHistory } from '@/hooks/useInputHistory'
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
  /** Optional: clears `cachedInfo` from the master after a successful
   *  set_name so the live state mirrors the wire. */
  onChanged?: () => void
}

/**
 * Name + path-based address (`[prefix/]player_N/pos_xxx`).
 *
 * Initial values come from the live `DeviceInfo` (PONG-discovered) and
 * any `get_info` cache. Editing is local until "変更" is clicked, at
 * which point the full set_* command is sent to Helper.
 */
export function IdentityForm({ device, cachedInfo, sendTo, onChanged }: Props) {
  const [name, setName] = useState(device.name)

  const initial = parseAddress(device.address)
  const [prefix, setPrefix] = useState(initial.prefix)
  const [player, setPlayer] = useState<number>(initial.player)
  const [position, setPosition] = useState<string>(initial.position)
  // Group は contracts spec §2 改定 (2026-05-07, DEC-030) で
  // address 末尾の `/group_<N>` 任意セグメントに統合された。
  // 旧 set_group (uint8) は廃止 — source of truth は address のみ。
  // -1 = 未指定 (suffix なし、全グループ受信)、1..99 = 指定。
  const [group, setGroup] = useState<number>(initial.group)
  const { ask, dialog: confirmDialog } = useConfirm()
  // Persisted recall for free-text identity fields. Recent values are
  // suggested via <datalist> on the same field so a user adding 5 new
  // Hapbeats doesn't have to type "MyShow/" five times.
  const nameHistory = useInputHistory('device-name')
  const prefixHistory = useInputHistory('device-address-prefix')

  // Re-sync local state when the user picks a different device
  // (avoids the form silently editing the wrong one).
  useEffect(() => {
    setName(cachedInfo?.name ?? device.name)
    const a = parseAddress(device.address)
    setPrefix(a.prefix)
    setPlayer(a.player)
    setPosition(a.position)
    setGroup(a.group)
  }, [device.ipAddress, device.address, device.name, cachedInfo?.name])

  const submitName = () => {
    if (!name.trim()) return
    sendTo({ type: 'set_name', payload: { name: name.trim() } })
    nameHistory.commit(name.trim())
    onChanged?.()
  }

  const submitAddress = () => {
    const addr = buildAddress(prefix, player, position, group)
    sendTo({ type: 'set_address', payload: { address: addr } })
    if (prefix.trim()) prefixHistory.commit(prefix.trim())
    onChanged?.()
  }

  const submitReboot = async () => {
    const ok = await ask({
      title: '再起動',
      message: 'デバイスを再起動しますか？',
      confirmLabel: '再起動する',
    })
    if (!ok) return
    sendTo({ type: 'reboot', payload: {} })
  }

  return (
    <div className="form-section">
      {confirmDialog}
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
          list={nameHistory.historyId}
        />
        <datalist id={nameHistory.historyId}>
          {nameHistory.history.map((h) => <option key={h} value={h} />)}
        </datalist>
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
            list={prefixHistory.historyId}
          />
          <datalist id={prefixHistory.historyId}>
            {prefixHistory.history.map((h) => <option key={h} value={h} />)}
          </datalist>
          <span style={{ color: 'var(--text-muted)', fontSize: 14 }}>/&nbsp;player_</span>
          <input
            className="form-input short"
            type="number"
            min={1}
            max={99}
            value={player}
            onChange={(e) => setPlayer(Math.max(1, Math.min(99, Number(e.target.value) || 1)))}
            disabled={!device.online}
          />
          <span style={{ color: 'var(--text-muted)', fontSize: 14 }}>/</span>
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
          <span style={{ color: 'var(--text-muted)', fontSize: 14 }}>/&nbsp;group_</span>
          <input
            className="form-input short"
            type="number"
            min={1}
            max={99}
            value={group < 1 ? '' : group}
            placeholder="未指定"
            onChange={(e) => {
              const v = e.target.value
              if (v === '') setGroup(-1)
              else {
                const n = Number(v)
                if (Number.isFinite(n) && n >= 1 && n <= 99) setGroup(n)
              }
            }}
            disabled={!device.online}
            title="1〜99 で指定、空欄で全グループ受信 (suffix なし)"
          />
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

      <div className="form-action-row" style={{ marginTop: 8 }}>
        <button
          className="form-button-secondary"
          onClick={submitReboot}
          disabled={!device.online}
          title="set_* コマンドの一部は再起動後に有効になる"
        >
          再起動
        </button>
      </div>
    </div>
  )
}
