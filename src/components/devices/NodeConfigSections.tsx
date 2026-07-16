import { useEffect, useMemo, useRef, useState } from 'react'
import type { DeviceInfo, EqBandReadout, ManagerMessage, MqttClientEntry, SensorColorMatch, SensorMapping, SensorReading } from '@/types/manager'
import { useLibraryStore } from '@/stores/libraryStore'
import { useMqttTopicsStore, sanitizeTopic } from '@/stores/mqttTopicsStore'
import { useToast } from '@/components/common/Toast'
import { downloadTextFile } from '@/utils/download'
import { clampOpusComplexity, clampHpBufferMs } from '@/utils/solidTransmitterTuning'
import {
  computeAic3204Eq,
  aic3204CoeffsToArray,
  type EqFtype,
} from '@/utils/aic3204Eq'
import { MqttFlowPanel } from './MqttFlow'

// Status feedback uses anchored toasts (Toast.tsx) instead of inline text, so
// showing a message never shifts the surrounding buttons (user 2026-06-15).
// Each apply handler sets the toast anchor to its button on click, then toasts.

/**
 * Per-node-role config panels (DEC-034). Each speaks the common
 * serial/TCP JSON config protocol (contracts: serial-config.md §4b)
 * through the transport-agnostic `sendTo`, so they work identically
 * over Helper-relayed TCP (LAN) and Web Serial (USB).
 */

