import { useEffect, useMemo, useRef, useState } from 'react'
import type { DeviceInfo, ManagerMessage, MqttClientEntry, SensorColorMatch, SensorMapping, SensorReading } from '@/types/manager'
import { useLibraryStore } from '@/stores/libraryStore'
import { useMqttTopicsStore, sanitizeTopic } from '@/stores/mqttTopicsStore'
import { MqttFlowPanel } from './MqttFlow'

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
  broker_port?: number
  topic_root?: string
  mqtt_qos?: number
  mqtt_connected?: boolean
  static_octet?: number
  mqtt_port?: number
  mqtt_running?: boolean
  mqtt_clients?: MqttClientEntry[]
  mqtt_pub_count?: number
  mqtt_last_topic?: string
  mqtt_last_payload?: string
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
// Topic registry — named "送り先" the sensor mapping can pick from (item 6)
// ---------------------------------------------------------------------

/**
 * Studio-side registry of MQTT topic names. A topic = one channel (a single
 * name, like one cable) — no friendly-label, no root/subtopic in the user's
 * model (user 2026-06-13). "default-topic" (the empty selection) always
 * exists; add a topic only when you want to split machines / groups.
 */
function TopicRegistryEditor() {
  const topics = useMqttTopicsStore((s) => s.topics)
  const addTopic = useMqttTopicsStore((s) => s.addTopic)
  const removeTopic = useMqttTopicsStore((s) => s.removeTopic)
  const [name, setName] = useState('')

  const add = () => {
    const t = sanitizeTopic(name)
    if (!t) return
    addTopic(t)
    setName('')
  }

  return (
    <div className="form-section">
      <div className="form-section-title">
        Topic
        <span className="form-section-sub-inline">
          {' '}— 送り先 topic の一覧（「センサー」タブで選択）
        </span>
      </div>

      <div className="topic-table">
        <div className="topic-table-head">
          <span>topic</span>
          <span />
        </div>
        {/* default-topic always exists (the empty selection); not removable. */}
        <div className="topic-table-row">
          <span className="topic-name mono">default-topic</span>
          <span className="topic-builtin">既定（何も設定しない時の送り先）</span>
        </div>
        {topics.map((t) => (
          <div className="topic-table-row" key={t}>
            <span className="topic-name mono">{t}</span>
            <button
              type="button"
              className="btn-x-muted"
              style={{ marginLeft: 'auto' }}
              onClick={() => removeTopic(t)}
              title="この topic を削除"
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      <div className="form-row" style={{ marginTop: 8, gap: 6 }}>
        <input
          className="form-input mono"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="topic 名 (例: ward-a)"
          maxLength={32}
          onKeyDown={(e) => { if (e.key === 'Enter') add() }}
          style={{ flex: 1 }}
        />
        <button
          className="form-button-secondary"
          onClick={add}
          disabled={!name.trim()}
          style={{ flexShrink: 0, padding: '4px 10px' }}
        >
          ＋
        </button>
      </div>

      <div className="form-status muted">
        topic = 送り先のチャンネル名です。受信側 Hapbeat は「MQTT」タブで同じ topic を設定したものだけが
        そのイベントを受け取ります。複数の機材やグループを分けたい時だけ追加してください
        （何も設定しなければ default-topic で全てやり取りされます）。
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------
// MQTT client settings (receiver(mqtt) / sensor) — the MQTT クライアント tab
// ---------------------------------------------------------------------

export function MqttConfigSection({
  device,
  cachedInfo,
  sendTo,
  role,
}: {
  device: DeviceInfo
  cachedInfo?: NodeConfigInfo
  sendTo: (msg: ManagerMessage) => void
  /** 'sensor' publishes; 'receiver' subscribes. Drives the topic list. */
  role: 'sensor' | 'receiver'
}) {
  const initialHost = cachedInfo?.broker_host ?? 'auto'
  const [auto, setAuto] = useState<boolean>(initialHost === 'auto')
  const [host, setHost] = useState<string>(initialHost === 'auto' ? '' : initialHost)
  const [port, setPort] = useState<number>(cachedInfo?.broker_port ?? 1883)
  const [root, setRoot] = useState<string>(cachedInfo?.topic_root ?? 'hapbeat')
  const [qos, setQos] = useState<number>(cachedInfo?.mqtt_qos ?? 1)
  const [status, setStatus] = useState<string | null>(null)

  useEffect(() => {
    const h = cachedInfo?.broker_host
    if (h != null) {
      if (h === 'auto') {
        setAuto(true)
        setHost('')
      } else {
        setAuto(false)
        setHost(h)
      }
    }
    if (cachedInfo?.broker_port != null) setPort(cachedInfo.broker_port)
    if (cachedInfo?.topic_root != null) setRoot(cachedInfo.topic_root)
    if (cachedInfo?.mqtt_qos != null) setQos(cachedInfo.mqtt_qos)
  }, [device.ipAddress, cachedInfo?.broker_host, cachedInfo?.broker_port, cachedInfo?.topic_root, cachedInfo?.mqtt_qos])

  const connected = cachedInfo?.mqtt_connected
  const rootClean = root.trim().replace(/\//g, '')
  const apply = () => {
    const value = auto ? 'auto' : host.trim()
    if (!auto && !value) return
    sendTo({
      type: 'set_broker_host',
      payload: { host: value, port, topic_root: rootClean || 'hapbeat', qos },
    })
    setStatus('適用しました — センサは即時再接続、Hapbeat (受信機) は再起動後に反映されます')
    setTimeout(() => setStatus(null), 5000)
  }

  return (
    <>
      {/* Shared page-level flow chart (same instance the broker tab shows). */}
      <MqttFlowPanel />
      <div className="form-section">
      <div
        className="form-section-title"
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
      >
        <span>
          MQTT クライアント設定
          <span className="form-section-sub-inline">
            {' '}— どのブローカー・topic に接続するか
          </span>
        </span>
        {/* This node's slice of the flow: connected to the broker or not. */}
        {connected != null && (
          <span className={`device-row-status ${connected ? 'online' : ''}`}
            style={connected ? undefined : { background: 'rgba(244,67,54,0.15)', color: '#f44336', border: '1px solid rgba(244,67,54,0.4)' }}
            title={connected ? 'ブローカーに接続中' : 'ブローカーに未接続 (検出中 / 設定確認)'}
          >
            <span style={{ textTransform: 'none' }}>{connected ? '● ブローカー接続中' : '○ 未接続'}</span>
          </span>
        )}
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
        ブローカー自動検出 (mDNS で同一 LAN 上の Hapbeat ブローカーを探す)
      </label>

      {!auto && (
        <>
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
          <div className="form-status muted">
            自動検出時はブローカーが mDNS で広告するポートを使うため、ポート指定は手動ホスト時のみ有効です。
          </div>
        </>
      )}

      <div className="form-row" style={{ marginTop: 6 }}>
        <label>topic</label>
        <input
          className="form-input mono"
          value={root}
          onChange={(e) => setRoot(e.target.value)}
          placeholder="default-topic"
          maxLength={32}
          disabled={!device.online}
          style={{ flex: '0 0 160px' }}
        />
        <span />
      </div>
      <div className="form-status muted">
        {role === 'sensor' ? 'このセンサーが送信する topic。' : 'このノードが購読する topic。'}
        送信側と受信側で同じ topic にそろえたものだけが届きます（空欄 = default-topic）。
      </div>

      <div className="form-row" style={{ marginTop: 6 }}>
        <label>QoS</label>
        <div className="form-row-multi" style={{ gap: 6 }}>
          {[1, 0].map((q) => (
            <button
              key={q}
              type="button"
              className={`form-button${qos === q ? '' : '-secondary'}`}
              onClick={() => setQos(q)}
              disabled={!device.online}
              title={q === 1
                ? 'at-least-once: ブローカーが PUBACK を返す。アラート用途の既定'
                : 'fire-and-forget: 再送なし。低遅延・低負荷'}
            >
              QoS {q}{q === 1 ? ' (確実)' : ' (高速)'}
            </button>
          ))}
        </div>
        <span />
      </div>
      <div className="form-status muted">
        既定は QoS 1。確実なアラート配信が重要な MQTT 用途向け。低遅延を優先したい / 取りこぼしを
        許容できる場合のみ QoS 0 に。
      </div>

      <div className="form-status muted">
        QoS は 1 (at-least-once) です。送信→ブローカーは PUBACK 確認付きで確実に届き、{role === 'sensor'
          ? '加えて「センサー」タブの再送間隔で色が続く間は再送し続けます (取りこぼしのバックストップ)。'
          : '送信側がアラート継続中は再送も併用するため、接続断があっても次で届きます。'}
      </div>

      <div className="form-action-row" style={{ marginTop: 8 }}>
        <button className="form-button" onClick={apply} disabled={!device.online}>
          適用
        </button>
        {status && <span className="form-status ok" style={{ alignSelf: 'center' }}>{status}</span>}
      </div>
    </div>
    {/* Topic registry — only on the sender (sensor) side; receivers just
        subscribe to their own root. (item 6) */}
    {role === 'sensor' && <TopicRegistryEditor />}
    </>
  )
}

// ---------------------------------------------------------------------
// Embedded broker panel (role = broker) — MQTT tab: flow chart + config
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

  // NOTE: broker telemetry polling moved to the page-level MqttFlowController
  // (mounted in Devices.tsx) so the flow chart is live on every device's MQTT
  // tab, not just the broker's. This panel no longer polls.

  const apply = () => {
    sendTo({ type: 'set_broker_config', payload: { static_octet: octet, port } })
  }

  return (
    <>
      {/* Shared page-level flow chart (same instance the sensor tabs show). */}
      <MqttFlowPanel />

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
            {cachedInfo.mqtt_clients != null && cachedInfo.mqtt_running && (
              <> · クライアント {cachedInfo.mqtt_clients.length} 台</>
            )}
          </div>
        )}

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
        <div className="form-status muted">
          MQTT の待ち受けポート (既定 1883)。変更は再起動後に反映され、mDNS で自動検出する
          クライアントには自動で伝わります。
        </div>

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
          IP アドレスの末尾番号を固定するための設定です (例: ゲートウェイが 192.168.1.1 で
          オクテット 10 → ブローカーは 192.168.1.10 を名乗る)。mDNS の自動検出が使えない
          ネットワークで、クライアントに固定 IP を手動設定したい場合の保険です。
          通常 (自動検出が機能する環境) は変更不要です。
        </div>

        <div className="form-action-row" style={{ marginTop: 8 }}>
          <button className="form-button" onClick={apply} disabled={!device.online}>
            適用
          </button>
        </div>

        <div className="form-status muted" style={{ marginTop: 6 }}>
          QoS 1 (at-least-once)・認証なし (隔離 LAN 内前提) です。topic は各クライアント側の
          「MQTT」タブで設定します (ブローカーは全 topic を中継するため設定不要)。
        </div>
      </div>
    </>
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

/**
 * Default 3-color thresholds — carried over from the proven deployment
 * (HospitalColorSensor apps/sender/include/adjustParams.h). Same value
 * space: clear-normalized chromaticity 0-255, so they port directly.
 * Used to prefill the editor when the device has no mappings yet; the
 * user still picks the event_id per row before saving.
 */
const DEFAULT_COLOR_MAPPINGS: SensorMapping[] = [
  { key: 'red',    match: { r_min: 140, r_max: 255, g_min: 0,  g_max: 70,  b_min: 0,   b_max: 70  }, event_id: '', target: '', gain: 1.0 },
  { key: 'blue',   match: { r_min: 30,  r_max: 70,  g_min: 0,  g_max: 90,  b_min: 120, b_max: 255 }, event_id: '', target: '', gain: 1.0 },
  { key: 'yellow', match: { r_min: 100, r_max: 159, g_min: 50, g_max: 100, b_min: 0,   b_max: 60  }, event_id: '', target: '', gain: 1.0 },
]

/** Capture tolerance default: 現在値を取り込む sets min/max = reading ± this.
 *  chromaticity は環境光・距離で ±10〜15 程度揺れるため、その揺れを包含しつつ
 *  隣の色と重なりにくい幅として 20 を既定にしている (UI で調整可)。 */
const DEFAULT_CAPTURE_TOLERANCE = 20

/** Does a reading fall inside a row's RGB threshold box? */
function readingMatches(m: SensorColorMatch, rd: SensorReading): boolean {
  if (m.r_min != null && rd.r < m.r_min) return false
  if (m.r_max != null && rd.r > m.r_max) return false
  if (m.g_min != null && rd.g < m.g_min) return false
  if (m.g_max != null && rd.g > m.g_max) return false
  if (m.b_min != null && rd.b < m.b_min) return false
  if (m.b_max != null && rd.b > m.b_max) return false
  return true
}

// Module + sensor-type label, used as the mapping card TITLE so the panel
// generalizes as more sensor types are added (user feedback 2026-06-13).
const SENSOR_TYPE_LABEL: Record<string, string> = {
  tcs34725: 'TCS34725（カラーセンサ）',
}

/** The card-level default topic = the topic shared by the most rows
 *  ('' = default-topic / the sensor's own root). Used to reconstruct the
 *  "card default + per-row override" model from the flat per-row `topic`
 *  the device stores. */
function inferCardTopic(ms: SensorMapping[]): string {
  const counts = new Map<string, number>()
  for (const m of ms) {
    const t = m.topic ?? ''
    counts.set(t, (counts.get(t) ?? 0) + 1)
  }
  let best = ''
  let bestN = -1
  for (const [t, n] of counts) {
    if (n > bestN) { best = t; bestN = n }
  }
  return best
}

export function SensorMappingSection({
  device,
  mappings,
  reading,
  sensorType,
  sendTo,
  onRefresh,
}: {
  device: DeviceInfo
  /** Loaded mappings from the device (get_sensor_mapping result). */
  mappings?: SensorMapping[]
  /** Latest live reading (polled while this tab is open). */
  reading?: SensorReading
  /** Sensor hardware type from get_info (e.g. "tcs34725"). */
  sensorType?: string
  sendTo: (msg: ManagerMessage) => void
  onRefresh: () => void
}) {
  const [rows, setRows] = useState<SensorMapping[]>(mappings ?? [])
  const [dirty, setDirty] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [tolerance, setTolerance] = useState<number>(DEFAULT_CAPTURE_TOLERANCE)
  // Accordion: which row indices are expanded for editing. Collapsed by
  // default so the list stays scannable (user feedback 2026-06-13).
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const toggleExpanded = (i: number) =>
    setExpanded((s) => {
      const next = new Set(s)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })

  // ── send-destination topic (item 6) ─────────────────────────────────
  // The whole sensor publishes to ONE card-level topic by default
  // ('' = "default-topic" = the sensor's own topic_root). A row can opt into
  // an individual topic via its checkbox (overrideRows); otherwise it follows
  // the card topic. The firmware only stores a flat per-row `topic`, so this
  // model is reconstructed on load (inferCardTopic) and flattened on save.
  const [cardTopic, setCardTopic] = useState<string>('')
  const [overrideRows, setOverrideRows] = useState<Set<number>>(new Set())

  // Change the card-level topic and pull every non-override row with it.
  const setCardTopicAndSync = (v: string) => {
    setCardTopic(v)
    setRows((rs) => rs.map((r, i) => (overrideRows.has(i) ? r : { ...r, topic: v || undefined })))
    setDirty(true)
  }
  // Toggle a row between "follow card default" and "individual topic".
  const toggleOverride = (i: number) =>
    setOverrideRows((s) => {
      const next = new Set(s)
      if (next.has(i)) {
        next.delete(i)
        setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, topic: cardTopic || undefined } : r)))
      } else {
        next.add(i)
      }
      setDirty(true)
      return next
    })

  // Editor state (rows / dirty / prefill) is per-device. Reset it when
  // the selected device changes so the previous device's edits don't
  // bleed into the next one.
  const deviceRef = useRef(device.ipAddress)
  const prefilledRef = useRef(false)
  useEffect(() => {
    if (deviceRef.current === device.ipAddress) return
    deviceRef.current = device.ipAddress
    setRows([])
    setDirty(false)
    setStatus(null)
    setCardTopic('')
    setOverrideRows(new Set())
    prefilledRef.current = false
  }, [device.ipAddress])

  // Sync from device-loaded mappings unless the user has local edits.
  // A factory-fresh device (loaded, zero rows) gets the proven 3-color
  // defaults prefilled — but ONLY ONCE per device. Without the once-guard,
  // saving (which sets dirty=false) would re-run this effect while the
  // device still reports zero mappings (the write round-trips through the
  // firmware asynchronously), clobbering the rows the user just saved with
  // the blank defaults again.
  useEffect(() => {
    if (dirty || !mappings) return
    if (mappings.length === 0) {
      if (prefilledRef.current) return
      prefilledRef.current = true
      setRows(DEFAULT_COLOR_MAPPINGS.map((m) => ({ ...m, match: { ...m.match } })))
      setCardTopic('')
      setOverrideRows(new Set())
      setDirty(true)
      setStatus('デフォルトの 3 色しきい値を入れました — イベントを割り当てて保存してください')
      return
    }
    setRows(mappings)
    // Reconstruct the card-default + per-row-override model from the flat
    // per-row topics the device returned.
    const ct = inferCardTopic(mappings)
    setCardTopic(ct)
    setOverrideRows(new Set(mappings.flatMap((m, i) => ((m.topic ?? '') !== ct ? [i] : []))))
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

  // Live reading poll (~1 Hz) while this tab is open and the device online.
  // sendTo identity changes per render — keep the latest in a ref so the
  // interval isn't torn down and re-created every second.
  const sendToRef = useRef(sendTo)
  sendToRef.current = sendTo
  useEffect(() => {
    if (!device.online) return
    const tick = () => sendToRef.current({ type: 'get_sensor_reading', payload: {} })
    tick()
    const id = window.setInterval(tick, 1000)
    return () => window.clearInterval(id)
  }, [device.ipAddress, device.online])

  // Fill a row's thresholds from the current live reading (± tolerance).
  const captureFromReading = (i: number) => {
    if (!reading) return
    const c = (v: number) => Math.max(0, Math.min(255, v))
    setRows((rs) =>
      rs.map((r, idx) => idx === i ? {
        ...r,
        match: {
          r_min: c(reading.r - tolerance), r_max: c(reading.r + tolerance),
          g_min: c(reading.g - tolerance), g_max: c(reading.g + tolerance),
          b_min: c(reading.b - tolerance), b_max: c(reading.b + tolerance),
        },
      } : r),
    )
    setDirty(true)
  }

  // Registered send-destinations (item 6) — per-color topic dropdown.
  const topics = useMqttTopicsStore((s) => s.topics)

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
    setRows((rs) => {
      setExpanded((s) => new Set(s).add(rs.length))  // open the new row
      // New colors follow the card-level topic by default.
      return [...rs, { ...emptyMapping(), topic: cardTopic || undefined }]
    })
    setDirty(true)
  }
  const removeRow = (i: number) => {
    setRows((rs) => rs.filter((_, idx) => idx !== i))
    setExpanded(new Set())  // indices shift on removal — simplest is collapse all
    // Shift override indices past the removed row down by one.
    setOverrideRows((s) => {
      const next = new Set<number>()
      for (const idx of s) {
        if (idx < i) next.add(idx)
        else if (idx > i) next.add(idx - 1)
      }
      return next
    })
    setDirty(true)
  }

  // Client-side live match: which editor row would fire for the current
  // reading (first match wins, mirroring the firmware). This updates
  // immediately as the user edits thresholds — unlike `reading.key`,
  // which reflects the mapping currently SAVED on the device and only
  // changes after 保存. Surfacing the editor-side key is why "red を検知
  // しても 一致なし のまま" happened: the device had no saved mapping yet.
  const liveEditorKey = useMemo(() => {
    if (!reading) return null
    for (const r of rows) {
      if (r.key.trim() && readingMatches(r.match, reading)) return r.key.trim()
    }
    return null
  }, [rows, reading])

  // Compact "R140-255 G0-70 B0-70" threshold summary for a collapsed row.
  const matchSummary = (m: SensorColorMatch): string => {
    const seg = (lo?: number, hi?: number) =>
      lo == null && hi == null ? '*' : `${lo ?? 0}-${hi ?? 255}`
    return `R${seg(m.r_min, m.r_max)} G${seg(m.g_min, m.g_max)} B${seg(m.b_min, m.b_max)}`
  }

  const save = () => {
    const clean = rows
      // Flatten card-default + override into the flat per-row topic the
      // firmware stores (compute by index BEFORE filtering shifts them).
      .map((r, i) => ({ ...r, topic: (overrideRows.has(i) ? r.topic : cardTopic) || undefined }))
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
          {sensorType ? (SENSOR_TYPE_LABEL[sensorType] ?? sensorType) : 'センサ'}
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

      {/* Live reading — tune thresholds while watching the actual value. */}
      <div className="sensor-live">
        <span
          className="sensor-live-swatch"
          style={reading ? { background: `rgb(${reading.r}, ${reading.g}, ${reading.b})` } : undefined}
          title="現在の検出色 (clear 正規化)"
        />
        {reading ? (
          <>
            <span className="sensor-live-val mono">R {reading.r}</span>
            <span className="sensor-live-val mono">G {reading.g}</span>
            <span className="sensor-live-val mono">B {reading.b}</span>
            {reading.clear != null && (
              <span className="sensor-live-clear">明るさ {reading.clear}</span>
            )}
            {/* Editor-side match (updates live as thresholds are edited). */}
            {liveEditorKey
              ? <span className="sensor-live-key match" title="編集中のしきい値に一致 (保存前でも判定)">▶ {liveEditorKey}</span>
              : <span className="sensor-live-key" title="編集中のどのしきい値にも一致していません">一致なし</span>}
            {/* Device-side match (what the SAVED mapping fires) — only show
                when it differs, so the user can tell edits aren't saved yet. */}
            {reading.key && reading.key !== liveEditorKey && (
              <span className="sensor-live-key" style={{ opacity: 0.7 }}
                title="デバイスに保存済みのマッピングによる判定 (保存後に反映)">
                保存済: {reading.key}
              </span>
            )}
            <span
              className="form-status muted"
              style={{ margin: 0, marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4 }}
              title="「現在値を取り込む」が min/max にセットする幅 (現在値 ± この値)"
            >
              取込幅 ±
              <input
                className="form-input short"
                type="number"
                min={1}
                max={100}
                value={tolerance}
                onChange={(e) => setTolerance(Math.max(1, Math.min(100, Number(e.target.value) || DEFAULT_CAPTURE_TOLERANCE)))}
                style={{ width: 52 }}
              />
            </span>
          </>
        ) : (
          <span className="form-status muted" style={{ margin: 0 }}>
            {device.online
              ? 'センサ値を取得中… (1 秒ごとに更新。表示されない場合: センサ未接続 / 真っ暗 / ファームが古い)'
              : 'デバイスがオフラインです'}
          </span>
        )}
      </div>

      {/* Card-level send topic — the whole sensor publishes here by default.
          Colors can opt into an individual topic in their row (item 6). */}
      <div className="form-row" style={{ marginTop: 8 }}>
        <label>送信 topic</label>
        <select
          className="form-input"
          value={cardTopic}
          onChange={(e) => setCardTopicAndSync(e.target.value)}
          disabled={!device.online}
          style={{ flex: '0 0 260px' }}
        >
          <option value="">default-topic（既定）</option>
          {topics.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
          {cardTopic && !topics.includes(cardTopic) && (
            <option value={cardTopic}>{cardTopic}（未登録）</option>
          )}
        </select>
        <span />
      </div>
      <div className="form-status muted">
        このセンサ全体の送り先です。送り先は「MQTT」タブで登録できます。色ごとに変えたい場合は、各色を開いて
        「個別の Topic に送信する」をチェックしてください（チェックしない色はこの設定に追従します）。
      </div>

      <datalist id="sensor-mapping-event-ids">
        {eventIdOptions.map((id) => <option key={id} value={id} />)}
      </datalist>

      {rows.length === 0 && (
        <div className="form-status muted">
          マッピング未設定です。「＋ 検知色を追加」で割り当てを作成してください。
        </div>
      )}

      {rows.map((r, i) => {
        const isLive = !!reading && readingMatches(r.match, reading)
        const isOpen = expanded.has(i)
        return (
        <div
          key={i}
          className="form-section"
          style={{
            padding: isOpen ? 10 : 0,
            marginTop: 8,
            border: `1px solid ${isLive ? 'var(--accent)' : 'var(--border)'}`,
            borderRadius: 4,
            ...(isLive ? { boxShadow: 'inset 0 0 0 1px var(--accent)' } : {}),
          }}
        >
          {/* Collapsed header — always visible, click to expand/collapse. */}
          <div
            onClick={() => toggleExpanded(i)}
            style={{
              display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer',
              padding: isOpen ? '0 0 6px' : '8px 10px',
              borderBottom: isOpen ? '1px solid var(--border)' : 'none',
            }}
            title={isOpen ? '折りたたむ' : '展開して編集'}
          >
            <span style={{ color: 'var(--text-muted)', fontSize: 11, width: 12 }}>
              {isOpen ? '▼' : '▶'}
            </span>
            {isLive && (
              <span style={{ color: 'var(--accent)', fontSize: 11 }} title="現在の検出値に一致中">●</span>
            )}
            <span className="mono" style={{ fontWeight: 600, minWidth: 70 }}>
              {r.key || '(キー未設定)'}
            </span>
            <span className="mono" style={{ color: 'var(--text-muted)', fontSize: 12, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {r.event_id || '(イベント未割当)'}
            </span>
            {!isOpen && (
              <span className="mono" style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                {matchSummary(r.match)}
              </span>
            )}
            {/* Delete is on the (always-visible) header row so a color can
                be removed without expanding it first (user feedback
                2026-06-13). stopPropagation so it doesn't toggle expand. */}
            <button
              type="button"
              className="btn-x-muted"
              onClick={(e) => { e.stopPropagation(); removeRow(i) }}
              disabled={!device.online}
              title="この検知色を削除"
              style={{ flexShrink: 0, marginLeft: 'auto' }}
            >
              ✕
            </button>
          </div>

          {isOpen && (
          <>
          <div className="form-row" style={{ marginTop: 8 }}>
            <label>キー</label>
            <input
              className="form-input"
              value={r.key}
              onChange={(e) => update(i, { key: e.target.value })}
              placeholder="例: red"
              disabled={!device.online}
              style={{ flex: '0 0 120px' }}
            />
            <span />
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
              <button
                className="form-button-secondary"
                onClick={() => captureFromReading(i)}
                disabled={!device.online || !reading}
                title={`現在の検出値 ±${tolerance} をしきい値にセット`}
                style={{ fontSize: 12, padding: '3px 8px' }}
              >
                現在値を取り込む
              </button>
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

          {/* Send-destination topic (item 6). By default the color follows the
              card-level 送信トピック; tick "個別の Topic に送信する" to send this
              one color somewhere else. */}
          <div className="form-row">
            <label>送り先</label>
            <div className="form-row-multi" style={{ alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <label
                className="form-status muted"
                style={{ margin: 0, display: 'inline-flex', alignItems: 'center', gap: 6 }}
              >
                <input
                  type="checkbox"
                  checked={overrideRows.has(i)}
                  onChange={() => toggleOverride(i)}
                  disabled={!device.online}
                />
                個別の Topic に送信する
              </label>
              {overrideRows.has(i) ? (
                <select
                  className="form-input"
                  value={r.topic ?? ''}
                  onChange={(e) => update(i, { topic: e.target.value || undefined })}
                  disabled={!device.online}
                  style={{ flex: '0 0 220px' }}
                >
                  <option value="">default-topic（既定）</option>
                  {topics.map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                  {r.topic && !topics.includes(r.topic) && (
                    <option value={r.topic}>{r.topic}（未登録）</option>
                  )}
                </select>
              ) : (
                <span className="form-status muted" style={{ margin: 0 }}>
                  カード全体（{cardTopic || 'default-topic'}）に追従
                </span>
              )}
            </div>
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

          <div className="form-row">
            <label>再送間隔</label>
            <div className="form-row-multi" style={{ alignItems: 'center', gap: 6 }}>
              <input
                className="form-input short"
                type="number"
                min={200}
                max={60000}
                step={500}
                value={r.debounce_ms ?? 4000}
                onChange={(e) => update(i, { debounce_ms: Math.max(200, Math.min(60000, Number(e.target.value) || 4000)) })}
                disabled={!device.online}
                style={{ width: 80 }}
              />
              <span className="form-status muted" style={{ margin: 0 }}>ms</span>
            </div>
            <span />
          </div>
          <div className="form-status muted">
            この色が続いている間、この間隔で同じイベントを再送します。MQTT は QoS 1 で送信→
            ブローカーは確実に届きますが、接続断などの取りこぼしに対するバックストップとして
            アプリ層でも再送します (アラート用途では短め、既定 4000ms)。
          </div>
          </>
          )}
        </div>
        )
      })}

      <div className="form-action-row" style={{ marginTop: 10 }}>
        <button className="form-button-secondary" onClick={addRow} disabled={!device.online}>
          ＋ 検知色を追加
        </button>
        <button className="form-button" onClick={save} disabled={!device.online || !dirty}>
          保存
        </button>
        {status && <span className="form-status ok" style={{ alignSelf: 'center' }}>{status}</span>}
      </div>
    </div>
  )
}
