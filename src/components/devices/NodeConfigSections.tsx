import { useEffect, useMemo, useRef, useState } from 'react'
import type { DeviceInfo, ManagerMessage, SensorMapping } from '@/types/manager'
import { useLibraryStore } from '@/stores/libraryStore'

/**
 * Per-node-role config panels (DEC-034). Each speaks the common
 * serial/TCP JSON config protocol (contracts: serial-config.md §4b)
 * through the transport-agnostic `sendTo`, so they work identically
 * over Helper-relayed TCP (LAN) and Web Serial (USB).
 */

/** Subset of the get_info cache these panels read. */
export interface NodeConfigInfo {
  espnow_channel?: number
  gain?: number
  input_level?: number
  broker_host?: string
  static_octet?: number
  mqtt_port?: number
  mqtt_running?: boolean
  mappings_count?: number
}

const ESPNOW_CHANNELS = [1, 6, 11]

// ---------------------------------------------------------------------
// ESP-NOW: channel (+ gain for receiver / input level for transmitter)
// ---------------------------------------------------------------------

export function EspNowConfigSection({
  device,
  cachedInfo,
  sendTo,
  role,
}: {
  device: DeviceInfo
  cachedInfo?: NodeConfigInfo
  sendTo: (msg: ManagerMessage) => void
  role: 'receiver' | 'transmitter'
}) {
  const [channel, setChannel] = useState<number>(cachedInfo?.espnow_channel ?? 1)
  // gain (receiver) is 0..1; input level (transmitter) is 0..100.
  const [gain, setGain] = useState<number>(cachedInfo?.gain ?? 0.8)
  const [inputLevel, setInputLevel] = useState<number>(cachedInfo?.input_level ?? 50)

  useEffect(() => {
    if (cachedInfo?.espnow_channel != null) setChannel(cachedInfo.espnow_channel)
    if (cachedInfo?.gain != null) setGain(cachedInfo.gain)
    if (cachedInfo?.input_level != null) setInputLevel(cachedInfo.input_level)
  }, [device.ipAddress, cachedInfo?.espnow_channel, cachedInfo?.gain, cachedInfo?.input_level])

  const apply = () => {
    sendTo({ type: 'set_espnow_channel', payload: { channel } })
    if (role === 'transmitter') {
      sendTo({ type: 'set_input_level', payload: { level: inputLevel } })
    } else {
      sendTo({ type: 'set_gain', payload: { gain } })
    }
  }

  return (
    <div className="form-section">
      <div className="form-section-title">
        ESP-NOW 設定
        <span className="form-section-sub-inline">
          {' '}— ライブ会場同報 ({role === 'transmitter' ? '送信機' : '受信機'})
        </span>
      </div>

      <div className="form-row">
        <label>チャンネル</label>
        <div className="form-row-multi">
          {ESPNOW_CHANNELS.map((ch) => (
            <button
              key={ch}
              type="button"
              className={`form-button${channel === ch ? '' : '-secondary'}`}
              onClick={() => setChannel(ch)}
              disabled={!device.online}
            >
              {ch}
            </button>
          ))}
        </div>
        <span />
      </div>
      <div className="form-status muted">
        送信機と全受信機で同じチャンネルにそろえてください (1 / 6 / 11)。
      </div>

      {role === 'receiver' ? (
        <div className="form-row">
          <label>既定ゲイン</label>
          <div className="form-row-multi" style={{ alignItems: 'center', gap: 8 }}>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={gain}
              onChange={(e) => setGain(Number(e.target.value))}
              disabled={!device.online}
              style={{ flex: 1 }}
            />
            <span className="mono" style={{ width: 48, textAlign: 'right' }}>
              {(gain * 100).toFixed(0)}%
            </span>
          </div>
          <span />
        </div>
      ) : (
        <div className="form-row">
          <label>入力レベル</label>
          <div className="form-row-multi" style={{ alignItems: 'center', gap: 8 }}>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={inputLevel}
              onChange={(e) => setInputLevel(Number(e.target.value))}
              disabled={!device.online}
              style={{ flex: 1 }}
            />
            <span className="mono" style={{ width: 48, textAlign: 'right' }}>
              {inputLevel}
            </span>
          </div>
          <span />
        </div>
      )}

      <div className="form-action-row" style={{ marginTop: 8 }}>
        <button className="form-button" onClick={apply} disabled={!device.online}>
          適用
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------
// MQTT broker host (receiver(mqtt) / sensor)
// ---------------------------------------------------------------------

export function MqttConfigSection({
  device,
  cachedInfo,
  sendTo,
}: {
  device: DeviceInfo
  cachedInfo?: NodeConfigInfo
  sendTo: (msg: ManagerMessage) => void
}) {
  const initialHost = cachedInfo?.broker_host ?? 'auto'
  const [auto, setAuto] = useState<boolean>(initialHost === 'auto')
  const [host, setHost] = useState<string>(initialHost === 'auto' ? '' : initialHost)

  useEffect(() => {
    const h = cachedInfo?.broker_host
    if (h == null) return
    if (h === 'auto') {
      setAuto(true)
      setHost('')
    } else {
      setAuto(false)
      setHost(h)
    }
  }, [device.ipAddress, cachedInfo?.broker_host])

  const apply = () => {
    const value = auto ? 'auto' : host.trim()
    if (!auto && !value) return
    sendTo({ type: 'set_broker_host', payload: { host: value } })
  }

  return (
    <div className="form-section">
      <div className="form-section-title">
        MQTT ブローカー
        <span className="form-section-sub-inline">
          {' '}— センサ通知の中継先
        </span>
      </div>

      <label
        className="form-status muted"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
      >
        <input
          type="checkbox"
          checked={auto}
          onChange={(e) => setAuto(e.target.checked)}
          disabled={!device.online}
        />
        自動検出 (mDNS で hapbeat-broker を探す)
      </label>

      {!auto && (
        <div className="form-row" style={{ marginTop: 6 }}>
          <label>ホスト/IP</label>
          <input
            className="form-input mono"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="192.168.1.10 または hapbeat-broker.local"
            disabled={!device.online}
          />
          <span />
        </div>
      )}

      <div className="form-action-row" style={{ marginTop: 8 }}>
        <button className="form-button" onClick={apply} disabled={!device.online}>
          適用
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------
// Embedded broker config (role = broker)
// ---------------------------------------------------------------------

export function BrokerConfigSection({
  device,
  cachedInfo,
  sendTo,
}: {
  device: DeviceInfo
  cachedInfo?: NodeConfigInfo
  sendTo: (msg: ManagerMessage) => void
}) {
  const [octet, setOctet] = useState<number>(cachedInfo?.static_octet ?? 10)
  const [port, setPort] = useState<number>(cachedInfo?.mqtt_port ?? 1883)

  useEffect(() => {
    if (cachedInfo?.static_octet != null) setOctet(cachedInfo.static_octet)
    if (cachedInfo?.mqtt_port != null) setPort(cachedInfo.mqtt_port)
  }, [device.ipAddress, cachedInfo?.static_octet, cachedInfo?.mqtt_port])

  const apply = () => {
    sendTo({ type: 'set_broker_config', payload: { static_octet: octet, port } })
  }

  return (
    <div className="form-section">
      <div className="form-section-title">
        ブローカー設定
        <span className="form-section-sub-inline">
          {' '}— 組み込み MQTT ブローカー (PC 不要)
        </span>
      </div>

      {cachedInfo?.mqtt_running != null && (
        <div className={`form-status ${cachedInfo.mqtt_running ? 'ok' : 'warn'}`}>
          ブローカー: {cachedInfo.mqtt_running ? '稼働中' : '停止中'}
        </div>
      )}

      <div className="form-row">
        <label>固定ホストオクテット</label>
        <input
          className="form-input short"
          type="number"
          min={2}
          max={254}
          value={octet}
          onChange={(e) => setOctet(Math.max(2, Math.min(254, Number(e.target.value) || 10)))}
          disabled={!device.online}
        />
        <span />
      </div>
      <div className="form-status muted">
        ゲートウェイのサブネット上で broker が名乗る固定ホスト番号 (2〜254)。
      </div>

      <div className="form-row">
        <label>ポート</label>
        <input
          className="form-input short"
          type="number"
          min={1}
          max={65535}
          value={port}
          onChange={(e) => setPort(Math.max(1, Math.min(65535, Number(e.target.value) || 1883)))}
          disabled={!device.online}
        />
        <span />
      </div>

      <div className="form-action-row" style={{ marginTop: 8 }}>
        <button className="form-button" onClick={apply} disabled={!device.online}>
          適用
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------
// Sensor → event mapping editor (role = sensor) — the "color → event"
// editor (Unity EventMap equivalent).
// ---------------------------------------------------------------------

const COLOR_KEYS = ['r', 'g', 'b'] as const
type ColorChannel = (typeof COLOR_KEYS)[number]

function emptyMapping(): SensorMapping {
  return { key: '', match: {}, event_id: '', target: '', gain: 1.0 }
}

export function SensorMappingSection({
  device,
  mappings,
  sendTo,
  onRefresh,
}: {
  device: DeviceInfo
  /** Loaded mappings from the device (get_sensor_mapping result). */
  mappings?: SensorMapping[]
  sendTo: (msg: ManagerMessage) => void
  onRefresh: () => void
}) {
  const [rows, setRows] = useState<SensorMapping[]>(mappings ?? [])
  const [dirty, setDirty] = useState(false)
  const [status, setStatus] = useState<string | null>(null)

  // Sync from device-loaded mappings unless the user has local edits.
  useEffect(() => {
    if (!dirty && mappings) setRows(mappings)
  }, [mappings, dirty])

  // Auto-load the device's current mappings once per device when the
  // tab opens (so the editor isn't blank on first view).
  const loadedForRef = useRef<string | null>(null)
  useEffect(() => {
    if (loadedForRef.current === device.ipAddress) return
    loadedForRef.current = device.ipAddress
    if (device.online && !mappings) onRefresh()
    // onRefresh identity is unstable (inline arrow); guarded by the ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device.ipAddress, device.online])

  // Available event ids from the local Kit library (datalist suggestions).
  const eventIds = useLibraryStore((s) => s.kits)
  const eventIdOptions = useMemo(() => {
    const ids = new Set<string>()
    for (const k of eventIds) for (const e of k.events) if (e.eventId) ids.add(e.eventId)
    return [...ids].sort()
  }, [eventIds])

  const update = (i: number, patch: Partial<SensorMapping>) => {
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
    setDirty(true)
  }
  const updateMatch = (i: number, ch: ColorChannel, bound: 'min' | 'max', v: string) => {
    setRows((rs) =>
      rs.map((r, idx) => {
        if (idx !== i) return r
        const match = { ...r.match }
        const field = `${ch}_${bound}` as keyof typeof match
        if (v === '') delete match[field]
        else match[field] = Math.max(0, Math.min(255, Number(v) || 0))
        return { ...r, match }
      }),
    )
    setDirty(true)
  }
  const addRow = () => {
    setRows((rs) => [...rs, emptyMapping()])
    setDirty(true)
  }
  const removeRow = (i: number) => {
    setRows((rs) => rs.filter((_, idx) => idx !== i))
    setDirty(true)
  }

  const save = () => {
    const clean = rows
      .filter((r) => r.key.trim() && r.event_id.trim())
      .map((r) => ({ ...r, key: r.key.trim(), event_id: r.event_id.trim(), target: r.target.trim() }))
    sendTo({ type: 'set_sensor_mapping', payload: { mappings: clean } })
    setStatus(`${clean.length} 件を保存しました`)
    setDirty(false)
    setTimeout(() => setStatus(null), 3000)
  }

  const reload = () => {
    onRefresh()
    setDirty(false)
  }

  return (
    <div className="form-section">
      <div className="form-section-title" style={{ display: 'flex', justifyContent: 'space-between' }}>
        <span>
          センサ → イベント マッピング
          <span className="form-section-sub-inline">
            {' '}— 検出値ごとに発火するイベントを割り当てる
          </span>
        </span>
        <button
          className="form-button-secondary"
          onClick={reload}
          disabled={!device.online}
          style={{ fontSize: 13, padding: '2px 8px' }}
        >
          ⟳ 読み込み
        </button>
      </div>

      <datalist id="sensor-mapping-event-ids">
        {eventIdOptions.map((id) => <option key={id} value={id} />)}
      </datalist>

      {rows.length === 0 && (
        <div className="form-status muted">
          マッピング未設定です。「＋ 行を追加」で割り当てを作成してください。
        </div>
      )}

      {rows.map((r, i) => (
        <div
          key={i}
          className="form-section"
          style={{ padding: 10, marginTop: 8, border: '1px solid var(--border)', borderRadius: 4 }}
        >
          <div className="form-row">
            <label>キー</label>
            <input
              className="form-input"
              value={r.key}
              onChange={(e) => update(i, { key: e.target.value })}
              placeholder="例: red"
              disabled={!device.online}
              style={{ flex: '0 0 120px' }}
            />
            <button
              className="form-button-secondary"
              onClick={() => removeRow(i)}
              disabled={!device.online}
              title="この行を削除"
            >
              削除
            </button>
          </div>

          <div className="form-row">
            <label>色しきい値</label>
            <div className="form-row-multi" style={{ flexWrap: 'wrap', gap: 6 }}>
              {COLOR_KEYS.map((ch) => (
                <span key={ch} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                  <span className="mono" style={{ textTransform: 'uppercase', width: 14 }}>{ch}</span>
                  <input
                    className="form-input short"
                    type="number"
                    min={0}
                    max={255}
                    placeholder="min"
                    value={r.match[`${ch}_min` as keyof typeof r.match] ?? ''}
                    onChange={(e) => updateMatch(i, ch, 'min', e.target.value)}
                    disabled={!device.online}
                    style={{ width: 56 }}
                  />
                  <span style={{ color: 'var(--text-muted)' }}>–</span>
                  <input
                    className="form-input short"
                    type="number"
                    min={0}
                    max={255}
                    placeholder="max"
                    value={r.match[`${ch}_max` as keyof typeof r.match] ?? ''}
                    onChange={(e) => updateMatch(i, ch, 'max', e.target.value)}
                    disabled={!device.online}
                    style={{ width: 56 }}
                  />
                </span>
              ))}
            </div>
            <span />
          </div>

          <div className="form-row">
            <label>イベント</label>
            <input
              className="form-input mono"
              value={r.event_id}
              onChange={(e) => update(i, { event_id: e.target.value })}
              placeholder="kit-name.clip-name"
              list="sensor-mapping-event-ids"
              disabled={!device.online}
            />
            <span />
          </div>

          <div className="form-row">
            <label>ターゲット</label>
            <input
              className="form-input mono"
              value={r.target}
              onChange={(e) => update(i, { target: e.target.value })}
              placeholder="空欄 = 全台 / player_1/chest"
              disabled={!device.online}
            />
            <span />
          </div>

          <div className="form-row">
            <label>ゲイン</label>
            <div className="form-row-multi" style={{ alignItems: 'center', gap: 8 }}>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={r.gain}
                onChange={(e) => update(i, { gain: Number(e.target.value) })}
                disabled={!device.online}
                style={{ flex: 1 }}
              />
              <span className="mono" style={{ width: 48, textAlign: 'right' }}>
                {(r.gain * 100).toFixed(0)}%
              </span>
            </div>
            <span />
          </div>
        </div>
      ))}

      <div className="form-action-row" style={{ marginTop: 10 }}>
        <button className="form-button-secondary" onClick={addRow} disabled={!device.online}>
          ＋ 行を追加
        </button>
        <button className="form-button" onClick={save} disabled={!device.online || !dirty}>
          保存
        </button>
        {status && <span className="form-status ok" style={{ alignSelf: 'center' }}>{status}</span>}
      </div>
    </div>
  )
}