/** Subset of the get_info cache these panels read. */
export interface NodeConfigInfo {
  /** Hardware board id (e.g. band_wl_v3, duo_wl_v4). Gates board-specific panels. */
  board?: string
  /** OLED brightness (1=low / 2=mid / 3=high). Firmware ≥ v0.1.x. */
  oled_brightness?: number
  espnow_channel?: number
  gain?: number
  input_level?: number
  /**
   * SOLID48 (mode 9, Opus 48k stereo HP) TX-local Opus encoder complexity
   * override (DEC-046 follow-up, transmitter only). -1/undefined = unset
   * (the per-mode MODE_DEFS default is used); 0..10 = explicit override.
   */
  opus_complexity?: number
  /**
   * SOLID48 (mode 9) receiver HP jitter-buffer target, ms (DEC-046
   * follow-up, transmitter only). The TX stores this and broadcasts it to
   * the fleet as 0xAC fleet-tune param 6; only mode-9 receivers apply it.
   */
  stream_hp_buffer_ms?: number
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
  /** Alert-loop mode (MQTT receiver, item 10). */
  alert_loop?: boolean
  /** Restricted mode (MQTT receiver, §6.3): true = critical-only. Read-only;
   *  toggled on-device via the limit_toggle button action. */
  alert_limit?: boolean
  /** Deliberate-hold ack duration (MQTT receiver, §6.1), ms. */
  ack_hold_ms?: number
  /** MQTT receiver subscribe topic roots (item 8). */
  recv_topics?: string[]
  /** ESP-NOW display/power policy (espnow_stream receiver, §4.19). */
  espnow_ui?: {
    auto_off_ms?: number
    wake_on_button?: boolean
    wake_on_volume?: boolean
    led_enabled?: boolean
    low_batt_pct?: number
  }
  /** ESP-NOW audio-stream statistics (espnow_stream receiver, §4.19 get_info stream). */
  stream?: {
    received?: number
    lost?: number
    recovered?: number
    dropped?: number
    max_gap?: number
    handoffs?: number
    sources?: number
    locked?: boolean
    locked_mac?: string
    delay_ms?: number
  }
  /** DuoWL v4 audio stage settings (DEC-041, board === "duo_wl_v4" only). */
  audio?: {
    pam_db?: number
    lineout_db?: number
    boost_db?: number
    hp_db?: number
    /** Input/output routing (DEC-041 follow-up, DuoWL v4 only):
     *  "output" = normal headphone playback / "line_in" = jack audio-in → haptics. */
    input_mode?: 'output' | 'line_in'
  }
  /** DuoWL v4 ESP-NOW hp48 receiver EQ state (audio-dsp-config.md §2,
   *  board === "duo_wl_v4" only). fc/Q/gain aren't recoverable from the
   *  committed ints — only ftype + raw coeffs are reported. */
  eq?: {
    haptic: EqBandReadout[]
    hp: EqBandReadout[]
  }
  /** A-V delay, ms (audio-dsp-config.md §3, DuoWL v4 ESP-NOW hp48 receiver
   *  only): extra target added to the HP (48k) ring only, delaying audio
   *  vs. haptic. 0..30. */
  av_delay_ms?: number
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
// SOLID48 (mode 9, Opus 48k stereo HP) transmitter tuning — Opus encoder
// complexity (TX-local, re-configures the live encoder immediately) + HP
// jitter-buffer target (fleet-broadcast as 0xAC param 6; only mode-9
// receivers apply it). DEC-046 follow-up. Shown alongside
// EspNowConfigSection for role === 'transmitter' — Studio doesn't know
// which stream mode is currently active on the TX (that's picked on the
// CoreS3 touch UI), so these are always offered when talking to a
// transmitter; they're no-ops for receivers on other modes.
// ---------------------------------------------------------------------

export function SolidTransmitterTuningSection({
  device,
  cachedInfo,
  sendTo,
}: {
  device: DeviceInfo
  cachedInfo?: NodeConfigInfo
  sendTo: (msg: ManagerMessage) => void
}) {
  const isAuto = cachedInfo?.opus_complexity == null || cachedInfo.opus_complexity < 0
  const [complexity, setComplexity] = useState<number>(
    !isAuto ? clampOpusComplexity(cachedInfo!.opus_complexity!) : 5,
  )
  const [hpBufferMs, setHpBufferMs] = useState<number>(
    clampHpBufferMs(cachedInfo?.stream_hp_buffer_ms ?? 120),
  )

  useEffect(() => {
    if (cachedInfo?.opus_complexity != null && cachedInfo.opus_complexity >= 0) {
      setComplexity(clampOpusComplexity(cachedInfo.opus_complexity))
    }
    if (cachedInfo?.stream_hp_buffer_ms != null) {
      setHpBufferMs(clampHpBufferMs(cachedInfo.stream_hp_buffer_ms))
    }
  }, [device.ipAddress, cachedInfo?.opus_complexity, cachedInfo?.stream_hp_buffer_ms])

  const { setAnchor } = useToast()
  const offline = !device.online

  const applyComplexity = (e: React.MouseEvent<HTMLElement>) => {
    setAnchor(e.currentTarget)
    const v = clampOpusComplexity(complexity)
    setComplexity(v)
    sendTo({ type: 'set_opus_complexity', payload: { value: v } })
  }
  const applyHpBuffer = (e: React.MouseEvent<HTMLElement>) => {
    setAnchor(e.currentTarget)
    const ms = clampHpBufferMs(hpBufferMs)
    setHpBufferMs(ms)
    sendTo({ type: 'set_stream_hp_buffer', payload: { value: ms } })
  }

  return (
    <div className="form-section">
      <div className="form-section-title">
        SOLID48 送信チューニング
        <span className="form-section-sub-inline"> — Opus 48k stereo HP（mode 9）向け</span>
      </div>

      {/* 1. Opus encoder complexity — TX-local global override, applied to
          the live encoder immediately (no reboot). */}
      <div className="form-row">
        <label>Opus complexity</label>
        <div className="form-row-multi" style={{ alignItems: 'center', gap: 8 }}>
          <input
            type="range"
            min={0}
            max={10}
            step={1}
            value={complexity}
            onChange={(e) => setComplexity(clampOpusComplexity(Number(e.target.value)))}
            disabled={offline}
            style={{ flex: 1 }}
          />
          <span className="mono" style={{ width: 40, textAlign: 'right' }}>
            {complexity}
          </span>
        </div>
        <span />
      </div>
      {/* min-height reserved so this hint is always present — never shifts
          the action row below when the auto/override state changes
          (layout-shift rule). */}
      <div className="form-status muted" style={{ minHeight: 18, fontSize: 12 }}>
        {isAuto
          ? '現在: 自動（モード既定の complexity を使用中）。適用すると、現在アクティブなモードのエンコーダにこの値を上書きします。'
          : `現在: ${cachedInfo!.opus_complexity} で上書き中。0=軽い（低 CPU）〜10=高品質（高 CPU、既定 5 目安）。`}
      </div>
      <div className="form-action-row" style={{ marginTop: 8 }}>
        <button className="form-button" onClick={applyComplexity} disabled={offline}>
          Complexity を適用
        </button>
      </div>

      {/* 2. HP jitter-buffer target — TX stores + broadcasts to the fleet
          as 0xAC param 6; only mode-9 (SOLID48) receivers apply it. */}
      <div className="form-row" style={{ marginTop: 12 }}>
        <label>HP ジッターバッファ</label>
        <div className="form-row-multi" style={{ alignItems: 'center', gap: 8 }}>
          <input
            type="range"
            min={40}
            max={500}
            step={10}
            value={hpBufferMs}
            onChange={(e) => setHpBufferMs(clampHpBufferMs(Number(e.target.value)))}
            disabled={offline}
            style={{ flex: 1 }}
          />
          <span className="mono" style={{ width: 56, textAlign: 'right' }}>
            {hpBufferMs} ms
          </span>
        </div>
        <span />
      </div>
      <div className="form-status muted" style={{ fontSize: 12 }}>
        SOLID48 受信機（mode 9）の再生バッファ深さ目標を編隊全体へ配信します（既定 120ms）。
        大きいほど ESP-NOW のゆらぎに強くなりますが、その分再生が遅れます。他モードの受信機には影響しません。
      </div>
      <div className="form-action-row" style={{ marginTop: 8 }}>
        <button className="form-button" onClick={applyHpBuffer} disabled={offline}>
          バッファを適用
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
  const exportTopics = useMqttTopicsStore((s) => s.exportTopics)
  const importTopics = useMqttTopicsStore((s) => s.importTopics)
  const { toast } = useToast()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [name, setName] = useState('')

  const add = () => {
    const t = sanitizeTopic(name)
    if (!t) return
    addTopic(t)
    setName('')
  }

  // Topics live only in localStorage (per-origin), so a host move (e.g.
  // studio.hapbeat.com) would lose them. Export/import lets the user carry the
  // list across origins; import merges into the existing list (never replaces).
  const doExport = () => {
    downloadTextFile('mqtt-topics.json', exportTopics())
    toast(`トピック ${topics.length} 件をエクスポートしました`, 'success')
  }
  const doImport = (file: File) => {
    const fr = new FileReader()
    fr.onload = () => {
      const ok = importTopics(String(fr.result))
      toast(
        ok ? 'トピック一覧をインポートしました' : 'インポートに失敗しました（JSON 形式を確認してください）',
        ok ? 'success' : 'error',
      )
    }
    fr.onerror = () => toast('ファイルの読み込みに失敗しました', 'error')
    fr.readAsText(file)
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

      {/* NOT .form-row — that's a 90px|1fr|auto grid, which forced the input
          into the narrow label column. A plain flex row lets the input take
          the width. */}
      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        <input
          className="form-input mono"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="topic 名 (例: ward-a)"
          maxLength={32}
          onKeyDown={(e) => { if (e.key === 'Enter') add() }}
          style={{ flex: 1, minWidth: 0 }}
        />
        <button
          className="form-button-secondary"
          onClick={add}
          disabled={!name.trim()}
          style={{ flexShrink: 0, padding: '0 16px' }}
        >
          ＋
        </button>
      </div>

      {/* Origin-independent backup of the topic list (localStorage は origin
          ごとに隔離されるため、host 移行時に手動退避できる経路を用意する)。 */}
      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        <button
          type="button"
          className="form-button-secondary"
          onClick={doExport}
          disabled={topics.length === 0}
          style={{ padding: '0 12px' }}
          title="登録トピックを JSON ファイルに保存（別アドレスへの移行用バックアップ）"
        >
          エクスポート
        </button>
        <button
          type="button"
          className="form-button-secondary"
          onClick={() => fileInputRef.current?.click()}
          style={{ padding: '0 12px' }}
          title="JSON ファイルからトピックを取り込み（既存の一覧に追加）"
        >
          インポート
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) doImport(f)
            e.target.value = ''
          }}
        />
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
  const [qos, setQos] = useState<number>(cachedInfo?.mqtt_qos ?? 1)
  // Feedback is shown as a toast anchored to the clicked button (never shifts
  // the surrounding rows). 書込み結果のトーストは HelperToastBridge が
  // write_result（実機の結果）ベースで出す。ここでは押下時に anchor だけ
  // 設定し、結果トーストがそのボタン近傍に出るようにする（操作ではなく結果で出す）。
  const { setAnchor } = useToast()
  // Alert-loop mode (receiver, item 10): default ON (loop until any button).
  const [alertLoop, setAlertLoop] = useState<boolean>(cachedInfo?.alert_loop ?? true)
  // Deliberate-hold time to acknowledge/stop an alert (receiver, §6.1).
  const [ackHoldMs, setAckHoldMs] = useState<number>(cachedInfo?.ack_hold_ms ?? 1000)
  // Receive topics (receiver, item 8): the topic roots this node subscribes to.
  // Picked from the registered topic list (mqttTopicsStore) + manual entry.
  // Empty = the default channel only.
  const registeredTopics = useMqttTopicsStore((s) => s.topics)
  const [recvTopics, setRecvTopics] = useState<string[]>(cachedInfo?.recv_topics ?? [])
  const [recvManual, setRecvManual] = useState('')

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
    if (cachedInfo?.mqtt_qos != null) setQos(cachedInfo.mqtt_qos)
    if (cachedInfo?.alert_loop != null) setAlertLoop(cachedInfo.alert_loop)
    if (cachedInfo?.ack_hold_ms != null) setAckHoldMs(cachedInfo.ack_hold_ms)
    if (cachedInfo?.recv_topics != null) setRecvTopics(cachedInfo.recv_topics)
  }, [device.ipAddress, cachedInfo?.broker_host, cachedInfo?.broker_port, cachedInfo?.mqtt_qos, cachedInfo?.alert_loop, cachedInfo?.ack_hold_ms, cachedInfo?.recv_topics])

  const connected = cachedInfo?.mqtt_connected
  // Settings that only take effect after a reboot (receiver broker re-subscribe
  // / topic list) are auto-rebooted from Studio so the user doesn't have to do
  // it manually (user 2026-06-15). Small delay lets the set_* command land
  // first. Sensors apply broker settings live, so they are NOT rebooted.
  const rebootAfter = (ms = 700) => {
    window.setTimeout(() => sendTo({ type: 'reboot', payload: {} }), ms)
  }
  // ブローカー設定だけを適用（topic は別グループ）。topic_root は default-topic
  // に固定（broker 接続に topic は不要）。
  const applyBroker = (e: React.MouseEvent<HTMLElement>) => {
    const value = auto ? 'auto' : host.trim()
    if (!auto && !value) return
    setAnchor(e.currentTarget)
    sendTo({
      type: 'set_broker_host',
      payload: { host: value, port, topic_root: 'default-topic', qos },
    })
    // receiver は購読再開に再起動が要るので適用後に自動リブート。
    if (role === 'receiver') rebootAfter()
  }
  // 受信 topic（receiver）だけを適用（item 8）。購読の張り直しに再起動が要るので
  // 適用後に自動で再起動する。
  const applyRecvTopics = (e: React.MouseEvent<HTMLElement>) => {
    setAnchor(e.currentTarget)
    sendTo({ type: 'set_recv_topics', payload: { topics: recvTopics } })
    rebootAfter()
  }

  // Alert-loop toggle (receiver, item 10) — persisted immediately and applied
  // on the next incoming alert (firmware reads the flag fresh; no reboot).
  const applyAlertLoop = (e: React.MouseEvent<HTMLElement>, next: boolean) => {
    setAnchor(e.currentTarget)
    setAlertLoop(next)
    sendTo({ type: 'set_alert_mode', payload: { loop: next } })
  }

  // Deliberate-hold acknowledge time (receiver, §6.1). Persisted in NVS on the
  // device and applied immediately (no reboot — read fresh per press).
  const applyAckHold = (e: React.MouseEvent<HTMLElement>) => {
    setAnchor(e.currentTarget)
    const ms = Math.max(200, Math.min(10000, Math.round(ackHoldMs)))
    setAckHoldMs(ms)
    sendTo({ type: 'set_alert_mode', payload: { ack_hold_ms: ms } })
  }

  // Gray out the host/port inputs while auto-detect is on, so it's obvious they
  // aren't editable (user 2026-06-14: the port looked white/editable).
  const disabledInputStyle = auto
    ? { opacity: 0.45, background: 'rgba(127,127,127,0.12)', cursor: 'not-allowed' as const }
    : undefined

  return (
    <>
      {/* Shared page-level flow chart (same instance the broker tab shows). */}
      <MqttFlowPanel />

      {/* ── Group 1: ブローカー設定 — 検出方法 + QoS のみ ── */}
      <div className="form-section">
        <div
          className="form-section-title"
          style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
        >
          <span>
            ブローカー設定
            <span className="form-section-sub-inline">{' '}— どのブローカーに接続するか</span>
          </span>
          {connected != null && (
            <span className={`device-row-status ${connected ? 'online' : ''}`}
              style={connected ? undefined : { background: 'rgba(244,67,54,0.15)', color: '#f44336', border: '1px solid rgba(244,67,54,0.4)' }}
              title={connected ? 'ブローカーに接続中' : 'ブローカーに未接続 (検出中 / 設定確認)'}
            >
              <span style={{ textTransform: 'none' }}>{connected ? '● ブローカー接続中' : '○ 未接続'}</span>
            </span>
          )}
        </div>

        <label className="form-status muted" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} disabled={!device.online} />
          ブローカー自動検出 (mDNS で同一 LAN 上の Hapbeat ブローカーを探す)
        </label>

        <div className="form-row" style={{ marginTop: 6 }}>
          <label>ホスト/IP</label>
          <input
            className="form-input mono"
            value={auto ? '' : host}
            onChange={(e) => setHost(e.target.value)}
            placeholder={auto ? '自動検出 (mDNS)' : '192.168.1.10 または hapbeat-broker.local'}
            disabled={!device.online || auto}
            style={disabledInputStyle}
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
            disabled={!device.online || auto}
            style={disabledInputStyle}
          />
          <span />
        </div>
        <div className="form-status muted">
          自動検出 ON の間はホスト/ポートは灰色（変更不可）— mDNS で広告された値を使います。
          OFF にすると直接指定できます。
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
          既定は QoS 1（at-least-once: ブローカーが PUBACK で確実に受領）。低遅延優先 / 取りこぼし許容
          の場合のみ QoS 0。
        </div>

        <div className="form-action-row" style={{ marginTop: 8 }}>
          <button className="form-button" onClick={applyBroker} disabled={!device.online}>適用</button>
        </div>
      </div>

      {/* ── Group 2: TOPIC — receiver の購読 topic (item 8) ── */}
      {role === 'receiver' && (() => {
        const opts = Array.from(new Set(['default-topic', ...registeredTopics, ...recvTopics]))
        const toggle = (t: string) =>
          setRecvTopics((s) => (s.includes(t) ? s.filter((x) => x !== t) : [...s, t]))
        const addManual = () => {
          const t = sanitizeTopic(recvManual)
          if (t && !recvTopics.includes(t)) setRecvTopics((s) => [...s, t])
          setRecvManual('')
        }
        return (
          <div className="form-section">
            <div className="form-section-title">
              TOPIC
              <span className="form-section-sub-inline">{' '}— この受信機が購読する topic</span>
            </div>
            <div className="form-row" style={{ marginTop: 6, alignItems: 'flex-start' }}>
              <label>受信 topic</label>
              <div className="form-row-multi" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 4 }}>
                {opts.map((t) => (
                  <label key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <input
                      type="checkbox"
                      checked={recvTopics.includes(t)}
                      onChange={() => toggle(t)}
                      disabled={!device.online}
                    />
                    <span className="mono">{t}</span>
                    {t === 'default-topic' && <span className="form-status muted" style={{ margin: 0 }}>（既定）</span>}
                    {!registeredTopics.includes(t) && t !== 'default-topic' && (
                      <span className="form-status muted" style={{ margin: 0 }}>（手動）</span>
                    )}
                  </label>
                ))}
                <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                  <input
                    className="form-input mono"
                    value={recvManual}
                    onChange={(e) => setRecvManual(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') addManual() }}
                    placeholder="手動で topic を追加"
                    maxLength={32}
                    disabled={!device.online}
                    style={{ flex: 1, minWidth: 0 }}
                  />
                  <button
                    className="form-button-secondary"
                    onClick={addManual}
                    disabled={!device.online || !recvManual.trim()}
                    style={{ flexShrink: 0, padding: '0 16px' }}
                  >
                    ＋
                  </button>
                </div>
              </div>
              <span />
            </div>
            <div className="form-status muted">
              この受信機が購読する topic。センサー側で送信している topic と一致させたものだけが届きます（複数選択可）。
              何もチェックしなければ default-topic のみ受信。チェック状態はデバイスの現在の購読設定を反映します。
            </div>
            <div className="form-action-row" style={{ marginTop: 8 }}>
              <button className="form-button" onClick={applyRecvTopics} disabled={!device.online}>適用</button>
            </div>
          </div>
        )
      })()}

      {/* ── Group 3: アラート動作 — receiver (item 10、即時反映) ── */}
      {role === 'receiver' && (
        <div className="form-section">
          <div className="form-section-title">
            アラート動作
            <span className="form-section-sub-inline">{' '}— 受信時の振動の挙動</span>
          </div>
          <div className="form-row" style={{ marginTop: 6 }}>
            <label>動作</label>
            <div className="form-row-multi" style={{ gap: 6 }}>
              <button
                type="button"
                className={`form-button${alertLoop ? '' : '-secondary'}`}
                onClick={(e) => applyAlertLoop(e, true)}
                disabled={!device.online}
                title="アラートを受信したら、本体ボタンを長押しするまで振動を繰り返す"
              >
                ループ (ボタンで停止)
              </button>
              <button
                type="button"
                className={`form-button${!alertLoop ? '' : '-secondary'}`}
                onClick={(e) => applyAlertLoop(e, false)}
                disabled={!device.online}
                title="アラートを受信したら 1 回だけ振動する"
              >
                単発
              </button>
            </div>
            <span />
          </div>
          <div className="form-status muted">
            「ループ」: アラート振動を、本体ボタンの長押しで止めるまで繰り返します
            (病院アラートのように「気づいて止める」運用)。「単発」: 1 回だけ振動。
            既定はループ。変更は次のアラートから即時反映されます。
          </div>

          {/* 停止の長押し時間 (§6.1) — 誤操作防止のため一度離して長押しで停止。
              既定 1000ms。即時反映 (受信ごとに参照)。 */}
          <div className="form-row" style={{ marginTop: 10 }}>
            <label>停止の長押し</label>
            <div className="form-row-multi" style={{ gap: 6 }}>
              <input
                className="form-input short"
                type="number"
                min={200}
                max={10000}
                step={100}
                value={ackHoldMs}
                onChange={(e) => setAckHoldMs(Number(e.target.value) || 1000)}
                disabled={!device.online}
              />
              <span className="form-status muted" style={{ margin: 0 }}>ms</span>
              <button className="form-button-secondary" onClick={applyAckHold} disabled={!device.online}>
                適用
              </button>
            </div>
            <span />
          </div>
          <div className="form-status muted">
            アラートを止めるには、ボタンを一度離してからこの時間だけ長押しします（誤操作・押しっぱなし対策）。既定 1000 ms。
          </div>

          {/* 制限モード (§6.3) — read-only。本体ボタンの limit_toggle アクション
              でのみ切替 (シリアル set コマンドなし) なので現在値の表示に留める。
              値は通常サイズ・明色で表示し、補足説明 (.muted) と区別する。 */}
          {cachedInfo?.alert_limit != null && (
            <div className="form-row" style={{ marginTop: 10 }}>
              <label>受信制限</label>
              <span
                style={{
                  fontSize: 15,
                  fontWeight: 600,
                  textTransform: 'none',
                  color: cachedInfo.alert_limit ? 'var(--warning)' : 'var(--text-primary)',
                }}
              >
                {cachedInfo.alert_limit ? '制限モード（重要な色のみ再生）' : '全て再生'}
              </span>
              <span />
            </div>
          )}
          {cachedInfo?.alert_limit != null && (
            <div className="form-status muted">
              受信機本体に <code>limit_toggle</code> を割り当てたボタンで切替えます（UI からは変更不可・現在値の表示のみ）。
              「制限モード」では「重要」フラグの付いた色だけを再生します。
            </div>
          )}
        </div>
      )}

      {/* Topic registry — only on the sender (sensor) side. (item 6) */}
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
              <> · クライアント {cachedInfo.mqtt_clients.length} 台
                {cachedInfo.mqtt_clients.length > 0 && (
                  <>（{cachedInfo.mqtt_clients.map((c) => c.name || c.id).join(', ')}）</>
                )}
              </>
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
          topic と QoS は各クライアント側で設定します（センサーの送信 topic / 受信機の受信 topic・QoS）。
          ブローカーは全 topic をそのまま中継するため、ここでの設定は不要です。
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

/** Migrate the device's flat topic fields to the editor's override model: an
 *  override row (has topics[] OR a single topic ≠ card default) always carries
 *  `topics[]` — a legacy single `topic` is seeded into [topic] so the per-row
 *  multi-select shows it checked and save() doesn't silently drop it. Follow
 *  rows (topic === card default, no topics) are left untouched. */
function normalizeRowTopics(ms: SensorMapping[], ct: string): SensorMapping[] {
  return ms.map((m) => {
    const hasTopics = !!(m.topics && m.topics.length)
    const isOverride = hasTopics || (m.topic ?? '') !== ct
    if (isOverride && !hasTopics && m.topic) {
      return { ...m, topics: [m.topic], topic: undefined }
    }
    return m
  })
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
  // Loading/error state for the initial get_sensor_mapping (the device takes a
  // few seconds to answer over TCP). `mappings === undefined` = not loaded yet;
  // a defined value (incl. []) = loaded. The mapping is CONFIG, so it shows as
  // soon as it arrives — independent of the live sensor reading (user 2026-06-15).
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState(false)
  // Feedback as anchored toasts (Toast.tsx) — never shifts the button row.
  const { toast, setAnchor } = useToast()
  const setStatus = (msg: string | null, type: 'success' | 'error' | 'info' | 'warning' = 'success') => {
    if (msg) toast(msg, type)
  }
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
        // Back to following the card default — clear the per-row override(s).
        setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, topic: undefined, topics: undefined } : r)))
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
  // The mappings prop reference last applied to the editor. Used so a `dirty`
  // toggle (e.g. save() flipping it false) does NOT re-run the sync below and
  // revert the editor to the stale prop — the user must see exactly what they
  // saved (user 2026-06-13). Only a genuinely NEW prop (reload) re-syncs.
  const syncedMappingsRef = useRef<SensorMapping[] | undefined>(undefined)
  useEffect(() => {
    if (deviceRef.current === device.ipAddress) return
    deviceRef.current = device.ipAddress
    setRows([])
    setDirty(false)
    setStatus(null)
    setCardTopic('')
    setOverrideRows(new Set())
    prefilledRef.current = false
    syncedMappingsRef.current = undefined
  }, [device.ipAddress])

  // Sync from device-loaded mappings unless the user has local edits.
  // A factory-fresh device (loaded, zero rows) gets the proven 3-color
  // defaults prefilled — but ONLY ONCE per device.
  //
  // The `mappings === syncedMappingsRef.current` short-circuit is what stops
  // save() from reverting the editor: save() flips dirty→false (no new prop is
  // fetched), which re-runs this effect with the SAME prop reference. Without
  // the guard, setRows(mappings) would overwrite the just-saved rows with the
  // stale prop. We only (re)apply when a genuinely new prop arrives (reload).
  useEffect(() => {
    if (!mappings) return
    if (mappings === syncedMappingsRef.current) return  // same prop already applied — don't revert local edits
    if (dirty) return                                   // a new load arrived mid-edit — keep the user's edits
    syncedMappingsRef.current = mappings
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
    // Reconstruct the card-default + per-row-override model from the flat
    // per-row topics the device returned.
    const ct = inferCardTopic(mappings)
    setCardTopic(ct)
    const norm = normalizeRowTopics(mappings, ct).map((m) => (m.oled && m.oled.includes('\n'))
      // Show real newlines (0x0A) the device stored as a literal "\n" in the
      // single-line text input so it round-trips with the save()-side conversion.
      ? { ...m, oled: m.oled.replace(/\n/g, '\\n') }
      : m)
    setRows(norm)
    // After normalization an override row always carries topics[]; follow rows
    // carry neither, so override = has topics.
    setOverrideRows(new Set(norm.flatMap((m, i) => ((m.topics && m.topics.length) ? [i] : []))))
  }, [mappings, dirty])

  // Auto-load the device's current mappings once per device when the
  // tab opens (so the editor isn't blank on first view).
  const loadedForRef = useRef<string | null>(null)
  useEffect(() => {
    if (loadedForRef.current === device.ipAddress) return
    loadedForRef.current = device.ipAddress
    if (device.online && !mappings) { setLoading(true); setLoadError(false); onRefresh() }
    // onRefresh identity is unstable (inline arrow); guarded by the ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device.ipAddress, device.online])

  // Clear loading as soon as the config arrives (defined, incl. empty []).
  useEffect(() => {
    if (mappings !== undefined) { setLoading(false); setLoadError(false) }
  }, [mappings])

  // Surface a clear error if the device never answers (vs. an indefinite spinner).
  useEffect(() => {
    if (!loading) return
    const t = window.setTimeout(() => { setLoading(false); setLoadError(true) }, 12000)
    return () => window.clearTimeout(t)
  }, [loading])

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
    // Save EXACTLY what the user sees — every keyed row, INCLUDING ones with
    // no event assigned yet. Dropping unassigned rows silently deleted colors
    // the user had set up (worst UX — user report 2026-06-13). Only fully
    // blank rows (no key) are skipped. The firmware just doesn't fire a row
    // whose event_id is empty. A non-destructive warning still nudges the
    // user to assign the missing events.
    const clean = rows
      .map((r, i) => {
        if (overrideRows.has(i)) {
          // Explicit per-row topics (multi). Drop the legacy single `topic`;
          // the firmware publishes to each entry in `topics`.
          return { ...r, topics: r.topics && r.topics.length ? r.topics : undefined, topic: undefined }
        }
        // Follow the card default. Write the channel EXPLICITLY (never leave
        // topic empty): an empty topic makes the firmware fall back to the
        // device's NVS `mq_root`, which on a device provisioned under the old
        // default is still "hapbeat" — so the alert would publish to "hapbeat"
        // while the receiver listens on "default-topic" and never arrives. The
        // contract default channel is "default-topic" (mqtt-transport.md §7).
        return { ...r, topic: cardTopic || 'default-topic', topics: undefined }
      })
      .filter((r) => r.key.trim())
      .map((r) => ({
        ...r,
        key: r.key.trim(),
        event_id: r.event_id.trim(),
        target: r.target.trim(),
        // Convert a literal "\n" the user typed in the OLED text into a real
        // newline (0x0A). The receiver renders the alert text via printEfontWrap
        // which line-breaks on 0x0A, so this lets the user lay out 2-line alerts.
        oled: r.oled ? r.oled.replace(/\\n/g, '\n') : r.oled,
      }))
    sendTo({ type: 'set_sensor_mapping', payload: { mappings: clean } })
    // 「保存しました」の成功表示は出さない — 実際の書込み結果は
    // HelperToastBridge が write_result（実機の応答）ベースで出す
    // (TCP 失敗時に成功と誤表示しないため。user 2026-06-16)。
    // ここではクライアント側の助言（イベント未割当）だけ補足する。
    const noEvent = clean.filter((r) => !r.event_id).length
    if (noEvent > 0) {
      setStatus(`※ ${noEvent} 件はイベント未割当（検知しても発火しません）`, 'warning')
      setTimeout(() => setStatus(null), 6000)
    }
    setDirty(false)
  }

  const reload = () => {
    setLoading(true); setLoadError(false)
    onRefresh()                                                   // get_sensor_mapping (keys + thresholds + events)
    sendToRef.current({ type: 'get_sensor_reading', payload: {} }) // + live RGB value, immediately
    setDirty(false)
  }

  // --- JSON export / import (item 2026-06-14) -------------------------------
  // Save/share the sensor mapping (colors → events + thresholds + topics) as a
  // portable file so a tuned config can be backed up or copied to another
  // sender without re-entering every threshold by hand. Import replaces the
  // editor rows (and marks dirty — the user still presses 保存 to push to the
  // device), so it never writes to a device implicitly.
  const fileInputRef = useRef<HTMLInputElement>(null)
  const exportJson = () => {
    const payload = {
      kind: 'hapbeat-sensor-mapping',
      version: 1,
      sensor_type: sensorType ?? undefined,
      mappings: rows,
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    const safe = (device.name || device.ipAddress || 'sensor').replace(/[^\w.-]+/g, '_')
    a.href = url
    a.download = `sensor-mapping-${safe}.json`
    a.click()
    URL.revokeObjectURL(url)
    setStatus(`${rows.length} 件を JSON にエクスポートしました`)
    setTimeout(() => setStatus(null), 5000)
  }
  const importJson = (file: File) => {
    const fr = new FileReader()
    fr.onload = () => {
      try {
        const parsed = JSON.parse(String(fr.result)) as unknown
        // Accept either {mappings:[...]} or a bare array.
        const arr = Array.isArray(parsed)
          ? parsed
          : (parsed as { mappings?: unknown }).mappings
        if (!Array.isArray(arr)) throw new Error('mappings 配列が見つかりません')
        const valid = (arr as SensorMapping[]).filter(
          (m) => m && typeof m === 'object' && typeof m.key === 'string' && m.match,
        )
        if (valid.length === 0) throw new Error('有効なマッピングがありません')
        // Normalize every imported row to the full SensorMapping shape. A
        // foreign / hand-authored file may omit event_id / target / gain; left
        // undefined they crash save() (r.event_id.trim()) and render NaN% gain.
        // Fill the same defaults emptyMapping() uses so imported rows behave
        // exactly like editor-created ones.
        const imported: SensorMapping[] = valid.map((m) => ({
          key: m.key,
          match: { ...m.match },
          event_id: typeof m.event_id === 'string' ? m.event_id : '',
          target: typeof m.target === 'string' ? m.target : '',
          gain: typeof m.gain === 'number' ? m.gain : 1.0,
          debounce_ms: typeof m.debounce_ms === 'number' ? m.debounce_ms : undefined,
          oled: typeof m.oled === 'string' ? m.oled : undefined,
          topic: typeof m.topic === 'string' ? m.topic : undefined,
          topics: Array.isArray(m.topics) ? m.topics.filter((t): t is string => typeof t === 'string') : undefined,
          critical: m.critical === true ? true : undefined,
        }))
        const ct = inferCardTopic(imported)
        setCardTopic(ct)
        const norm = normalizeRowTopics(imported, ct)
        setRows(norm)
        setOverrideRows(new Set(norm.flatMap((m, i) => ((m.topics && m.topics.length) ? [i] : []))))
        setDirty(true)
        setStatus(`${imported.length} 件をインポートしました — 「デバイスに保存」で書き込みます`)
      } catch (e) {
        setStatus(`インポート失敗: ${e instanceof Error ? e.message : 'JSON を解析できません'}`)
      }
      setTimeout(() => setStatus(null), 6000)
    }
    fr.readAsText(file)
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
          title="デバイスから現在のマッピングを再取得"
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

      {loading ? (
        <div className="form-status muted">⏳ センサ設定を読み込み中…（デバイスの応答に数秒かかる場合があります）</div>
      ) : loadError ? (
        <div className="form-status err">
          ✗ 読み込みに失敗しました。デバイスがオンラインか確認し、「⟳ 読み込み」で再試行してください。
        </div>
      ) : rows.length === 0 ? (
        <div className="form-status muted">
          マッピング未設定です。「＋ 検知色を追加」で割り当てを作成してください。
        </div>
      ) : null}

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

          {/* Per-color OLED text shown on the receiver when this color fires
              (item 9, e.g. "Red alert occured"). Empty → no message. */}
          <div className="form-row">
            <label>受信機の表示</label>
            <input
              className="form-input"
              value={r.oled ?? ''}
              onChange={(e) => update(i, { oled: e.target.value || undefined })}
              placeholder="例: <color> alert \n occured（空欄 = 表示なし・\n で改行）"
              maxLength={40}
              disabled={!device.online}
            />
            <span />
          </div>
          <div className="form-status muted">
            受信機の OLED に表示する文言。<code>\n</code> で改行できます（例:
            <code>{'<color> alert \\n occured'}</code> → 2 行表示）。空欄 = 表示なし。
          </div>

          {/* 重要フラグ (§6.3): a color marked 重要 still plays on receivers that
              are in 制限モード (restricted). */}
          <div className="form-row">
            <label>重要</label>
            <label
              className="form-status muted"
              style={{ margin: 0, display: 'inline-flex', alignItems: 'center', gap: 6 }}
            >
              <input
                type="checkbox"
                checked={r.critical ?? false}
                onChange={(e) => update(i, { critical: e.target.checked || undefined })}
                disabled={!device.online}
              />
              受信機が「制限モード」でもこの色は再生する（例: 赤）
            </label>
            <span />
          </div>

          {/* Send-destination topic(s) (item 6 / §5). By default the color
              follows the card-level 送信トピック; tick "個別の Topic に送信する"
              to choose one or MORE topics for this color (each gets the play).
              Multi-select writes r.topics[]; the firmware publishes to each. */}
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
                個別の Topic に送信する（複数可）
              </label>
              {overrideRows.has(i) ? (
                <div className="form-row-multi" style={{ flexWrap: 'wrap', gap: 8 }}>
                  {Array.from(new Set(['default-topic', ...topics, ...(r.topics ?? [])])).map((t) => {
                    const sel = (r.topics ?? []).includes(t)
                    return (
                      <label
                        key={t}
                        className="form-status muted"
                        style={{ margin: 0, display: 'inline-flex', alignItems: 'center', gap: 4 }}
                      >
                        <input
                          type="checkbox"
                          checked={sel}
                          onChange={() => {
                            const cur = r.topics ?? []
                            const next = sel ? cur.filter((x) => x !== t) : [...cur, t]
                            update(i, { topics: next.length ? next : undefined, topic: undefined })
                          }}
                          disabled={!device.online}
                        />
                        {t}
                      </label>
                    )
                  })}
                </div>
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

      <div className="form-action-row" style={{ marginTop: 10, flexWrap: 'wrap' }}>
        <button className="form-button-secondary" onClick={addRow} disabled={!device.online}>
          ＋ 検知色を追加
        </button>
        <span style={{ flex: 1 }} />
        {/* JSON save/load sit next to the device-save button (not the header)
            so they're noticed (user 2026-06-15). Import only loads into the
            editor — the user still presses「デバイスに保存」to write it. */}
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) importJson(f)
            e.target.value = ''  // allow re-importing the same file
          }}
        />
        <button
          className="form-button-secondary"
          onClick={(e) => { setAnchor(e.currentTarget); fileInputRef.current?.click() }}
          title="JSON ファイルからマッピングを読み込む（「デバイスに保存」で反映）"
        >
          ⤒ JSON 読込
        </button>
        <button
          className="form-button-secondary"
          onClick={(e) => { setAnchor(e.currentTarget); exportJson() }}
          disabled={rows.length === 0}
          title="現在のマッピングを JSON ファイルに保存"
        >
          ⤓ JSON 保存
        </button>
        <button
          className="form-button"
          onClick={(e) => { setAnchor(e.currentTarget); save() }}
          disabled={!device.online || !dirty}
          title="編集内容をデバイスに書き込む"
        >
          デバイスに保存
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------
// ESP-NOW: display / power policy (receiver only, espnow_stream transport)
// Serial-only — espnow_stream receivers have no Wi-Fi/TCP. Reaches the
// device through useDeviceTransport's serial: branch (Web Serial).
// ---------------------------------------------------------------------

export function EspNowDisplayPowerSection({
  device,
  cachedInfo,
  oledLevel,
  sendTo,
}: {
  device: DeviceInfo
  cachedInfo?: NodeConfigInfo
  /** Current OLED brightness level (1/2/3) from DeviceDetail info cache. */
  oledLevel: number | undefined
  sendTo: (msg: ManagerMessage) => void
}) {
  const ui = cachedInfo?.espnow_ui
  const [autoOffMs, setAutoOffMs] = useState<number>(ui?.auto_off_ms ?? 4000)
  const [wakeOnButton, setWakeOnButton] = useState<boolean>(ui?.wake_on_button ?? true)
  const [wakeOnVolume, setWakeOnVolume] = useState<boolean>(ui?.wake_on_volume ?? true)
  const [ledEnabled, setLedEnabled] = useState<boolean>(ui?.led_enabled ?? false)
  const [lowBattPct, setLowBattPct] = useState<number>(ui?.low_batt_pct ?? 15)

  // Sync from device whenever cachedInfo.espnow_ui changes (get_info result).
  useEffect(() => {
    if (!ui) return
    if (ui.auto_off_ms != null) setAutoOffMs(ui.auto_off_ms)
    if (ui.wake_on_button != null) setWakeOnButton(ui.wake_on_button)
    if (ui.wake_on_volume != null) setWakeOnVolume(ui.wake_on_volume)
    if (ui.led_enabled != null) setLedEnabled(ui.led_enabled)
    if (ui.low_batt_pct != null) setLowBattPct(ui.low_batt_pct)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    ui?.auto_off_ms, ui?.wake_on_button, ui?.wake_on_volume,
    ui?.led_enabled, ui?.low_batt_pct,
  ])

  const { setAnchor } = useToast()

  const applyAll = (e: React.MouseEvent<HTMLButtonElement>) => {
    setAnchor(e.currentTarget)
    sendTo({
      type: 'set_espnow_ui',
      payload: { auto_off_ms: autoOffMs, wake_on_button: wakeOnButton,
                 wake_on_volume: wakeOnVolume, led_enabled: ledEnabled,
                 low_batt_pct: lowBattPct },
    })
  }

  const offline = !device.online

  const BRIGHTNESS_LEVELS = [
    { value: 1 as const, label: 'Low',  hint: '暗所・夜間 (~6%)' },
    { value: 2 as const, label: 'Mid',  hint: '通常室内 (50%)' },
    { value: 3 as const, label: 'High', hint: '明所 (100%)' },
  ]

  return (
    <div className="form-section">
      <div className="form-section-title">
        表示・電力設定
        <span className="form-section-sub-inline"> — ESP-NOW 受信機</span>
      </div>

      {/* OLED brightness */}
      <div className="form-row">
        <label>OLED 輝度</label>
        <div className="device-toggle" role="group" aria-label="OLED brightness">
          {BRIGHTNESS_LEVELS.map((l) => (
            <button
              key={l.value}
              type="button"
              className={`btn btn-sm device-toggle-btn ${oledLevel === l.value ? 'active' : ''}`}
              onClick={(e) => { setAnchor(e.currentTarget); sendTo({ type: 'set_oled_brightness', payload: { level: l.value } }) }}
              disabled={offline}
              title={l.hint}
            >
              {l.label}
            </button>
          ))}
        </div>
        <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
          {oledLevel == null ? '読込中…' : BRIGHTNESS_LEVELS.find((l) => l.value === oledLevel)?.hint ?? ''}
        </span>
      </div>

      {/* Auto-off timeout */}
      <div className="form-row">
        <label>自動消灯</label>
        <div className="form-row-multi" style={{ alignItems: 'center', gap: 8 }}>
          <input
            type="range"
            min={500}
            max={60000}
            step={500}
            value={autoOffMs}
            onChange={(e) => setAutoOffMs(Number(e.target.value))}
            disabled={offline}
            style={{ flex: 1 }}
          />
          <span className="mono" style={{ width: 56, textAlign: 'right' }}>
            {(autoOffMs / 1000).toFixed(1)} s
          </span>
        </div>
        <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
          操作後に OLED を消灯するまでの時間
        </span>
      </div>

      {/* Wake sources */}
      <div className="form-row">
        <label>点灯源</label>
        <div className="form-row-multi" style={{ gap: 12, alignItems: 'center' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={wakeOnButton}
              onChange={(e) => setWakeOnButton(e.target.checked)}
              disabled={offline}
            />
            ボタン
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={wakeOnVolume}
              onChange={(e) => setWakeOnVolume(e.target.checked)}
              disabled={offline}
            />
            ボリューム変更
          </label>
        </div>
        <span />
      </div>

      {/* LED */}
      <div className="form-row">
        <label>ステータス LED</label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={ledEnabled}
            onChange={(e) => setLedEnabled(e.target.checked)}
            disabled={offline}
          />
          使用する
        </label>
        <span />
      </div>

      {/* Low battery threshold */}
      <div className="form-row">
        <label>低電池表示 (%)</label>
        <div className="form-row-multi" style={{ alignItems: 'center', gap: 8 }}>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={lowBattPct}
            onChange={(e) => setLowBattPct(Number(e.target.value))}
            disabled={offline}
            style={{ flex: 1 }}
          />
          <span className="mono" style={{ width: 40, textAlign: 'right' }}>
            {lowBattPct}%
          </span>
        </div>
        <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
          バッテリー残量がこの値以下で OLED 点灯
        </span>
      </div>

      <div className="form-action-row" style={{ marginTop: 8 }}>
        <button
          className="form-button"
          onClick={applyAll}
          disabled={offline}
        >
          適用
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------
// DuoWL v4: per-device audio stage calibration (DEC-041)
// board === "duo_wl_v4" only. Wire: set_haptic_gain / set_dac_boost /
// set_headphone_volume, readback via get_info.audio (no dedicated get_).
// ---------------------------------------------------------------------

const PAM_GAIN_STEPS = [6, 12, 18, 24] as const

export function DuoWlV4AudioSection({
  device,
  cachedInfo,
  sendTo,
}: {
  device: DeviceInfo
  cachedInfo?: NodeConfigInfo
  sendTo: (msg: ManagerMessage) => void
}) {
  const audio = cachedInfo?.audio
  const [pamDb, setPamDb] = useState<number>(audio?.pam_db ?? 24)
  const [lineoutDb, setLineoutDb] = useState<number>(audio?.lineout_db ?? 6)
  const [boostDb, setBoostDb] = useState<number>(audio?.boost_db ?? 0)
  const [hpDb, setHpDb] = useState<number>(audio?.hp_db ?? -10)
  // Stream jitter buffer (set_stream_buffer). Write-only — not in get_info yet.
  const [bufferMs, setBufferMs] = useState<number>(0)
  // Input/output routing (DEC-041 follow-up): output=normal HP playback,
  // line_in=jack audio-in → haptics (DuoWL v4 only).
  const [inputMode, setInputMode] = useState<'output' | 'line_in'>(audio?.input_mode ?? 'output')

  // Sync from device whenever cachedInfo.audio changes (get_info result).
  useEffect(() => {
    if (!audio) return
    if (audio.pam_db != null) setPamDb(audio.pam_db)
    if (audio.lineout_db != null) setLineoutDb(audio.lineout_db)
    if (audio.boost_db != null) setBoostDb(audio.boost_db)
    if (audio.hp_db != null) setHpDb(audio.hp_db)
    if (audio.input_mode != null) setInputMode(audio.input_mode)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audio?.pam_db, audio?.lineout_db, audio?.boost_db, audio?.hp_db, audio?.input_mode])

  const { setAnchor } = useToast()
  const offline = !device.online

  // set_haptic_gain covers both the PAM select and the line-out slider — send
  // both fields together (partial update is also allowed by the wire spec,
  // but sending both keeps the two controls' "適用" behavior simple/atomic).
  const applyHapticGain = (e: React.MouseEvent<HTMLElement>) => {
    setAnchor(e.currentTarget)
    sendTo({ type: 'set_haptic_gain', payload: { pam_db: pamDb, lineout_db: lineoutDb } })
  }
  const applyBoost = (e: React.MouseEvent<HTMLElement>) => {
    setAnchor(e.currentTarget)
    sendTo({ type: 'set_dac_boost', payload: { boost_db: boostDb } })
  }
  const applyHpVolume = (e: React.MouseEvent<HTMLElement>) => {
    setAnchor(e.currentTarget)
    sendTo({ type: 'set_headphone_volume', payload: { hp_db: hpDb } })
  }
  const applyBuffer = (e: React.MouseEvent<HTMLElement>) => {
    setAnchor(e.currentTarget)
    sendTo({ type: 'set_stream_buffer', payload: { buffer_ms: bufferMs } })
  }
  const applyInputMode = (e: React.MouseEvent<HTMLElement>, next: 'output' | 'line_in') => {
    setAnchor(e.currentTarget)
    setInputMode(next)
    sendTo({ type: 'set_input_mode', payload: { mode: next } })
  }

  return (
    <>
    <div className="form-section duo-v4-config">
      <div className="form-section-title">
        ゲイン設定（DuoWL v4）
        <span className="form-section-sub-inline"> — IC 別・個体差キャリブレーション</span>
      </div>
      <div className="form-status muted" style={{ marginBottom: 6, fontSize: 12 }}>
        信号の流れ: DAC(AIC3204) → ライン出力(AIC3204) → PAM8404 → 触覚モータ ／ 別系統: DAC → TPA6130A2 → ヘッドホン
      </div>

      {/* 0. Input/output routing — output=通常のヘッドホン出力, line_in=ジャックから
          有線音声を入力して触覚に出す（DuoWL v4 専用）。 */}
      <div className="form-row">
        <label>入出力モード</label>
        <div className="device-toggle" role="group" aria-label="input/output mode">
          <button
            type="button"
            className={`btn btn-sm device-toggle-btn ${inputMode === 'output' ? 'active' : ''}`}
            onClick={(e) => applyInputMode(e, 'output')}
            disabled={offline}
          >
            出力（ヘッドホン）
          </button>
          <button
            type="button"
            className={`btn btn-sm device-toggle-btn ${inputMode === 'line_in' ? 'active' : ''}`}
            onClick={(e) => applyInputMode(e, 'line_in')}
            disabled={offline}
          >
            入力（ライン入力）
          </button>
        </div>
        <span />
      </div>
      {/* min-height reserved so this hint is always present — never shifts
          the rows below when inputMode changes (layout-shift rule). */}
      <div className="form-status muted" style={{ minHeight: 18, fontSize: 12 }}>
        {inputMode === 'line_in'
          ? 'ライン入力: ジャックからの有線音声を触覚として出力します。'
          : '出力: 通常のヘッドホン再生です。'}
      </div>

      {/* 1. PAM8404 power amp (coarse, drives the motors) */}
      <div className="form-row">
        <label>触覚アンプ<br /><span style={{ fontSize: 11, color: 'var(--text-muted)' }}>PAM8404</span></label>
        <div className="device-toggle" role="group" aria-label="PAM8404 gain">
          {PAM_GAIN_STEPS.map((v) => (
            <button
              key={v}
              type="button"
              className={`btn btn-sm device-toggle-btn ${pamDb === v ? 'active' : ''}`}
              onClick={() => setPamDb(v)}
              disabled={offline}
            >
              {v} dB
            </button>
          ))}
        </div>
        <span />
      </div>
      <div className="form-status muted" style={{ fontSize: 12 }}>パワーアンプの粗ゲイン。触覚モータを駆動（4 段）</div>

      {/* 2. AIC3204 (U1) line-out driver — analog pre-amp before the PAM */}
      <div className="form-row">
        <label>触覚ライン出力<br /><span style={{ fontSize: 11, color: 'var(--text-muted)' }}>AIC3204 U1</span></label>
        <div className="form-row-multi" style={{ alignItems: 'center', gap: 8 }}>
          <input
            type="range"
            min={-6}
            max={29}
            step={1}
            value={lineoutDb}
            onChange={(e) => setLineoutDb(Math.max(-6, Math.min(29, Number(e.target.value))))}
            disabled={offline}
            style={{ flex: 1 }}
          />
          <span className="mono" style={{ width: 56, textAlign: 'right' }}>
            {lineoutDb} dB
          </span>
        </div>
        <span />
      </div>
      <div className="form-status muted" style={{ fontSize: 12 }}>
        codec のライン出力ドライバ（PAM の前段・<b>固定</b>アナログゲイン、−6〜+29 dB）。
        ※ ボリュームノブ（var/fix）で変わる音量はこれとは別系統（DAC デジタルボリューム、debug 情報の Volume 参照）。
      </div>

      <div className="form-action-row" style={{ marginTop: 8 }}>
        <button className="form-button" onClick={applyHapticGain} disabled={offline}>
          触覚ゲインを適用（PAM + ライン出力）
        </button>
      </div>

      {/* 3. AIC3204 DAC digital make-up boost (affects BOTH codecs) */}
      <div className="form-row" style={{ marginTop: 12 }}>
        <label>DAC ブースト<br /><span style={{ fontSize: 11, color: 'var(--text-muted)' }}>AIC3204 DAC</span></label>
        <div className="form-row-multi" style={{ alignItems: 'center', gap: 8 }}>
          <input
            type="range"
            min={0}
            max={24}
            step={1}
            value={boostDb}
            onChange={(e) => setBoostDb(Math.max(0, Math.min(24, Number(e.target.value))))}
            disabled={offline}
            style={{ flex: 1 }}
          />
          <span className="mono" style={{ width: 56, textAlign: 'right' }}>
            {boostDb} dB
          </span>
        </div>
        <span />
      </div>
      {/* min-height reserved so this hint is always present — never shifts
          the action row below when boostDb changes (layout-shift rule). */}
      <div className="form-status muted" style={{ minHeight: 18, fontSize: 12 }}>
        DAC デジタルボリュームに一律加算（触覚・HP 両 codec）。0 = 無効（既定・0 dB 上限）。
        0 超は 0dBFS 素材がクリップし得る（歪みが少ないのはアナログの「ライン出力」側）。
      </div>
      <div className="form-action-row" style={{ marginTop: 8 }}>
        <button className="form-button" onClick={applyBoost} disabled={offline}>
          DAC ブーストを適用
        </button>
      </div>

      {/* 4. TPA6130A2 headphone amp (independent of the haptic path) */}
      <div className="form-row" style={{ marginTop: 12 }}>
        <label>ヘッドホン音量<br /><span style={{ fontSize: 11, color: 'var(--text-muted)' }}>TPA6130A2</span></label>
        <div className="form-row-multi" style={{ alignItems: 'center', gap: 8 }}>
          <input
            type="range"
            min={-59}
            max={4}
            step={1}
            value={hpDb}
            onChange={(e) => setHpDb(Math.max(-59, Math.min(4, Number(e.target.value))))}
            disabled={offline}
            style={{ flex: 1 }}
          />
          <span className="mono" style={{ width: 56, textAlign: 'right' }}>
            {hpDb} dB
          </span>
        </div>
        <span />
      </div>
      <div className="form-status muted" style={{ fontSize: 12 }}>HP アンプ出力（触覚音量とは独立）</div>

      <div className="form-action-row" style={{ marginTop: 8 }}>
        <button className="form-button" onClick={applyHpVolume} disabled={offline}>
          ヘッドホン音量を適用
        </button>
      </div>
    </div>

    {/* Stream jitter buffer (set_stream_buffer). General to all UDP receivers;
        surfaced here as it's the main v4 headphone-music tuning knob. */}
    <div className="form-section duo-v4-config">
      <div className="form-section-title">
        ストリーム再生バッファ
        <span className="form-section-sub-inline"> — 遅延 vs 途切れ</span>
      </div>
      <div className="form-row">
        <label>プリセット</label>
        <div className="device-toggle" role="group" aria-label="stream buffer preset">
          <button
            type="button"
            className={`btn btn-sm device-toggle-btn ${bufferMs === 0 ? 'active' : ''}`}
            onClick={() => setBufferMs(0)}
            disabled={offline}
          >
            低遅延 0ms（触覚）
          </button>
          <button
            type="button"
            className={`btn btn-sm device-toggle-btn ${bufferMs === 120 ? 'active' : ''}`}
            onClick={() => setBufferMs(120)}
            disabled={offline}
          >
            音楽 120ms
          </button>
        </div>
        <span />
      </div>
      <div className="form-row">
        <label>微調整</label>
        <div className="form-row-multi" style={{ alignItems: 'center', gap: 8 }}>
          <input
            type="range"
            min={0}
            max={200}
            step={10}
            value={bufferMs}
            onChange={(e) => setBufferMs(Math.max(0, Math.min(200, Number(e.target.value))))}
            disabled={offline}
            style={{ flex: 1 }}
          />
          <span className="mono" style={{ width: 56, textAlign: 'right' }}>
            {bufferMs} ms
          </span>
        </div>
        <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
          0=低遅延（触覚向き）。大きいほど Wi-Fi のゆらぎで途切れにくいが、その分再生が遅れる（HP 音楽向き）。
        </span>
      </div>
      <div className="form-status muted" style={{ minHeight: 18, fontSize: 12 }}>
        ※ 全 UDP 受信機共通の設定。現在値の読み戻しは未対応（設定は反映されます）。
      </div>
      <div className="form-action-row" style={{ marginTop: 8 }}>
        <button className="form-button" onClick={applyBuffer} disabled={offline}>
          バッファを適用
        </button>
      </div>
    </div>
    </>
  )
}

// ---------------------------------------------------------------------
// DuoWL v4 ESP-NOW hp48 receiver: HP volume (dB) + A-V delay (audio-dsp-
// config.md §1/§3). Shown on the ESP-NOW tab (not the 設定 tab, unlike
// DuoWlV4AudioSection above) because a pure-espnow_stream receiver has no
// 設定 tab (computeSubTabs in DeviceDetail.tsx) — this is the ESP-NOW-side
// counterpart, board === "duo_wl_v4" gated by the caller.
//
// HP volume reuses the existing `set_headphone_volume` (§1: "既存を流用")
// — same wire command as DuoWlV4AudioSection's TPA6130A2 slider, just
// surfaced here too since that section isn't reachable for this receiver.
// ---------------------------------------------------------------------

export function DuoWlV4EspNowAudioSection({
  device,
  cachedInfo,
  sendTo,
}: {
  device: DeviceInfo
  cachedInfo?: NodeConfigInfo
  sendTo: (msg: ManagerMessage) => void
}) {
  const clampHpDb = (v: number) => Math.max(-59, Math.min(4, Math.round(v)))
  const clampAvDelay = (v: number) => Math.max(0, Math.min(30, Math.round(v)))

  const [hpDb, setHpDb] = useState<number>(clampHpDb(cachedInfo?.audio?.hp_db ?? -10))
  const [avDelayMs, setAvDelayMs] = useState<number>(clampAvDelay(cachedInfo?.av_delay_ms ?? 0))

  useEffect(() => {
    if (cachedInfo?.audio?.hp_db != null) setHpDb(clampHpDb(cachedInfo.audio.hp_db))
    if (cachedInfo?.av_delay_ms != null) setAvDelayMs(clampAvDelay(cachedInfo.av_delay_ms))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device.ipAddress, cachedInfo?.audio?.hp_db, cachedInfo?.av_delay_ms])

  const { setAnchor } = useToast()
  const offline = !device.online

  const applyHpVolume = (e: React.MouseEvent<HTMLElement>) => {
    setAnchor(e.currentTarget)
    sendTo({ type: 'set_headphone_volume', payload: { hp_db: hpDb } })
  }
  const applyAvDelay = (e: React.MouseEvent<HTMLElement>) => {
    setAnchor(e.currentTarget)
    sendTo({ type: 'set_av_delay', payload: { ms: avDelayMs } })
  }

  return (
    <div className="form-section duo-v4-config">
      <div className="form-section-title">
        音量 / 遅延（DuoWL v4）
        <span className="form-section-sub-inline"> — ヘッドホン音量 + 音声-触覚間ディレイ</span>
      </div>

      {/* 1. TPA6130A2 headphone volume (analog only — DAC digital volume is
          pinned to 0dB on the HP codec; the ADC wheel drives haptic only). */}
      <div className="form-row">
        <label>ヘッドホン音量<br /><span style={{ fontSize: 11, color: 'var(--text-muted)' }}>TPA6130A2</span></label>
        <div className="form-row-multi" style={{ alignItems: 'center', gap: 8 }}>
          <input
            type="range"
            min={-59}
            max={4}
            step={1}
            value={hpDb}
            onChange={(e) => setHpDb(clampHpDb(Number(e.target.value)))}
            disabled={offline}
            style={{ flex: 1 }}
          />
          <span className="mono" style={{ width: 56, textAlign: 'right' }}>
            {hpDb} dB
          </span>
        </div>
        <span />
      </div>
      <div className="form-status muted" style={{ fontSize: 12 }}>
        本体ボタン（再生モード時: Btn4=+ / Btn5=−）でも操作できます。ホイールは触覚音量のみを操作します。
      </div>
      <div className="form-action-row" style={{ marginTop: 8 }}>
        <button className="form-button" onClick={applyHpVolume} disabled={offline}>
          ヘッドホン音量を適用
        </button>
      </div>

      {/* 2. A-V delay — delays HP audio relative to haptic (audio-dsp-config.md §3). */}
      <div className="form-row" style={{ marginTop: 12 }}>
        <label>A-V ディレイ</label>
        <div className="form-row-multi" style={{ alignItems: 'center', gap: 8 }}>
          <input
            type="range"
            min={0}
            max={30}
            step={1}
            value={avDelayMs}
            onChange={(e) => setAvDelayMs(clampAvDelay(Number(e.target.value)))}
            disabled={offline}
            style={{ flex: 1 }}
          />
          <span className="mono" style={{ width: 56, textAlign: 'right' }}>
            {avDelayMs} ms
          </span>
        </div>
        <span />
      </div>
      <div className="form-status muted" style={{ fontSize: 12 }}>
        音声（ヘッドホン）を触覚に対して遅らせます（モーターの反応が遅いぶん、音声側を合わせる）。0=遅延なし。
      </div>
      <div className="form-action-row" style={{ marginTop: 8 }}>
        <button className="form-button" onClick={applyAvDelay} disabled={offline}>
          ディレイを適用
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------
// DuoWL v4 ESP-NOW hp48 receiver: per-codec EQ designer (audio-dsp-
// config.md §2). Up to 3 AIC3204 in-codec biquads per codec (haptic
// 16kHz / hp 48kHz). Each band's fc/Q/gain are LOCAL design controls —
// the device only persists/reports ftype + the committed raw Q1.23 ints
// (get_info.eq), which aren't invertible back to fc/Q/gain — so this
// editor doesn't try to resync those from the device; it shows the
// committed ints read-only alongside the (locally-held) design controls.
// ---------------------------------------------------------------------

type EqCodec = 'haptic' | 'hp'

interface EqBandDraft {
  ftype: EqFtype
  fc: number
  q: number
  gainDb: number
}

const EQ_BAND_COUNT = 3
const EQ_FS: Record<EqCodec, number> = { haptic: 16000, hp: 48000 }
/** RBJ Q for a 2nd-order Butterworth response (1/√2). */
const EQ_BUTTERWORTH_Q = 1 / Math.sqrt(2)

/** haptic band0 default = 100Hz 2nd-order Butterworth LPF (audio-dsp-
 *  config.md §2 "既定 EQ" — matches the BT product / firmware boot
 *  default). Every other band defaults to off (passthrough). */
function defaultEqDraft(codec: EqCodec, band: number): EqBandDraft {
  if (codec === 'haptic' && band === 0) {
    return { ftype: 'lpf', fc: 100, q: EQ_BUTTERWORTH_Q, gainDb: 0 }
  }
  return { ftype: 'off', fc: 1000, q: EQ_BUTTERWORTH_Q, gainDb: 0 }
}
function defaultEqDrafts(codec: EqCodec): EqBandDraft[] {
  return Array.from({ length: EQ_BAND_COUNT }, (_, i) => defaultEqDraft(codec, i))
}

const EQ_FTYPE_OPTIONS: Array<{ value: EqFtype; label: string }> = [
  { value: 'off', label: 'オフ' },
  { value: 'lpf', label: 'LPF' },
  { value: 'hpf', label: 'HPF' },
  { value: 'peaking', label: 'ピーキング' },
  { value: 'lowshelf', label: 'ローシェルフ' },
  { value: 'highshelf', label: 'ハイシェルフ' },
  { value: 'notch', label: 'ノッチ' },
]
/** Only these ftypes read `gainDb` — the input is grayed out otherwise
 *  (always rendered, never removed, so the row height never shifts). */
const EQ_GAIN_FTYPES = new Set<EqFtype>(['peaking', 'lowshelf', 'highshelf'])

function clampEqFc(fc: number, fs: number): number {
  if (!Number.isFinite(fc)) return 100
  return Math.max(20, Math.min(Math.round(fs / 2) - 20, Math.round(fc)))
}
function clampEqQ(q: number): number {
  if (!Number.isFinite(q)) return EQ_BUTTERWORTH_Q
  return Math.max(0.1, Math.min(20, q))
}
function clampEqGainDb(g: number): number {
  if (!Number.isFinite(g)) return 0
  return Math.max(-24, Math.min(24, g))
}

/** One band's edit row: ftype/fc/Q/gain controls + a fixed-height
 *  computed-coefficient / warning readout + the per-band 適用 button. */
function EqBandEditor({
  codec,
  band,
  draft,
  committed,
  offline,
  onChange,
  onApply,
}: {
  codec: EqCodec
  band: number
  draft: EqBandDraft
  committed?: EqBandReadout
  offline: boolean
  onChange: (next: EqBandDraft) => void
  onApply: (e: React.MouseEvent<HTMLElement>) => void
}) {
  const fs = EQ_FS[codec]
  const result = useMemo(
    () => computeAic3204Eq({ ftype: draft.ftype, fs, fc: draft.fc, q: draft.q, gainDb: draft.gainDb }),
    [draft.ftype, fs, draft.fc, draft.q, draft.gainDb],
  )
  const showGain = EQ_GAIN_FTYPES.has(draft.ftype)
  const isOff = draft.ftype === 'off'

  return (
    <div className="form-row" style={{ marginTop: band === 0 ? 6 : 14, alignItems: 'flex-start' }}>
      <label>band {band}</label>
      <div className="form-row-multi" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <select
            className="form-input"
            value={draft.ftype}
            onChange={(e) => onChange({ ...draft, ftype: e.target.value as EqFtype })}
            disabled={offline}
            style={{ flex: '0 0 110px' }}
          >
            {EQ_FTYPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, opacity: isOff ? 0.4 : 1 }}>
            fc
            <input
              className="form-input mono"
              type="number"
              min={20}
              max={Math.round(fs / 2) - 20}
              value={draft.fc}
              onChange={(e) => onChange({ ...draft, fc: clampEqFc(Number(e.target.value), fs) })}
              disabled={offline || isOff}
              style={{ width: 72 }}
            />
            Hz
          </label>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, opacity: isOff ? 0.4 : 1 }}>
            Q
            <input
              className="form-input mono"
              type="number"
              min={0.1}
              max={20}
              step={0.01}
              value={draft.q}
              onChange={(e) => onChange({ ...draft, q: clampEqQ(Number(e.target.value)) })}
              disabled={offline || isOff}
              style={{ width: 60 }}
            />
          </label>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, opacity: showGain ? 1 : 0.4 }}>
            gain
            <input
              className="form-input mono"
              type="number"
              min={-24}
              max={24}
              step={0.5}
              value={draft.gainDb}
              onChange={(e) => onChange({ ...draft, gainDb: clampEqGainDb(Number(e.target.value)) })}
              disabled={offline || !showGain}
              style={{ width: 60 }}
            />
            dB
          </label>
          <button
            type="button"
            className="form-button-secondary"
            onClick={onApply}
            disabled={offline}
            style={{ marginLeft: 'auto', flexShrink: 0 }}
          >
            適用
          </button>
        </div>
        {/* Fixed-height status line (layout-shift rule): always present,
            only the text/color changes between off / ok / warn states. */}
        <div className="form-status muted" style={{ minHeight: 16, fontSize: 11, margin: 0 }}>
          {isOff
            ? 'オフ（素通し）'
            : result.clamped
              ? '⚠ 係数が上限を超えクランプされました。ゲインを下げるか別バンド/DAC ブーストで補ってください。'
              : result.overflowed
                ? `オートプリスケール中 — 約 ${result.makeupDb.toFixed(2)}dB 分を他（DAC ブースト等）で補ってください`
                : `N0=${result.coeffs.N0} N1=${result.coeffs.N1} N2=${result.coeffs.N2} D1=${result.coeffs.D1} D2=${result.coeffs.D2}`}
        </div>
        {committed && (
          <div className="form-status muted" style={{ fontSize: 10, margin: 0, opacity: 0.7 }}>
            実機の設定: {committed.ftype} [{committed.coeffs.join(', ')}]
          </div>
        )}
      </div>
      <span />
    </div>
  )
}

function DuoWlV4EqCodecBlock({
  codec,
  title,
  fsLabel,
  device,
  committed,
  sendTo,
}: {
  codec: EqCodec
  title: string
  fsLabel: string
  device: DeviceInfo
  committed?: EqBandReadout[]
  sendTo: (msg: ManagerMessage) => void
}) {
  const [drafts, setDrafts] = useState<EqBandDraft[]>(() => defaultEqDrafts(codec))
  // Local-only design state (fc/Q/gain aren't recoverable from the device) —
  // reset to defaults when the SELECTED DEVICE changes so edits don't bleed
  // across devices (mirrors the deviceRef reset pattern used elsewhere in
  // this file, e.g. SensorMappingSection).
  const deviceRef = useRef(device.ipAddress)
  useEffect(() => {
    if (deviceRef.current === device.ipAddress) return
    deviceRef.current = device.ipAddress
    setDrafts(defaultEqDrafts(codec))
  }, [device.ipAddress, codec])

  const offline = !device.online
  const { setAnchor } = useToast()

  const applyBand = (band: number) => (e: React.MouseEvent<HTMLElement>) => {
    setAnchor(e.currentTarget)
    const draft = drafts[band]
    const result = computeAic3204Eq({
      ftype: draft.ftype,
      fs: EQ_FS[codec],
      fc: draft.fc,
      q: draft.q,
      gainDb: draft.gainDb,
    })
    sendTo({
      type: 'set_eq_band',
      payload: {
        codec,
        band,
        ftype: draft.ftype,
        coeffs: aic3204CoeffsToArray(result.coeffs),
      },
    })
  }

  return (
    <div className="form-section duo-v4-config">
      <div className="form-section-title">
        {title}
        <span className="form-section-sub-inline"> — AIC3204 in-codec biquad × 3band（{fsLabel}）</span>
      </div>
      {drafts.map((draft, i) => (
        <EqBandEditor
          key={i}
          codec={codec}
          band={i}
          draft={draft}
          committed={committed?.[i]}
          offline={offline}
          onChange={(next) => setDrafts((ds) => ds.map((d, idx) => (idx === i ? next : d)))}
          onApply={applyBand(i)}
        />
      ))}
    </div>
  )
}

export function DuoWlV4EqSection({
  device,
  cachedInfo,
  sendTo,
}: {
  device: DeviceInfo
  cachedInfo?: NodeConfigInfo
  sendTo: (msg: ManagerMessage) => void
}) {
  return (
    <>
      <DuoWlV4EqCodecBlock
        codec="haptic"
        title="触覚 EQ"
        fsLabel="16kHz"
        device={device}
        committed={cachedInfo?.eq?.haptic}
        sendTo={sendTo}
      />
      <DuoWlV4EqCodecBlock
        codec="hp"
        title="ヘッドホン EQ"
        fsLabel="48kHz"
        device={device}
        committed={cachedInfo?.eq?.hp}
        sendTo={sendTo}
      />
    </>
  )
}

// ---------------------------------------------------------------------
// ESP-NOW: stream statistics readout (debug / field verification)
// Read-only. Fetches from get_info.stream object. Manually refreshed
// to avoid overloading the serial link with frequent polling.
// ---------------------------------------------------------------------

export function EspNowStreamReadout({
  cachedInfo,
  onRefresh,
  disabled,
}: {
  cachedInfo?: NodeConfigInfo
  onRefresh: () => void
  disabled?: boolean
}) {
  const s = cachedInfo?.stream
  const total = (s?.received ?? 0) + (s?.lost ?? 0)
  const lossRate = total > 0 ? ((s?.lost ?? 0) / total) * 100 : null

  const Row = ({ label, value }: { label: string; value: React.ReactNode }) => (
    <div className="form-row" style={{ paddingBlock: 2 }}>
      <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>{label}</label>
      <span className="mono" style={{ fontSize: 12 }}>{value ?? '—'}</span>
      <span />
    </div>
  )

  return (
    <div className="form-section">
      <div className="form-section-title" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span>ストリーム統計（デバッグ用）</span>
        <button
          className="form-button-secondary"
          style={{ fontSize: 11, padding: '2px 8px' }}
          onClick={onRefresh}
          disabled={disabled}
        >
          更新
        </button>
      </div>
      {s == null ? (
        <div className="form-status muted">
          「更新」を押すと get_info からストリーム統計を取得します。
        </div>
      ) : (
        <>
          <Row
            label="損失率（電波強度目安）"
            value={lossRate != null ? `${lossRate.toFixed(1)} %` : '—'}
          />
          <Row label="受信" value={s.received} />
          <Row label="ロスト" value={s.lost} />
          <Row label="回復（piggyback）" value={s.recovered} />
          <Row label="ドロップ" value={s.dropped} />
          <Row label="最大連続欠落" value={s.max_gap} />
          <Row label="送信元切替" value={s.handoffs} />
          <Row label="生存送信元数" value={s.sources} />
          <Row label="ロック中" value={s.locked != null ? (s.locked ? 'はい' : 'いいえ') : undefined} />
          {s.locked && s.locked_mac && (
            <Row label="ロック先 MAC" value={<span style={{ fontSize: 10 }}>{s.locked_mac}</span>} />
          )}
          <Row label="推定遅延" value={s.delay_ms != null ? `${s.delay_ms} ms` : undefined} />
        </>
      )}
    </div>
  )
}
