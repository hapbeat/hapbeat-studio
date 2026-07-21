import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgcInfo, DeviceInfo, DrcInfo, DspProfileInfo, EqBandReadout, ManagerMessage, MqttClientEntry, SensorColorMatch, SensorMapping, SensorReading } from '@/types/manager'
import { useLibraryStore } from '@/stores/libraryStore'
import { useMqttTopicsStore, sanitizeTopic } from '@/stores/mqttTopicsStore'
import {
  useDuoWlV4AudioStore,
  type DuoWlV4AgcValue,
  type DuoWlV4AudioSnapshot,
  type DuoWlV4BeepValue,
  type DuoWlV4DrcValue,
  type DuoWlV4DspProfile,
  type DuoWlV4InputMode,
  type DuoWlV4NumericField,
} from '@/stores/duoWlV4AudioStore'
import { useToast } from '@/components/common/Toast'
import { downloadTextFile } from '@/utils/download'
import { clampOpusComplexity, clampHpBufferMs } from '@/utils/solidTransmitterTuning'
import {
  computeAic3204Eq,
  aic3204CoeffsToArray,
  eqResponseCurve,
  type EqFtype,
  type EqCurvePoint,
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
    /** Stream jitter buffer, ms (set_stream_buffer). Applies to all UDP
     *  receivers; surfaced on the DuoWL v4 audio panel as the main
     *  headphone-music tuning knob. */
    stream_buffer_ms?: number
  }
  /** DuoWL v4 ESP-NOW hp48 receiver EQ state (audio-dsp-config.md §2,
   *  board === "duo_wl_v4" only). fc/Q/gain aren't recoverable from the
   *  committed ints — only ftype + raw coeffs are reported. Up to 6 bands
   *  per codec (aic3204-full-dsp-registers.md §8.5 — was 3, now A..F). */
  eq?: {
    haptic: EqBandReadout[]
    hp: EqBandReadout[]
  }
  /** EQ engine backing `eq`/`set_eq_band` on THIS device: "sw" = software
   *  biquad on the 16kHz haptic mixer (necklace_v3 / band_v2/v3/v4 receivers,
   *  all transports — no hp codec, no DSP profiles, no IIR/DRC/3D/Beep).
   *  Absent on DuoWL v4 (AIC3204 in-codec biquad, gated by board instead).
   *  The presence-driven gate for the non-DuoWL-v4 haptic EQ UI (SwHapticEqSection). */
  eq_engine?: 'sw' | string
  /** A-V delay, ms, SIGNED (audio-dsp-config.md §3, DuoWL v4 ESP-NOW hp48
   *  receiver only): negative = delay the haptic ring relative to HP audio;
   *  positive = delay the HP (48k) ring relative to haptic; 0 = no offset.
   *  Range −100..+100. */
  av_delay_ms?: number
  /** DSP profile + capabilities per codec (aic3204-full-dsp-registers.md
   *  §0/§1, board === "duo_wl_v4" only). */
  dsp_profile?: {
    haptic: DspProfileInfo
    hp: DspProfileInfo
  }
  /** 1st-order IIR, raw [N0,N1,D1] Q1.23 ints per codec (§8.5, board ===
   *  "duo_wl_v4" only) — fully round-trips (no fc/Q abstraction). */
  eq_iir?: {
    haptic: [number, number, number]
    hp: [number, number, number]
  }
  /** DRC config + live status per codec (§2, board === "duo_wl_v4" only). */
  drc?: {
    haptic: DrcInfo
    hp: DrcInfo
  }
  /** 3D effect depth per codec, 0.0..1.0 (§4, board === "duo_wl_v4" only;
   *  only audible on profile "full"). */
  effect_3d?: {
    haptic: number
    hp: number
  }
  /** AGC config + applied-gain telemetry (§5, board === "duo_wl_v4" only). */
  agc?: AgcInfo
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
// set_headphone_volume / set_stream_buffer / set_input_mode, each taking an
// optional `persist` (default true; false = live preview, no NVS write).
// Readback via get_info.audio (+ av_delay_ms top-level, DuoWlV4EspNowAudioSection).
// ---------------------------------------------------------------------

const PAM_GAIN_STEPS = [6, 12, 18, 24] as const

function clampPamDb(v: number): number {
  if (!Number.isFinite(v)) return 24
  return PAM_GAIN_STEPS.reduce(
    (best, step) => (Math.abs(step - v) < Math.abs(best - v) ? step : best),
    PAM_GAIN_STEPS[0] as number,
  )
}
function clampLineoutDb(v: number): number {
  if (!Number.isFinite(v)) return 6
  return Math.max(-6, Math.min(29, Math.round(v)))
}
function clampBoostDb(v: number): number {
  if (!Number.isFinite(v)) return 0
  return Math.max(0, Math.min(24, Math.round(v)))
}
function clampHpDb(v: number): number {
  if (!Number.isFinite(v)) return -10
  return Math.max(-59, Math.min(4, Math.round(v)))
}
function clampBufferMs(v: number): number {
  if (!Number.isFinite(v)) return 0
  return Math.max(0, Math.min(200, Math.round(v)))
}
function clampAvDelayMs(v: number): number {
  if (!Number.isFinite(v)) return 0
  return Math.max(-100, Math.min(100, Math.round(v)))
}

// ---------------------------------------------------------------------
// Device-backed control behavior (shared by every DuoWL v4 audio-tab
// slider/toggle): the DEVICE is the source of truth (`deviceValue`), but a
// local edit stays "dirty" (git-diff-like: edited/not-yet-persisted) until
// explicitly committed, so an in-flight get_info refresh never clobbers
// what the user is mid-way through typing/dragging. `state` is EXTERNAL
// (not local useState) — every caller here backs it with
// `useDuoWlV4AudioStore` (duoWlV4AudioStore.ts) so the draft survives
// switching between the 音声/EQ sub-tabs and is reachable by the JSON
// export/import pair (DuoWlV4SettingsBackup).
//
//   - onInput(v): live preview — updates the shown value immediately,
//     marks dirty, and after `debounceMs` of no further input sends
//     persist:false (device previews the change without an NVS write).
//   - commit(v?): sends persist:true immediately (cancels any pending
//     debounce) and clears dirty. Sliders wire this to pointer-up/blur;
//     discrete controls (buttons) call it directly with no `onInput` at
//     all — "send persist:true immediately on click, no debounce".
// ---------------------------------------------------------------------

interface DeviceBackedState<T> {
  value: T
  dirty: boolean
  setState: (value: T, dirty: boolean) => void
}

function useDeviceBackedValue<T>(
  deviceValue: T | undefined,
  state: DeviceBackedState<T>,
  send: (v: T, persist: boolean) => void,
  opts?: {
    debounceMs?: number
    syncTick?: number
    /**
     * Equality check used to decide "did the device value actually change /
     * does it already match the local value" — defaults to reference
     * equality (`===`), which is correct for primitives (number/string) and
     * for values that are read straight off the store/cache BY REFERENCE
     * (e.g. an array pulled directly off `cachedInfo`, unchanged between
     * renders unless a new get_info snapshot lands).
     *
     * MUST be overridden with a structural comparator for any `deviceValue`
     * the CALLER constructs as a fresh object literal in the component body
     * (e.g. `cachedInfoField && { camelCase: cachedInfoField.snake_case,
     * ... }`) — that literal is a NEW reference every render regardless of
     * whether the underlying data changed, so reference equality here would
     * never be true and the adopt effect below would re-fire (setState →
     * new store object → selector identity changes → re-render → effect
     * re-fires again) every render, forever. Memoizing the literal with
     * `useMemo` at the call site is REQUIRED either way (this comparator
     * alone doesn't stop the caller from producing a new object each
     * render) — this is the second layer, so an accidental missing
     * `useMemo` degrades to "extra reconcile churn" instead of an infinite
     * loop.
     */
    isEqual?: (a: T, b: T) => boolean
  },
) {
  const { value, dirty, setState } = state
  const debounceMs = opts?.debounceMs ?? 280
  const syncTick = opts?.syncTick
  const isEqual = opts?.isEqual ?? ((a: T, b: T) => a === b)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Adopt the device's committed value ONLY while not locally dirty — this is
  // what makes the device authoritative without clobbering an edit. Keyed on
  // `syncTick` in ADDITION to `deviceValue` so a fresh get_info snapshot
  // reconciles the local value even when the device echoed the SAME number as
  // before (e.g. it clamped a write back to its prior value): the value alone
  // wouldn't change, so a value-keyed effect would leave Studio showing a
  // figure the device doesn't actually hold. The same-value guard keeps this
  // idempotent (no redundant store write when already in sync), and NOT
  // depending on value/dirty is deliberate — re-running on a local edit is
  // exactly what we must avoid.
  useEffect(() => {
    if (deviceValue === undefined || dirty) return
    if (isEqual(value, deviceValue)) return
    setState(deviceValue, false)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceValue, syncTick])

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current)
  }, [])

  const onInput = useCallback((v: T) => {
    setState(v, deviceValue === undefined ? true : !isEqual(v, deviceValue))
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      send(v, false)
    }, debounceMs)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceValue, send, debounceMs, setState])

  const commit = useCallback((v?: T) => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }
    const finalV = v !== undefined ? v : value
    setState(finalV, false)
    send(finalV, true)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, send, setState])

  return { value, dirty, onInput, commit }
}

/** Shallow structural equality for a flat record of primitives (booleans/
 *  numbers/strings) — the `isEqual` comparator for useDeviceBackedValue when
 *  T is a compound object the caller reconstructs each render (DRC/AGC
 *  values below), so a same-content-but-new-reference deviceValue doesn't
 *  re-trigger the adopt effect. Also correct (if unnecessary — those already
 *  pass a by-reference array) for a plain array like the IIR tuple, since
 *  `Object.keys` on an array yields its index strings. */
function shallowEqualRecord<T extends object>(a: T, b: T): boolean {
  const keysA = Object.keys(a) as Array<keyof T>
  const keysB = Object.keys(b)
  if (keysA.length !== keysB.length) return false
  for (const k of keysA) {
    if (a[k] !== b[k]) return false
  }
  return true
}

/** Store-backed numeric field for one DuoWL v4 device (pam/lineout/boost/
 *  hp/buffer/avDelay all share this — they only differ in which store slot
 *  and which `send` wire command they use). `syncTick` bumps once per
 *  get_info so a device echo reconciles even at an unchanged value (finding 3). */
function useDuoAudioField(
  ip: string,
  field: DuoWlV4NumericField,
  deviceValue: number | undefined,
  send: (v: number, persist: boolean) => void,
  syncTick?: number,
) {
  const value = useDuoWlV4AudioStore((s) => s.draftFor(ip)[field].value)
  const dirty = useDuoWlV4AudioStore((s) => s.draftFor(ip)[field].dirty)
  const setNumeric = useDuoWlV4AudioStore((s) => s.setNumeric)
  const setState = useCallback(
    (v: number, d: boolean) => setNumeric(ip, field, v, d),
    [ip, field, setNumeric],
  )
  return useDeviceBackedValue(deviceValue, { value, dirty, setState }, send, { syncTick })
}

/** Store-backed input_mode field (string enum, not numeric — same behavior). */
function useDuoInputModeField(
  ip: string,
  deviceValue: DuoWlV4InputMode | undefined,
  send: (v: DuoWlV4InputMode, persist: boolean) => void,
  syncTick?: number,
) {
  const value = useDuoWlV4AudioStore((s) => s.draftFor(ip).inputMode.value)
  const dirty = useDuoWlV4AudioStore((s) => s.draftFor(ip).inputMode.dirty)
  const setInputMode = useDuoWlV4AudioStore((s) => s.setInputMode)
  const setState = useCallback(
    (v: DuoWlV4InputMode, d: boolean) => setInputMode(ip, v, d),
    [ip, setInputMode],
  )
  return useDeviceBackedValue(deviceValue, { value, dirty, setState }, send, { syncTick })
}

/** Store-backed DSP profile field for one codec (same shape as
 *  useDuoInputModeField, generalized with a `codec` param). */
function useDuoDspProfileField(
  ip: string,
  codec: EqCodec,
  deviceValue: DuoWlV4DspProfile | undefined,
  send: (v: DuoWlV4DspProfile, persist: boolean) => void,
  syncTick?: number,
) {
  const field = codec === 'haptic' ? 'dspProfileHaptic' : 'dspProfileHp'
  const value = useDuoWlV4AudioStore((s) => s.draftFor(ip)[field].value)
  const dirty = useDuoWlV4AudioStore((s) => s.draftFor(ip)[field].dirty)
  const setDspProfile = useDuoWlV4AudioStore((s) => s.setDspProfile)
  const setState = useCallback(
    (v: DuoWlV4DspProfile, d: boolean) => setDspProfile(ip, codec, v, d),
    [ip, codec, setDspProfile],
  )
  return useDeviceBackedValue(deviceValue, { value, dirty, setState }, send, { syncTick })
}

/** Store-backed 1st-order IIR field for one codec — raw [N0,N1,D1] Q1.23
 *  ints, fully device-round-trippable (unlike the biquad bands), so this
 *  reuses useDeviceBackedValue directly over the 3-tuple. */
function useDuoIirField(
  ip: string,
  codec: EqCodec,
  deviceValue: [number, number, number] | undefined,
  send: (v: [number, number, number], persist: boolean) => void,
  syncTick?: number,
) {
  const field = codec === 'haptic' ? 'iirHaptic' : 'iirHp'
  const value = useDuoWlV4AudioStore((s) => s.draftFor(ip)[field].value)
  const dirty = useDuoWlV4AudioStore((s) => s.draftFor(ip)[field].dirty)
  const setIir = useDuoWlV4AudioStore((s) => s.setIir)
  const setState = useCallback(
    (v: [number, number, number], d: boolean) => setIir(ip, codec, v, d),
    [ip, codec, setIir],
  )
  return useDeviceBackedValue(deviceValue, { value, dirty, setState }, send, { syncTick })
}

/** Store-backed DRC field for one codec — the WHOLE config as one object
 *  (see DuoWlV4DrcValue doc: every control ships the full struct so no
 *  partial-edit can go stale between fields). */
function useDuoDrcField(
  ip: string,
  codec: EqCodec,
  deviceValue: DuoWlV4DrcValue | undefined,
  send: (v: DuoWlV4DrcValue, persist: boolean) => void,
  syncTick?: number,
) {
  const field = codec === 'haptic' ? 'drcHaptic' : 'drcHp'
  const value = useDuoWlV4AudioStore((s) => s.draftFor(ip)[field].value)
  const dirty = useDuoWlV4AudioStore((s) => s.draftFor(ip)[field].dirty)
  const setDrc = useDuoWlV4AudioStore((s) => s.setDrc)
  const setState = useCallback(
    (v: DuoWlV4DrcValue, d: boolean) => setDrc(ip, codec, v, d),
    [ip, codec, setDrc],
  )
  // isEqual: shallowEqualRecord — the caller (DrcPanel) reconstructs
  // `deviceValue` as a fresh camelCase object literal every render (mapping
  // from the snake_case DrcInfo cache), so reference equality would never
  // hold and the adopt effect would loop forever. See useDeviceBackedValue's
  // `isEqual` doc.
  return useDeviceBackedValue(deviceValue, { value, dirty, setState }, send, { syncTick, isEqual: shallowEqualRecord })
}

/** Store-backed AGC field (global, whole-object commit — same discipline as
 *  useDuoDrcField, including the shallowEqualRecord isEqual — see that
 *  function's comment). */
function useDuoAgcField(
  ip: string,
  deviceValue: DuoWlV4AgcValue | undefined,
  send: (v: DuoWlV4AgcValue, persist: boolean) => void,
  syncTick?: number,
) {
  const value = useDuoWlV4AudioStore((s) => s.draftFor(ip).agc.value)
  const dirty = useDuoWlV4AudioStore((s) => s.draftFor(ip).agc.dirty)
  const setAgc = useDuoWlV4AudioStore((s) => s.setAgc)
  const setState = useCallback(
    (v: DuoWlV4AgcValue, d: boolean) => setAgc(ip, v, d),
    [ip, setAgc],
  )
  return useDeviceBackedValue(deviceValue, { value, dirty, setState }, send, { syncTick, isEqual: shallowEqualRecord })
}

/** Store-backed 3D effect depth field for one codec. Dedicated hook (not
 *  useDuoAudioField/setNumeric) so it can flip `effect3dLoaded` — see
 *  DuoWlV4Draft.effect3dLoaded doc. `deviceValue` here is a plain number
 *  read straight off cachedInfo (not a reconstructed literal), so the
 *  default reference-equality isEqual is fine — no shallowEqualRecord needed. */
function useDuoEffect3dField(
  ip: string,
  codec: EqCodec,
  deviceValue: number | undefined,
  send: (v: number, persist: boolean) => void,
  syncTick?: number,
) {
  const field = codec === 'haptic' ? 'effect3dHaptic' : 'effect3dHp'
  const value = useDuoWlV4AudioStore((s) => s.draftFor(ip)[field].value)
  const dirty = useDuoWlV4AudioStore((s) => s.draftFor(ip)[field].dirty)
  const setEffect3d = useDuoWlV4AudioStore((s) => s.setEffect3d)
  const setState = useCallback(
    (v: number, d: boolean) => setEffect3d(ip, codec, v, d),
    [ip, codec, setEffect3d],
  )
  return useDeviceBackedValue(deviceValue, { value, dirty, setState }, send, { syncTick })
}

/**
 * Returns a debounced `scheduleReconcile()` — call it after every
 * persist:true commit. It coalesces a burst of commits into ONE get_info
 * (`onReconcile`, wired by the caller to the transport-correct refresh)
 * ~600ms after the last commit, so the device echoes its real value back and
 * the adopt-when-not-dirty effect (useDeviceBackedValue) reconciles. Without
 * this, "device is source of truth" only holds on the next unrelated refresh
 * (device switch / manual 読み込み), so a clamped/rejected write could sit
 * unreconciled in the UI (finding 3).
 */
function useReconcileScheduler(onReconcile: (() => void) | undefined) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cbRef = useRef(onReconcile)
  cbRef.current = onReconcile
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current) }, [])
  return useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      cbRef.current?.()
    }, 600)
  }, [])
}

/** Small trailing dirty marker, reused by every DuoWL v4 control. Always
 *  renders the same fixed-width span (layout-shift rule) — only the dot's
 *  visibility/tooltip changes, so no row ever shifts when a control goes
 *  dirty/clean. */
function DirtyMark({
  dirty,
  deviceValue,
  format,
}: {
  dirty: boolean
  deviceValue?: number | string
  format?: (v: number | string) => string
}) {
  const title = !dirty
    ? 'デバイスと一致'
    : deviceValue !== undefined
      ? `未保存（自動プレビュー中、適用で確定・デバイス値: ${format ? format(deviceValue) : deviceValue}）`
      : '未保存（自動プレビュー中、適用で確定）'
  return (
    <span
      className={`duo-dirty-mark${dirty ? ' is-dirty' : ''}`}
      title={title}
      aria-label={title}
    >
      {dirty ? '●' : ''}
    </span>
  )
}

export function DuoWlV4AudioSection({
  device,
  cachedInfo,
  sendTo,
  syncTick,
  onReconcile,
}: {
  device: DeviceInfo
  cachedInfo?: NodeConfigInfo
  sendTo: (msg: ManagerMessage) => void
  /** get_info counter — reconciles same-value device echoes (finding 3). */
  syncTick?: number
  /** Transport-correct get_info refresh, wired by DeviceDetail (finding 3). */
  onReconcile?: () => void
}) {
  const ip = device.ipAddress
  const audio = cachedInfo?.audio
  const { setAnchor } = useToast()
  const offline = !device.online
  const scheduleReconcile = useReconcileScheduler(onReconcile)

  // set_haptic_gain covers both the PAM select and the line-out slider — each
  // field's `send` re-reads the OTHER field's current draft value so a single
  // control's live-preview/commit always ships the wire command's required
  // pair (pam_db + lineout_db), never a stale half. On a persist:true commit
  // it ALSO clears the coupled field's dirty flag: the one wire command
  // persists BOTH values, so if the other field was mid-edit dirty its `●`
  // must clear too (otherwise it stays stuck until re-touched — finding 2).
  const pam = useDuoAudioField(ip, 'pamDb', audio?.pam_db, (v, persist) => {
    const store = useDuoWlV4AudioStore.getState()
    const lineoutVal = store.draftFor(ip).lineoutDb.value
    sendTo({ type: 'set_haptic_gain', payload: { pam_db: v, lineout_db: lineoutVal, persist } })
    if (persist) { store.setNumeric(ip, 'lineoutDb', lineoutVal, false); scheduleReconcile() }
  }, syncTick)
  const lineout = useDuoAudioField(ip, 'lineoutDb', audio?.lineout_db, (v, persist) => {
    const store = useDuoWlV4AudioStore.getState()
    const pamVal = store.draftFor(ip).pamDb.value
    sendTo({ type: 'set_haptic_gain', payload: { pam_db: pamVal, lineout_db: v, persist } })
    if (persist) { store.setNumeric(ip, 'pamDb', pamVal, false); scheduleReconcile() }
  }, syncTick)
  const boost = useDuoAudioField(ip, 'boostDb', audio?.boost_db, (v, persist) => {
    sendTo({ type: 'set_dac_boost', payload: { boost_db: v, persist } })
    if (persist) scheduleReconcile()
  }, syncTick)
  const hp = useDuoAudioField(ip, 'hpDb', audio?.hp_db, (v, persist) => {
    sendTo({ type: 'set_headphone_volume', payload: { hp_db: v, persist } })
    if (persist) scheduleReconcile()
  }, syncTick)
  const buffer = useDuoAudioField(ip, 'bufferMs', audio?.stream_buffer_ms, (v, persist) => {
    sendTo({ type: 'set_stream_buffer', payload: { buffer_ms: v, persist } })
    if (persist) scheduleReconcile()
  }, syncTick)
  const inputMode = useDuoInputModeField(ip, audio?.input_mode, (v, persist) => {
    sendTo({ type: 'set_input_mode', payload: { mode: v, persist } })
    if (persist) scheduleReconcile()
  }, syncTick)

  const applyHapticGain = (e: React.MouseEvent<HTMLElement>) => {
    setAnchor(e.currentTarget)
    // Single combined send (not pam.commit() + lineout.commit(), which would
    // each independently ship the full pam_db+lineout_db pair — correct but
    // sends set_haptic_gain to the device twice for one click). Clear both
    // fields' dirty flags directly since this one send covers both.
    sendTo({ type: 'set_haptic_gain', payload: { pam_db: pam.value, lineout_db: lineout.value, persist: true } })
    useDuoWlV4AudioStore.getState().setNumeric(ip, 'pamDb', pam.value, false)
    useDuoWlV4AudioStore.getState().setNumeric(ip, 'lineoutDb', lineout.value, false)
    scheduleReconcile()
  }
  const applyBoost = (e: React.MouseEvent<HTMLElement>) => {
    setAnchor(e.currentTarget)
    boost.commit()
  }
  const applyHpVolume = (e: React.MouseEvent<HTMLElement>) => {
    setAnchor(e.currentTarget)
    hp.commit()
  }
  const applyBuffer = (e: React.MouseEvent<HTMLElement>) => {
    setAnchor(e.currentTarget)
    buffer.commit()
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
          有線音声を入力して触覚に出す（DuoWL v4 専用）。discrete: クリックで
          即座に persist:true 送信（適用ボタンを待たない）。 */}
      <div className="form-row">
        <label>入出力モード</label>
        <div className="device-toggle" role="group" aria-label="input/output mode">
          <button
            type="button"
            className={`btn btn-sm device-toggle-btn ${inputMode.value === 'output' ? 'active' : ''}`}
            onClick={(e) => { setAnchor(e.currentTarget); inputMode.commit('output') }}
            disabled={offline}
          >
            出力（ヘッドホン）
          </button>
          <button
            type="button"
            className={`btn btn-sm device-toggle-btn ${inputMode.value === 'line_in' ? 'active' : ''}`}
            onClick={(e) => { setAnchor(e.currentTarget); inputMode.commit('line_in') }}
            disabled={offline}
          >
            入力（ライン入力）
          </button>
        </div>
        <DirtyMark dirty={inputMode.dirty} deviceValue={audio?.input_mode} />
      </div>
      {/* min-height reserved so this hint is always present — never shifts
          the rows below when inputMode changes (layout-shift rule). */}
      <div className="form-status muted" style={{ minHeight: 18, fontSize: 12 }}>
        {inputMode.value === 'line_in'
          ? 'ライン入力: ジャックからの有線音声を触覚として出力します。'
          : '出力: 通常のヘッドホン再生です。'}
      </div>

      {/* 1. PAM8404 power amp (coarse, drives the motors). discrete: クリックで
          即座に persist:true 送信（下の適用ボタンはライン出力との一括再送用）。 */}
      <div className="form-row">
        <label>触覚アンプ<br /><span style={{ fontSize: 11, color: 'var(--text-muted)' }}>PAM8404</span></label>
        <div className="device-toggle" role="group" aria-label="PAM8404 gain">
          {PAM_GAIN_STEPS.map((v) => (
            <button
              key={v}
              type="button"
              className={`btn btn-sm device-toggle-btn ${pam.value === v ? 'active' : ''}`}
              onClick={() => pam.commit(v)}
              disabled={offline}
            >
              {v} dB
            </button>
          ))}
        </div>
        <DirtyMark dirty={pam.dirty} deviceValue={audio?.pam_db} format={(v) => `${v} dB`} />
      </div>
      <div className="form-status muted" style={{ fontSize: 12 }}>パワーアンプの粗ゲイン。触覚モータを駆動（4 段）</div>

      {/* 2. AIC3204 (U1) line-out driver — analog pre-amp before the PAM.
          slider: ドラッグ中は persist:false でライブプレビュー、離した瞬間
          (pointer-up/blur) に persist:true でコミット。 */}
      <div className="form-row">
        <label>触覚ライン出力<br /><span style={{ fontSize: 11, color: 'var(--text-muted)' }}>AIC3204 U1</span></label>
        <div className="form-row-multi" style={{ alignItems: 'center', gap: 8 }}>
          <input
            type="range"
            min={-6}
            max={29}
            step={1}
            value={lineout.value}
            onChange={(e) => lineout.onInput(clampLineoutDb(Number(e.target.value)))}
            onPointerUp={() => lineout.commit()}
            onBlur={() => lineout.commit()}
            disabled={offline}
            style={{ flex: 1 }}
          />
          <span className="mono" style={{ width: 56, textAlign: 'right' }}>
            {lineout.value} dB
          </span>
        </div>
        <DirtyMark dirty={lineout.dirty} deviceValue={audio?.lineout_db} format={(v) => `${v} dB`} />
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
            value={boost.value}
            onChange={(e) => boost.onInput(clampBoostDb(Number(e.target.value)))}
            onPointerUp={() => boost.commit()}
            onBlur={() => boost.commit()}
            disabled={offline}
            style={{ flex: 1 }}
          />
          <span className="mono" style={{ width: 56, textAlign: 'right' }}>
            {boost.value} dB
          </span>
        </div>
        <DirtyMark dirty={boost.dirty} deviceValue={audio?.boost_db} format={(v) => `${v} dB`} />
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

      {/* 4. TPA6130A2 headphone amp (independent of the haptic path). Also
          followed live by SW4/SW5 button presses — DeviceDetail.tsx merges
          the pushed volume_changed.hp_db into cachedInfo.audio.hp_db, and
          the adopt-when-not-dirty rule above (useDeviceBackedValue) picks
          it up automatically. */}
      <div className="form-row" style={{ marginTop: 12 }}>
        <label>ヘッドホン音量<br /><span style={{ fontSize: 11, color: 'var(--text-muted)' }}>TPA6130A2</span></label>
        <div className="form-row-multi" style={{ alignItems: 'center', gap: 8 }}>
          <input
            type="range"
            min={-59}
            max={4}
            step={1}
            value={hp.value}
            onChange={(e) => hp.onInput(clampHpDb(Number(e.target.value)))}
            onPointerUp={() => hp.commit()}
            onBlur={() => hp.commit()}
            disabled={offline}
            style={{ flex: 1 }}
          />
          <span className="mono" style={{ width: 56, textAlign: 'right' }}>
            {hp.value} dB
          </span>
        </div>
        <DirtyMark dirty={hp.dirty} deviceValue={audio?.hp_db} format={(v) => `${v} dB`} />
      </div>
      <div className="form-status muted" style={{ fontSize: 12 }}>
        HP アンプ出力（触覚音量とは独立）／本体ボタン（再生モード時: 右上 SW4=+ / 右下 SW5=−）でも操作できます。ホイールは触覚音量のみ。
      </div>

      <div className="form-action-row" style={{ marginTop: 8 }}>
        <button className="form-button" onClick={applyHpVolume} disabled={offline}>
          ヘッドホン音量を適用
        </button>
      </div>
    </div>

    {/* Stream jitter buffer (set_stream_buffer). General to all UDP receivers;
        surfaced here as it's the main v4 headphone-music tuning knob. Now
        read back via get_info.audio.stream_buffer_ms (was write-only). */}
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
            className={`btn btn-sm device-toggle-btn ${buffer.value === 0 ? 'active' : ''}`}
            onClick={() => buffer.commit(0)}
            disabled={offline}
          >
            低遅延 0ms（触覚）
          </button>
          <button
            type="button"
            className={`btn btn-sm device-toggle-btn ${buffer.value === 120 ? 'active' : ''}`}
            onClick={() => buffer.commit(120)}
            disabled={offline}
          >
            音楽 120ms
          </button>
        </div>
        <DirtyMark dirty={buffer.dirty} deviceValue={audio?.stream_buffer_ms} format={(v) => `${v} ms`} />
      </div>
      <div className="form-row">
        <label>微調整</label>
        <div className="form-row-multi" style={{ alignItems: 'center', gap: 8 }}>
          <input
            type="range"
            min={0}
            max={200}
            step={10}
            value={buffer.value}
            onChange={(e) => buffer.onInput(clampBufferMs(Number(e.target.value)))}
            onPointerUp={() => buffer.commit()}
            onBlur={() => buffer.commit()}
            disabled={offline}
            style={{ flex: 1 }}
          />
          <span className="mono" style={{ width: 56, textAlign: 'right' }}>
            {buffer.value} ms
          </span>
        </div>
        <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
          0=低遅延（触覚向き）。大きいほど Wi-Fi のゆらぎで途切れにくいが、その分再生が遅れる（HP 音楽向き）。
        </span>
      </div>
      <div className="form-status muted" style={{ minHeight: 18, fontSize: 12 }}>
        ※ Wi-Fi UDP では常に有効。ESP-NOW では <b>SOLID48 (mode 9) 専用</b>です —
        SOLID48 選択中のみ既定 120ms よりこの値が優先され（送信機の fleet 設定(0xAC)があれば最優先）、
        他のモード (0-8) はモード別の固定バッファで動作しこの設定の影響を受けません。
        縮小も再生中に即反映されます。
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
// DuoWL v4 ESP-NOW hp48 receiver: A-V delay (audio-dsp-config.md §3).
// Shown on the ESP-NOW tab (not the 設定 tab, unlike DuoWlV4AudioSection
// above) because a pure-espnow_stream receiver has no 設定 tab
// (computeSubTabs in DeviceDetail.tsx) — this is the ESP-NOW-side
// counterpart, board === "duo_wl_v4" gated by the caller.
//
// HP volume used to be duplicated here (same `set_headphone_volume` wire
// command as DuoWlV4AudioSection's TPA6130A2 slider) because that section
// wasn't reachable from this tab. DuoWlV4AudioSection is now also rendered
// on the ESP-NOW tab (DeviceDetail.tsx), so this section is A-V-delay-only
// to avoid a duplicate HP-volume slider.
// ---------------------------------------------------------------------

export function DuoWlV4EspNowAudioSection({
  device,
  cachedInfo,
  sendTo,
  syncTick,
  onReconcile,
}: {
  device: DeviceInfo
  cachedInfo?: NodeConfigInfo
  sendTo: (msg: ManagerMessage) => void
  syncTick?: number
  onReconcile?: () => void
}) {
  const ip = device.ipAddress
  const { setAnchor } = useToast()
  const offline = !device.online
  const scheduleReconcile = useReconcileScheduler(onReconcile)

  const avDelay = useDuoAudioField(ip, 'avDelayMs', cachedInfo?.av_delay_ms, (v, persist) => {
    sendTo({ type: 'set_av_delay', payload: { ms: v, persist } })
    if (persist) scheduleReconcile()
  }, syncTick)

  const applyAvDelay = (e: React.MouseEvent<HTMLElement>) => {
    setAnchor(e.currentTarget)
    avDelay.commit()
  }

  // Dynamic hint (min-height reserved — layout-shift rule, changes on drag).
  const hintText = avDelay.value < 0
    ? `触覚を ${Math.abs(avDelay.value)}ms 遅延`
    : avDelay.value > 0
      ? `音声(HP)を ${avDelay.value}ms 遅延`
      : 'ディレイなし'

  return (
    <div className="form-section duo-v4-config">
      <div className="form-section-title">
        A-V ディレイ（DuoWL v4）
        <span className="form-section-sub-inline"> — 音声-触覚間ディレイ</span>
      </div>

      {/* A-V delay — SIGNED: negative delays haptic, positive delays HP audio
          (audio-dsp-config.md §3). slider: ドラッグ中は persist:false でライブ
          プレビュー、離した瞬間 (pointer-up/blur) に persist:true でコミット。 */}
      <div className="form-row">
        <label>A-V ディレイ</label>
        <div className="form-row-multi" style={{ alignItems: 'center', gap: 8 }}>
          <input
            type="range"
            min={-100}
            max={100}
            step={1}
            value={avDelay.value}
            onChange={(e) => avDelay.onInput(clampAvDelayMs(Number(e.target.value)))}
            onPointerUp={() => avDelay.commit()}
            onBlur={() => avDelay.commit()}
            disabled={offline}
            style={{ flex: 1 }}
          />
          <span className="mono" style={{ width: 64, textAlign: 'right' }}>
            {avDelay.value > 0 ? '+' : ''}{avDelay.value} ms
          </span>
        </div>
        <DirtyMark dirty={avDelay.dirty} deviceValue={cachedInfo?.av_delay_ms} format={(v) => `${v} ms`} />
      </div>
      {/* min-height reserved so this hint is always present — never shifts
          the description line below while dragging (layout-shift rule). */}
      <div className="form-status muted" style={{ minHeight: 18, fontSize: 12 }}>
        {hintText}
      </div>
      <div className="form-status muted" style={{ fontSize: 12 }}>
        負の値: 触覚を音声（ヘッドホン）に対して遅らせます。正の値: 音声を触覚に対して遅らせます（モーターの反応が遅いぶん、音声側を遅らせて合わせる）。0=遅延なし。
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
// config.md §2, extended by aic3204-full-dsp-registers.md §8.5/§9). Up to 6
// AIC3204 in-codec biquads per codec (haptic 16kHz / hp 48kHz) — the exact
// usable count depends on the codec's selected DSP profile (3/5/6, see
// DSP_PROFILE_CAPS below); bands beyond the active count are still
// accepted/stored by the firmware (harmless, per the reference doc) so they
// stay editable here too, just visually marked inert. Each band's fc/Q/gain
// are LOCAL design controls — the device only persists/reports ftype + the
// committed raw Q1.23 ints (get_info.eq), which aren't invertible back to
// fc/Q/gain — so this editor doesn't try to resync those from the device;
// it shows the committed ints read-only alongside the (locally-held) design
// controls.
// ---------------------------------------------------------------------

type EqCodec = 'haptic' | 'hp'

interface EqBandDraft {
  ftype: EqFtype
  fc: number
  q: number
  gainDb: number
}

/** Fixed max band count — the device always reports/accepts this many
 *  (DUO_V4_EQ_BANDS = 6, A..F). The ACTIVE (usable) count for a given codec
 *  depends on its current DSP profile — see DSP_PROFILE_CAPS. */
const EQ_BAND_COUNT = 6
const EQ_FS: Record<EqCodec, number> = { haptic: 16000, hp: 48000 }
/** RBJ Q for a 2nd-order Butterworth response (1/√2). */
const EQ_BUTTERWORTH_Q = 1 / Math.sqrt(2)

/**
 * DSP profile selector (aic3204-full-dsp-registers.md §0/§1/§9). The raw
 * AIC3204 PRB number is never exposed to Studio — only these 4 verified
 * "profile" names, each a Filter-A stereo Processing Block so switching
 * never touches AOSR/DOSR/NDAC/MDAC. Capabilities below are firmware's own
 * `aic3204GetProfileCaps()` lookup table (aic3204.cpp), reproduced here so
 * the profile buttons can show a capability summary BEFORE get_info answers
 * (get_info.dsp_profile.<codec> is still the live/authoritative source once
 * connected — see DspProfileSelector).
 */
const DSP_PROFILE_OPTIONS: Array<{
  value: DuoWlV4DspProfile
  label: string
  desc: string
}> = [
  { value: 'standard', label: 'standard', desc: '3band EQ（既定・現行）' },
  { value: 'eq6', label: 'eq6', desc: '6band EQ + 1次IIR' },
  { value: 'eq6_drc', label: 'eq6_drc', desc: '6band EQ + 1次IIR + DRC' },
  { value: 'full', label: 'full', desc: '5band EQ + IIR + DRC + 3D + Beep' },
]

const DSP_PROFILE_CAPS: Record<DuoWlV4DspProfile, DspProfileInfo> = {
  standard: { profile: 'standard', bands: 3, has_iir: false, has_drc: false, has_3d: false, has_beep: false },
  eq6: { profile: 'eq6', bands: 6, has_iir: true, has_drc: false, has_3d: false, has_beep: false },
  eq6_drc: { profile: 'eq6_drc', bands: 6, has_iir: true, has_drc: true, has_3d: false, has_beep: false },
  full: { profile: 'full', bands: 5, has_iir: true, has_drc: true, has_3d: true, has_beep: true },
}

/**
 * One codec's capability summary — LIVE get_info.dsp_profile when connected,
 * falling back to the static DSP_PROFILE_CAPS lookup keyed on the locally-
 * drafted profile selection (so gating is correct even before the first
 * get_info answers, and stays consistent whether read from the EQ tab
 * (DuoWlV4EqCodecBlock) or the DSP tab (DuoWlV4DspSection's DRC/3D/Beep
 * panels) — both need the SAME answer for "does this codec's current
 * profile support X". */
function useDspProfileCaps(ip: string, codec: EqCodec, cachedInfo?: NodeConfigInfo): DspProfileInfo {
  const field = codec === 'haptic' ? 'dspProfileHaptic' : 'dspProfileHp'
  const localProfile = useDuoWlV4AudioStore((s) => s.draftFor(ip)[field].value)
  return cachedInfo?.dsp_profile?.[codec] ?? DSP_PROFILE_CAPS[localProfile]
}

/** haptic band0 default = 100Hz 2nd-order Butterworth LPF (audio-dsp-
 *  config.md §2 "既定 EQ" — matches the DuoWL v4 (AIC3204 in-codec biquad)
 *  BT product / firmware boot default) ONLY. Every other band defaults to
 *  off (passthrough).
 *
 *  `allOff` forces band0 off too — the non-DuoWL-v4 software haptic EQ
 *  (SwHapticEqSection) firmware boots ALL 3 bands off (no fleet-wide 100Hz
 *  LPF default there; don't change existing fleet behavior). Without this,
 *  a fresh v3 device's UNTOUCHED draft showed a 100Hz-LPF design that was
 *  never actually applied (get_info.eq's committed readout reports off,
 *  nothing auto-sends — cosmetic, but misleading; review finding). */
function defaultEqDraft(codec: EqCodec, band: number, allOff = false): EqBandDraft {
  if (!allOff && codec === 'haptic' && band === 0) {
    return { ftype: 'lpf', fc: 100, q: EQ_BUTTERWORTH_Q, gainDb: 0 }
  }
  return { ftype: 'off', fc: 1000, q: EQ_BUTTERWORTH_Q, gainDb: 0 }
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

/**
 * Free-typing numeric field for fc/Q/gain. Holds an uncontrolled draft
 * STRING in local state that updates on every keystroke with NO clamping —
 * the previous `type="number"` + clamp-on-every-onChange snapped mid-edit
 * values back immediately (e.g. typing "0.1" → delete "1" → "0." → the
 * clamp re-snapped to 0.1, so "0.7" could never be typed). The draft is
 * only parsed + committed (via `onCommit`, which the caller wires to
 * clampEqFc/clampEqQ/clampEqGainDb + onChange) on blur or Enter; Escape
 * reverts to the last committed `value`. Mirrors the proven
 * IntensityValueEditor pattern (IntensityControl.tsx) but stays always-
 * visible (not click-to-edit) since these fields are edited far more often.
 * `type="text"` (not "number") also removes the native spinner arrows.
 */
function EqNumberField({
  value,
  onCommit,
  disabled,
  width,
}: {
  value: number
  /** Applies the value (caller clamps) and RETURNS the clamped value so the
   *  field can normalize its shown text — needed because if the clamped value
   *  equals the current `value` (e.g. typing "999" for a Q already at max 20),
   *  the `value` prop doesn't change, so the useEffect below never re-fires and
   *  the raw over-range text would otherwise stay in the box. */
  onCommit: (v: number) => number
  disabled?: boolean
  width: number
}) {
  const [draft, setDraft] = useState(String(value))

  // External changes (preset load, device switch reset) refresh the shown text.
  useEffect(() => {
    setDraft(String(value))
  }, [value])

  const commit = () => {
    const n = Number(draft)
    if (!Number.isFinite(n)) {
      setDraft(String(value))
      return
    }
    // Normalize the box to the clamped value the caller actually applied, so an
    // out-of-range entry never lingers as raw text even when the clamp is a no-op.
    setDraft(String(onCommit(n)))
  }

  return (
    <input
      className="form-input mono"
      type="text"
      inputMode="decimal"
      value={draft}
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          commit()
          e.currentTarget.blur()
        } else if (e.key === 'Escape') {
          setDraft(String(value))
          e.currentTarget.blur()
        }
      }}
      style={{ width }}
    />
  )
}

/** One band's edit row: ftype/fc/Q/gain controls + a fixed-height
 *  computed-coefficient / warning readout + the per-band 適用 button. */
function EqBandEditor({
  codec,
  band,
  draft,
  committed,
  offline,
  active,
  onChange,
  onApply,
}: {
  codec: EqCodec
  band: number
  draft: EqBandDraft
  committed?: EqBandReadout
  offline: boolean
  /** Whether this band index is within the codec's CURRENT DSP profile's
   *  usable band count (DSP_PROFILE_CAPS.bands). Bands beyond it are still
   *  fully editable/stored (per aic3204-full-dsp-registers.md §9 — writing
   *  unused biquad RAM is harmless) — this only dims the row and notes it,
   *  never disables or hides it (spec: mark inert, don't hide). */
  active: boolean
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
    <div
      className="form-row"
      style={{ marginTop: band === 0 ? 6 : 14, alignItems: 'flex-start', opacity: active ? 1 : 0.45 }}
      title={active ? undefined : 'このプロファイルでは無効なバンドです（値は保存されますが再生には反映されません）'}
    >
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
            <EqNumberField
              value={draft.fc}
              onCommit={(v) => { const c = clampEqFc(v, fs); onChange({ ...draft, fc: c }); return c }}
              disabled={offline || isOff}
              width={72}
            />
            Hz
          </label>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, opacity: isOff ? 0.4 : 1 }}>
            Q
            <EqNumberField
              value={draft.q}
              onCommit={(v) => { const c = clampEqQ(v); onChange({ ...draft, q: c }); return c }}
              disabled={offline || isOff}
              width={60}
            />
          </label>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, opacity: showGain ? 1 : 0.4 }}>
            gain
            <EqNumberField
              value={draft.gainDb}
              onCommit={(v) => { const c = clampEqGainDb(v); onChange({ ...draft, gainDb: c }); return c }}
              disabled={offline || !showGain}
              width={60}
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
          {!active ? 'このプロファイルでは無効（値は保存されるのみ）・ ' : ''}
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

// ---------------------------------------------------------------------
// Frequency-response graph (inline SVG, no chart lib). Plots the COMBINED
// cascade magnitude from eqResponseCurve (aic3204Eq.ts) — log-spaced
// 20Hz..fs/2 on X, fixed −24..+24 dB on Y (points are clamped into that
// range for display only; the design itself isn't clamped here — the
// per-band status line below already surfaces the real Q1.23 overflow/
// clamp warning). Updates live as fc/Q/gain/ftype change (caller passes a
// freshly-computed curve via useMemo).
// ---------------------------------------------------------------------

const EQ_GRAPH_W = 600
const EQ_GRAPH_H = 120
const EQ_GRAPH_PAD = { l: 32, r: 8, t: 8, b: 16 }
const EQ_GRAPH_DB_MIN = -24
const EQ_GRAPH_DB_MAX = 24
const EQ_GRAPH_F_MIN = 20
/** Visual Q range for a node's vertical axis on lpf/hpf/notch bands (drag
 *  up = higher Q / narrower notch / steeper slope). Deliberately narrower
 *  than clampEqQ's full 0.1..20 range — this is the "by ear" useful span
 *  for a coarse drag; clampEqQ is still applied to the result, so a node
 *  pinned at the top/bottom edge always yields a valid, safe Q (fine values
 *  beyond this visual range remain reachable via the numeric field or the
 *  wheel nudge below). */
const EQ_GRAPH_Q_MIN = 0.1
const EQ_GRAPH_Q_MAX = 8
/** Node drag → device live-preview (persist:false) send delay. Same
 *  trailing-debounce convention as useDeviceBackedValue's onInput (used by
 *  every other DuoWL v4 audio slider above) — rapid pointermove/wheel
 *  events keep resetting this timer, and it only fires once motion pauses,
 *  so a smooth drag never floods the serial link. Shorter than that hook's
 *  280ms default: a direct-manipulation graph node reads as "live" and
 *  should catch up quickly once the pointer settles. Drag release / wheel
 *  tick's trailing settle both bypass this and commit immediately.
 */
const EQ_NODE_DRAG_DEBOUNCE_MS = 150
/** Per-wheel-tick Q nudge (mouse wheel over a node = fine resonance trim,
 *  independent of the node's drag axis — see EqResponseGraph). */
const EQ_NODE_WHEEL_Q_STEP = 0.1
/** Distinct per-band node colors, reused from the existing theme accent
 *  tokens (App.css :root) rather than the curve's own --accent, so a node
 *  always reads as a separate draggable handle from the line it sits on. */
const EQ_NODE_COLORS = [
  'var(--accent-light, #a78bfa)',
  'var(--warning, #ff9800)',
  'var(--success, #4caf50)',
  'var(--error, #f44336)',
  '#4dabf7',
  '#f06292',
] as const

function EqResponseGraph({
  curve,
  fs,
  drafts,
  offline,
  onDraftChange,
  onLiveSend,
  onCommitSend,
}: {
  curve: EqCurvePoint[]
  fs: number
  /** Current design drafts — used to place/color the draggable nodes (one
   *  per active band) on top of the curve. */
  drafts: EqBandDraft[]
  offline: boolean
  /** Local-only update of ONE band (fc + gainDb or fc + q, depending on
   *  ftype) — called on every drag move / wheel tick. Purely client-side:
   *  the curve and the numeric EqBandEditor rows re-render live from this,
   *  same as any other draft edit. */
  onDraftChange: (band: number, next: EqBandDraft) => void
  /** Device live-preview send (persist:false) — already debounced by this
   *  component; the caller just ships it. */
  onLiveSend: (band: number, next: EqBandDraft) => void
  /** Device commit send (persist:true) — drag release / wheel settle. */
  onCommitSend: (band: number, next: EqBandDraft) => void
}) {
  const fMax = fs / 2
  const plotW = EQ_GRAPH_W - EQ_GRAPH_PAD.l - EQ_GRAPH_PAD.r
  const plotH = EQ_GRAPH_H - EQ_GRAPH_PAD.t - EQ_GRAPH_PAD.b
  const logMin = Math.log10(EQ_GRAPH_F_MIN)
  const logMax = Math.log10(fMax)

  const xForF = (f: number) =>
    EQ_GRAPH_PAD.l + ((Math.log10(f) - logMin) / (logMax - logMin)) * plotW
  const fForX = (x: number) =>
    Math.pow(10, logMin + ((x - EQ_GRAPH_PAD.l) / plotW) * (logMax - logMin))
  const yForDb = (db: number) => {
    const c = Math.max(EQ_GRAPH_DB_MIN, Math.min(EQ_GRAPH_DB_MAX, db))
    return EQ_GRAPH_PAD.t + (1 - (c - EQ_GRAPH_DB_MIN) / (EQ_GRAPH_DB_MAX - EQ_GRAPH_DB_MIN)) * plotH
  }
  const dbForY = (y: number) =>
    EQ_GRAPH_DB_MIN + (1 - (y - EQ_GRAPH_PAD.t) / plotH) * (EQ_GRAPH_DB_MAX - EQ_GRAPH_DB_MIN)
  const yForQ = (q: number) => {
    const c = Math.max(EQ_GRAPH_Q_MIN, Math.min(EQ_GRAPH_Q_MAX, q))
    return EQ_GRAPH_PAD.t + (1 - (c - EQ_GRAPH_Q_MIN) / (EQ_GRAPH_Q_MAX - EQ_GRAPH_Q_MIN)) * plotH
  }
  const qForY = (y: number) =>
    EQ_GRAPH_Q_MIN + (1 - (y - EQ_GRAPH_PAD.t) / plotH) * (EQ_GRAPH_Q_MAX - EQ_GRAPH_Q_MIN)

  const pathD = curve
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${xForF(p.f).toFixed(1)},${yForDb(p.db).toFixed(1)}`)
    .join(' ')

  const dbTicks = [-24, -12, 0, 12, 24]
  // Decade gridlines, only where they actually fall inside this codec's range
  // (16kHz haptic's Nyquist is 8kHz, so 10kHz is dropped there).
  const freqTicks = [100, 1000, 10000].filter((f) => f > EQ_GRAPH_F_MIN && f < fMax)

  // ---- VST-style draggable nodes -------------------------------------
  // Pointer-capture drag (same convention as LogDrawer.tsx's resize handle):
  // setPointerCapture on pointerdown routes all subsequent move/up events to
  // THAT node regardless of where the cursor wanders (including outside the
  // svg bounds), so a fast/escaping drag can never leak onto a neighboring
  // node or leave state stuck mid-drag. `draggingBand` (state, for the
  // active-node visual) + `dragPointerIdRef` (ref, for correctness with the
  // captured pointer id) gate move/up so a stray hover-move on a
  // non-captured node is a no-op.
  const svgRef = useRef<SVGSVGElement>(null)
  const [draggingBand, setDraggingBand] = useState<number | null>(null)
  const dragPointerIdRef = useRef<number | null>(null)
  const liveSendTimers = useRef<Record<number, ReturnType<typeof setTimeout> | null>>({})

  useEffect(() => () => {
    for (const t of Object.values(liveSendTimers.current)) if (t) clearTimeout(t)
  }, [])

  const scheduleLiveSend = (band: number, next: EqBandDraft) => {
    const timers = liveSendTimers.current
    if (timers[band]) clearTimeout(timers[band]!)
    timers[band] = setTimeout(() => {
      timers[band] = null
      onLiveSend(band, next)
    }, EQ_NODE_DRAG_DEBOUNCE_MS)
  }
  const commitNow = (band: number, next: EqBandDraft) => {
    const timers = liveSendTimers.current
    if (timers[band]) { clearTimeout(timers[band]!); timers[band] = null }
    onCommitSend(band, next)
  }

  // Screen (clientX/Y) → viewBox coords. The svg is responsive-width +
  // fixed-px-height with preserveAspectRatio="none", so its rendered CSS
  // size is generally NOT EQ_GRAPH_W×EQ_GRAPH_H px — X and Y need their own
  // scale factors from the live bounding rect, not a shared 1:1 ratio.
  const clientToSvgPoint = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const svg = svgRef.current
    if (!svg) return null
    const rect = svg.getBoundingClientRect()
    if (!(rect.width > 0) || !(rect.height > 0)) return null
    return {
      x: (clientX - rect.left) * (EQ_GRAPH_W / rect.width),
      y: (clientY - rect.top) * (EQ_GRAPH_H / rect.height),
    }
  }

  // Pointer position → the next draft for `band`, per the spec: horizontal
  // always drives fc (inverse of the same log mapping the curve uses);
  // vertical drives gainDb for peaking/shelf, Q for lpf/hpf/notch. Guards
  // against NaN from a degenerate rect/pointer so a drag can never write a
  // non-finite fc/Q into state.
  const nextDraftForPoint = (draft: EqBandDraft, clientX: number, clientY: number): EqBandDraft | null => {
    const pt = clientToSvgPoint(clientX, clientY)
    if (!pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) return null
    const nextFc = clampEqFc(fForX(pt.x), fs)
    if (!Number.isFinite(nextFc)) return null
    if (EQ_GAIN_FTYPES.has(draft.ftype)) {
      const nextGain = clampEqGainDb(dbForY(pt.y))
      if (!Number.isFinite(nextGain)) return null
      return { ...draft, fc: nextFc, gainDb: nextGain }
    }
    const nextQ = clampEqQ(qForY(pt.y))
    if (!Number.isFinite(nextQ)) return null
    return { ...draft, fc: nextFc, q: nextQ }
  }

  const handleNodePointerDown = (band: number) => (e: React.PointerEvent<SVGCircleElement>) => {
    if (offline) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    dragPointerIdRef.current = e.pointerId
    setDraggingBand(band)
  }
  const handleNodePointerMove = (band: number, draft: EqBandDraft) => (e: React.PointerEvent<SVGCircleElement>) => {
    if (draggingBand !== band || dragPointerIdRef.current !== e.pointerId) return
    const next = nextDraftForPoint(draft, e.clientX, e.clientY)
    if (!next) return
    onDraftChange(band, next)
    scheduleLiveSend(band, next)
  }
  const handleNodeDragEnd = (band: number, draft: EqBandDraft) => (e: React.PointerEvent<SVGCircleElement>) => {
    if (draggingBand !== band || dragPointerIdRef.current !== e.pointerId) return
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* already released */ }
    dragPointerIdRef.current = null
    setDraggingBand(null)
    const next = nextDraftForPoint(draft, e.clientX, e.clientY) ?? draft
    onDraftChange(band, next)
    commitNow(band, next)
  }
  const handleNodeWheel = (band: number, draft: EqBandDraft) => (e: React.WheelEvent<SVGCircleElement>) => {
    if (offline) return
    e.preventDefault()
    const nextQ = clampEqQ(draft.q + (e.deltaY > 0 ? -EQ_NODE_WHEEL_Q_STEP : EQ_NODE_WHEEL_Q_STEP))
    const next: EqBandDraft = { ...draft, q: nextQ }
    onDraftChange(band, next)
    scheduleLiveSend(band, next)
  }

  return (
    // Capped width (was 100% of the whole config column — a 5:1 viewBox
    // stretched edge-to-edge read as an oddly wide banner). Still responsive
    // (max-width, not a fixed px) so it shrinks gracefully on narrow panels.
    <div style={{ maxWidth: 380, width: '100%' }}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${EQ_GRAPH_W} ${EQ_GRAPH_H}`}
        preserveAspectRatio="none"
        // touch-action:none — without it, a touch-drag on a node scrolls the
        // page instead of moving the node (spec requirement).
        style={{ width: '100%', height: EQ_GRAPH_H, display: 'block', marginBottom: 4, touchAction: 'none' }}
      >
        {dbTicks.map((db) => (
          <line
            key={`db-${db}`}
            x1={EQ_GRAPH_PAD.l} x2={EQ_GRAPH_W - EQ_GRAPH_PAD.r}
            y1={yForDb(db)} y2={yForDb(db)}
            stroke={db === 0 ? 'var(--border-light, #3a3a5e)' : 'var(--border, #2a2a4e)'}
            strokeWidth={db === 0 ? 1.2 : 1}
          />
        ))}
        {freqTicks.map((f) => (
          <line
            key={`f-${f}`}
            x1={xForF(f)} x2={xForF(f)}
            y1={EQ_GRAPH_PAD.t} y2={EQ_GRAPH_H - EQ_GRAPH_PAD.b}
            stroke="var(--border, #2a2a4e)"
            strokeWidth={1}
          />
        ))}
        <path d={pathD} fill="none" stroke="var(--accent, #7c5cbf)" strokeWidth={1.6} />
        {freqTicks.map((f) => (
          <text
            key={`fl-${f}`}
            x={xForF(f)} y={EQ_GRAPH_H - 4}
            textAnchor="middle" fontSize={9}
            fill="var(--text-muted, #adafba)"
          >
            {f >= 1000 ? `${f / 1000}k` : f}
          </text>
        ))}
        <text x={2} y={EQ_GRAPH_PAD.t + 8} fontSize={9} fill="var(--text-muted, #adafba)">+24</text>
        <text x={2} y={yForDb(0) + 3} fontSize={9} fill="var(--text-muted, #adafba)">0</text>
        <text x={2} y={EQ_GRAPH_H - EQ_GRAPH_PAD.b - 2} fontSize={9} fill="var(--text-muted, #adafba)">−24</text>

        {/* Draggable VST-style band nodes — one per ACTIVE band (ftype !==
            "off"; an off band has no coefficient to place, so no handle). */}
        {drafts.map((draft, band) => {
          if (draft.ftype === 'off' || !Number.isFinite(draft.fc)) return null
          const cx = xForF(draft.fc)
          const usesGainAxis = EQ_GAIN_FTYPES.has(draft.ftype)
          const cy = usesGainAxis ? yForDb(draft.gainDb) : yForQ(draft.q)
          if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null
          const color = EQ_NODE_COLORS[band % EQ_NODE_COLORS.length]
          const isDragging = draggingBand === band
          const moveHandler = handleNodePointerMove(band, draft)
          const dragEndHandler = handleNodeDragEnd(band, draft)
          return (
            <g key={band}>
              {/* Enlarged, invisible hit-area (r=12) — keeps the visible dot
                  small while staying easy to grab on trackpad/touch (spec:
                  nodes big enough to grab, ~r=6-8 visible). */}
              <circle
                cx={cx} cy={cy} r={12}
                fill="transparent"
                // pointerEvents:'all' is required here — SVG's default
                // pointer-events:visiblePainted does NOT hit-test a
                // transparent fill, so without this the invisible hit-area
                // would silently swallow no events at all.
                style={{
                  cursor: offline ? 'default' : isDragging ? 'grabbing' : 'grab',
                  touchAction: 'none',
                  pointerEvents: 'all',
                }}
                onPointerDown={handleNodePointerDown(band)}
                onPointerMove={moveHandler}
                onPointerUp={dragEndHandler}
                onPointerCancel={dragEndHandler}
                onWheel={handleNodeWheel(band, draft)}
              />
              <circle
                cx={cx} cy={cy} r={isDragging ? 9 : 7}
                fill={color}
                stroke="var(--bg-primary, #1a1a2e)"
                strokeWidth={1.5}
                style={{ pointerEvents: 'none' }}
              />
              <text
                x={cx} y={cy}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={8}
                fontWeight={700}
                fill="var(--bg-primary, #1a1a2e)"
                style={{ pointerEvents: 'none', userSelect: 'none' }}
              >
                {band}
              </text>
            </g>
          )
        })}
      </svg>
      <div style={{ fontSize: 10, color: 'var(--text-muted, #adafba)', marginBottom: 8 }}>
        ノードをドラッグ: 横=fc / 縦=gain・Q（ホイールで Q 微調整、離すと確定）
      </div>
    </div>
  )
}

/**
 * DSP profile selector, one per codec (aic3204-full-dsp-registers.md §0/§1).
 * Discrete 4-button group — commits (persist:true) immediately on click, no
 * separate 適用 button (matches the input-mode toggle's convention: a
 * profile SWITCH is a discrete action, not something you'd drag/preview).
 * Shows a capability summary line below the buttons, sourced from the LIVE
 * get_info.dsp_profile when connected, falling back to the verified static
 * DSP_PROFILE_CAPS lookup for the locally-selected profile before the first
 * get_info answers (so the summary is never blank).
 */
function DspProfileSelector({
  ip,
  codec,
  device,
  cachedInfo,
  sendTo,
  syncTick,
  onReconcile,
}: {
  ip: string
  codec: EqCodec
  device: DeviceInfo
  cachedInfo?: NodeConfigInfo
  sendTo: (msg: ManagerMessage) => void
  syncTick?: number
  onReconcile?: () => void
}) {
  const offline = !device.online
  const { setAnchor } = useToast()
  const scheduleReconcile = useReconcileScheduler(onReconcile)
  const deviceProfile = cachedInfo?.dsp_profile?.[codec]?.profile
  const profile = useDuoDspProfileField(
    ip,
    codec,
    deviceProfile,
    (v, persist) => {
      sendTo({ type: 'set_dsp_profile', payload: { codec, profile: v, persist } })
      if (persist) scheduleReconcile()
    },
    syncTick,
  )
  const caps = useDspProfileCaps(ip, codec, cachedInfo)
  const activeDesc = DSP_PROFILE_OPTIONS.find((o) => o.value === profile.value)?.desc ?? ''

  return (
    <div className="form-row" style={{ marginTop: 6, alignItems: 'flex-start' }}>
      <label>DSP プロファイル</label>
      <div className="form-row-multi" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
        <div className="device-toggle" role="group" aria-label="DSP profile">
          {DSP_PROFILE_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              className={`btn btn-sm device-toggle-btn ${profile.value === o.value ? 'active' : ''}`}
              onClick={(e) => { setAnchor(e.currentTarget); profile.commit(o.value) }}
              disabled={offline}
              title={o.desc}
            >
              {o.label}
            </button>
          ))}
        </div>
        <div className="form-status muted" style={{ minHeight: 16, fontSize: 11, margin: 0 }}>
          {activeDesc} — band {caps.bands} / IIR {caps.has_iir ? '○' : '×'} / DRC {caps.has_drc ? '○' : '×'} / 3D {caps.has_3d ? '○' : '×'} / Beep {caps.has_beep ? '○' : '×'}
        </div>
      </div>
      <DirtyMark dirty={profile.dirty} deviceValue={deviceProfile} />
    </div>
  )
}

/**
 * 1st-order IIR editor, one per codec (aic3204-full-dsp-registers.md §8.5).
 * Raw Q1.23 [N0,N1,D1] ints only — no fc/Q design abstraction is offered
 * (no verified RBJ-style recipe for a 1st-order shelf on this part; see
 * DuoWlV4Draft.iirHaptic doc). Rendered inside the EQ block, right after the
 * biquad bands, sharing the same visual language (EqNumberField + a fixed-
 * height status/apply row) — but unlike the biquad bands this field IS
 * device-backed (get_info.eq_iir round-trips the exact ints), so it commits
 * via useDeviceBackedValue + a 適用 button rather than the local-draft +
 * bulk-apply-only pattern the biquad bands use.
 */
function IirEditor({
  ip,
  codec,
  device,
  cachedInfo,
  hasIir,
  sendTo,
  syncTick,
  onReconcile,
}: {
  ip: string
  codec: EqCodec
  device: DeviceInfo
  cachedInfo?: NodeConfigInfo
  /** Whether the codec's CURRENT profile supports the IIR block (still
   *  editable/sendable when false — just marked inert, same "don't hide,
   *  don't disable" rule as the biquad bands beyond the active count). */
  hasIir: boolean
  sendTo: (msg: ManagerMessage) => void
  syncTick?: number
  onReconcile?: () => void
}) {
  const offline = !device.online
  const { setAnchor } = useToast()
  const scheduleReconcile = useReconcileScheduler(onReconcile)
  const deviceIir = cachedInfo?.eq_iir?.[codec]
  const iir = useDuoIirField(
    ip,
    codec,
    deviceIir,
    (v, persist) => {
      sendTo({ type: 'set_eq_iir', payload: { codec, coeffs: v, persist } })
      if (persist) scheduleReconcile()
    },
    syncTick,
  )
  const [n0, n1, d1] = iir.value
  const setCoeff = (idx: 0 | 1 | 2, v: number) => {
    const next: [number, number, number] = [n0, n1, d1]
    next[idx] = v
    iir.onInput(next)
  }

  return (
    <div
      className="form-row"
      style={{ marginTop: 14, alignItems: 'flex-start', opacity: hasIir ? 1 : 0.45 }}
      title={hasIir ? undefined : 'このプロファイルでは無効なブロックです（値は保存されるのみ）'}
    >
      <label>1次IIR</label>
      <div className="form-row-multi" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
            N0
            <EqNumberField
              value={n0}
              onCommit={(v) => { const c = Math.round(v); setCoeff(0, c); return c }}
              disabled={offline}
              width={90}
            />
          </label>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
            N1
            <EqNumberField
              value={n1}
              onCommit={(v) => { const c = Math.round(v); setCoeff(1, c); return c }}
              disabled={offline}
              width={90}
            />
          </label>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
            D1
            <EqNumberField
              value={d1}
              onCommit={(v) => { const c = Math.round(v); setCoeff(2, c); return c }}
              disabled={offline}
              width={90}
            />
          </label>
          <button
            type="button"
            className="form-button-secondary"
            onClick={(e) => { setAnchor(e.currentTarget); iir.commit() }}
            disabled={offline}
            style={{ marginLeft: 'auto', flexShrink: 0 }}
          >
            適用
          </button>
        </div>
        <div className="form-status muted" style={{ minHeight: 16, fontSize: 11, margin: 0 }}>
          {!hasIir && 'このプロファイルでは無効（値は保存されるのみ）・ '}
          raw Q1.23 int [N0,N1,D1]（H(z)=(N0+2N1z⁻¹)/(1−2D1z⁻¹) 想定・fc/Q 設計は未対応）
        </div>
      </div>
      <DirtyMark dirty={iir.dirty} deviceValue={deviceIir ? `${deviceIir[0]},${deviceIir[1]},${deviceIir[2]}` : undefined} />
    </div>
  )
}

function DuoWlV4EqCodecBlock({
  codec,
  title,
  fsLabel,
  subtitle,
  device,
  cachedInfo,
  committed,
  drafts,
  onDraftsChange,
  sendTo,
  syncTick,
  onReconcile,
  advanced = true,
}: {
  codec: EqCodec
  title: string
  fsLabel: string
  /** Overrides the auto-composed "AIC3204 in-codec biquad ×Nband（fsLabel）"
   *  sub-title text. Used by SwHapticEqSection (non-DuoWL-v4 software biquad
   *  — a different engine than the DuoWL v4 AIC3204 in-codec block). */
  subtitle?: string
  device: DeviceInfo
  cachedInfo?: NodeConfigInfo
  committed?: EqBandReadout[]
  drafts: EqBandDraft[]
  onDraftsChange: (drafts: EqBandDraft[]) => void
  sendTo: (msg: ManagerMessage) => void
  syncTick?: number
  onReconcile?: () => void
  /** false = the non-DuoWL-v4 software haptic EQ (SwHapticEqSection): hides
   *  the DSP profile selector and 1st-order IIR editor (neither exists on
   *  those boards — fixed 3-band SW biquad only) and treats every rendered
   *  band as active (no DSP-profile-driven band-count concept there).
   *  Defaults true so DuoWlV4EqSection (DuoWL v4) is unaffected. */
  advanced?: boolean
}) {
  const ip = device.ipAddress
  const offline = !device.online
  const { setAnchor } = useToast()
  const fs = EQ_FS[codec]
  const curve = useMemo(() => eqResponseCurve(drafts, fs, { points: 96 }), [drafts, fs])

  // Active band count for THIS codec's CURRENT profile (also gates the IIR
  // editor below via caps.has_iir) — see useDspProfileCaps. Only meaningful
  // when `advanced` (DuoWL v4) — the non-advanced (sw) caller has no DSP
  // profile concept at all, so every one of its (fixed 3) drafts is active.
  const caps = useDspProfileCaps(ip, codec, cachedInfo)
  const activeBandCount = advanced ? caps.bands : drafts.length

  // Shared by the numeric-field 適用 button AND the graph nodes — `persist`
  // and the exact `draft` to send are always passed explicitly (never read
  // off the `drafts` closure at call time) so an in-flight drag can never
  // ship a one-tick-stale value (React state updates are async).
  const sendBand = (band: number, persist: boolean, draft: EqBandDraft) => {
    const result = computeAic3204Eq({
      ftype: draft.ftype,
      fs,
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
        persist,
      },
    })
  }

  const applyBand = (band: number) => (e: React.MouseEvent<HTMLElement>) => {
    setAnchor(e.currentTarget)
    sendBand(band, true, drafts[band])
  }

  // Graph node wiring: onDraftChange only ever touches the ONE dragged
  // band (matches "only the dragged band is sent"); onLiveSend/onCommitSend
  // are the debounced persist:false / immediate persist:true device sends
  // EqResponseGraph already schedules — this block just forwards them to
  // the same `sendBand` the 適用 button uses.
  const handleNodeDraftChange = (band: number, next: EqBandDraft) => {
    onDraftsChange(drafts.map((d, idx) => (idx === band ? next : d)))
  }
  const handleNodeLiveSend = (band: number, next: EqBandDraft) => sendBand(band, false, next)
  const handleNodeCommitSend = (band: number, next: EqBandDraft) => sendBand(band, true, next)

  return (
    <div className="form-section duo-v4-config">
      <div className="form-section-title">
        {title}
        <span className="form-section-sub-inline"> — {subtitle ?? `AIC3204 in-codec biquad ×${drafts.length}band（${fsLabel}）`}</span>
      </div>
      {advanced && (
        <DspProfileSelector
          ip={ip}
          codec={codec}
          device={device}
          cachedInfo={cachedInfo}
          sendTo={sendTo}
          syncTick={syncTick}
          onReconcile={onReconcile}
        />
      )}
      <EqPresetBar codec={codec} device={device} drafts={drafts} onLoad={onDraftsChange} sendTo={sendTo} allOffDefault={!advanced} />
      <EqResponseGraph
        curve={curve}
        fs={fs}
        drafts={drafts}
        offline={offline}
        onDraftChange={handleNodeDraftChange}
        onLiveSend={handleNodeLiveSend}
        onCommitSend={handleNodeCommitSend}
      />
      {drafts.map((draft, i) => (
        <EqBandEditor
          key={i}
          codec={codec}
          band={i}
          draft={draft}
          committed={committed?.[i]}
          offline={offline}
          active={i < activeBandCount}
          onChange={(next) => onDraftsChange(drafts.map((d, idx) => (idx === i ? next : d)))}
          onApply={applyBand(i)}
        />
      ))}
      {advanced && (
        <IirEditor
          ip={ip}
          codec={codec}
          device={device}
          cachedInfo={cachedInfo}
          hasIir={caps.has_iir}
          sendTo={sendTo}
          syncTick={syncTick}
          onReconcile={onReconcile}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------
// EQ presets: localStorage-persisted save/load/delete + JSON export/import,
// PER CODEC (haptic and hp each get their own preset list + storage key —
// they're different filters at different sample rates, so bundling both
// under one "preset" forced a haptic tweak and a headphone tweak to always
// travel together). Presets/JSON only mutate the local drafts held by
// DuoWlV4EqSection — the device is never touched implicitly. The user still
// presses each band's 適用, or this bar's 適用 (this codec's up to 6 bands), to
// push drafts to the device (same discipline as the sensor-mapping JSON
// import above: load into the editor, apply explicitly).
// ---------------------------------------------------------------------

const EQ_PRESETS_STORAGE_KEYS: Record<EqCodec, string> = {
  haptic: 'hapbeat.studio.eqPresets.haptic',
  hp: 'hapbeat.studio.eqPresets.hp',
}

interface EqPreset {
  name: string
  bands: EqBandDraft[]
}

function loadEqPresets(codec: EqCodec): EqPreset[] {
  try {
    const raw = localStorage.getItem(EQ_PRESETS_STORAGE_KEYS[codec])
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    // Validate each element's shape — a corrupt or externally-written value must
    // not yield presets with an undefined name (bad <option> keys / blank rows).
    return (parsed as unknown[]).filter(
      (p): p is EqPreset =>
        !!p &&
        typeof p === 'object' &&
        typeof (p as EqPreset).name === 'string' &&
        (p as EqPreset).name.trim() !== '' &&
        Array.isArray((p as EqPreset).bands),
    )
  } catch {
    return []
  }
}

function saveEqPresetsToStorage(codec: EqCodec, presets: EqPreset[]): void {
  try {
    localStorage.setItem(EQ_PRESETS_STORAGE_KEYS[codec], JSON.stringify(presets))
  } catch {
    // localStorage full/unavailable — presets are a convenience, not critical state.
  }
}

/** Normalize one band from an untrusted source (preset/import) — falls back
 *  to the codec/band default on a missing or malformed field so a
 *  hand-edited JSON file can't crash the editor or send NaN to the device.
 *  `allOff` — see defaultEqDraft doc — forwarded to the fallback so a
 *  missing/malformed band0 for the sw haptic EQ falls back to off, not the
 *  DuoWL v4 100Hz-LPF default. */
function normalizeEqBandDraft(input: unknown, codec: EqCodec, band: number, allOff = false): EqBandDraft {
  const fallback = defaultEqDraft(codec, band, allOff)
  if (!input || typeof input !== 'object') return fallback
  const o = input as Partial<Record<keyof EqBandDraft, unknown>>
  const ftype = EQ_FTYPE_OPTIONS.some((opt) => opt.value === o.ftype) ? (o.ftype as EqFtype) : fallback.ftype
  const fc = typeof o.fc === 'number' ? clampEqFc(o.fc, EQ_FS[codec]) : fallback.fc
  const q = typeof o.q === 'number' ? clampEqQ(o.q) : fallback.q
  const gainDb = typeof o.gainDb === 'number' ? clampEqGainDb(o.gainDb) : fallback.gainDb
  return { ftype, fc, q, gainDb }
}

/** `bandCount` defaults to EQ_BAND_COUNT (6, DuoWL v4's AIC3204 in-codec
 *  biquad). Callers for the non-DuoWL-v4 software haptic EQ (SwHapticEqSection)
 *  pass 3 (SW_HAPTIC_EQ_BAND_COUNT) — a preset/import carrying more bands than
 *  the target simply has its extras ignored (`arr[i]` past bandCount is never
 *  read), and one carrying fewer is padded with `defaultEqDraft`, same as today.
 *  `allOff` — see defaultEqDraft doc — SwHapticEqSection passes true so an
 *  untouched/malformed band0 falls back to off (matching the v3 firmware's
 *  actual all-off boot default), not DuoWL v4's 100Hz-LPF default. */
function normalizeEqDrafts(
  input: unknown,
  codec: EqCodec,
  bandCount: number = EQ_BAND_COUNT,
  allOff = false,
): EqBandDraft[] {
  const arr = Array.isArray(input) ? input : []
  return Array.from({ length: bandCount }, (_, i) => normalizeEqBandDraft(arr[i], codec, i, allOff))
}

function EqPresetBar({
  codec,
  device,
  drafts,
  onLoad,
  sendTo,
  allOffDefault = false,
}: {
  codec: EqCodec
  device: DeviceInfo
  drafts: EqBandDraft[]
  onLoad: (bands: EqBandDraft[]) => void
  sendTo: (msg: ManagerMessage) => void
  /** Forwarded to normalizeEqDrafts on preset-select/JSON-import — see
   *  defaultEqDraft's `allOff` doc. true for the non-DuoWL-v4 software
   *  haptic EQ (SwHapticEqSection), so a preset/import missing/malformed
   *  band0 falls back to off instead of DuoWL v4's 100Hz-LPF default. */
  allOffDefault?: boolean
}) {
  const [presets, setPresets] = useState<EqPreset[]>(() => loadEqPresets(codec))
  const [selected, setSelected] = useState<string>('')
  const [importError, setImportError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const { setAnchor, toast } = useToast()
  const offline = !device.online
  const codecLabel = codec === 'haptic' ? '触覚' : 'ヘッドホン'
  // Actual band count for THIS block — 6 for DuoWL v4 (EQ_BAND_COUNT), 3 for
  // the non-DuoWL-v4 software haptic EQ (SwHapticEqSection passes 3-length
  // drafts). Read from `drafts` (not the EQ_BAND_COUNT constant) so labels/
  // renormalization stay correct for both callers without a separate prop.
  const bandCount = drafts.length

  // Reset the selected-preset label when the target device changes. The parent
  // (DuoWlV4EqSection) resets the drafts to defaults on device switch; without
  // this the dropdown would keep showing the previous device's preset name while
  // the editor/graph show defaults — and 適用 (which reads `drafts`, not
  // `selected`) would write defaults, contradicting the shown label.
  const deviceRef = useRef(device.ipAddress)
  useEffect(() => {
    if (deviceRef.current === device.ipAddress) return
    deviceRef.current = device.ipAddress
    setSelected('')
    setImportError(null)
  }, [device.ipAddress])

  const persist = (next: EqPreset[]) => {
    setPresets(next)
    saveEqPresetsToStorage(codec, next)
  }

  const handleSelectChange = (name: string) => {
    setSelected(name)
    if (!name) return
    const preset = presets.find((p) => p.name === name)
    if (!preset) return
    onLoad(normalizeEqDrafts(preset.bands, codec, bandCount, allOffDefault))
  }

  const handleSave = (e: React.MouseEvent<HTMLButtonElement>) => {
    setAnchor(e.currentTarget)
    const name = window.prompt('プリセット名を入力してください')
    const trimmed = name?.trim()
    if (!trimmed) return
    const next = [...presets.filter((p) => p.name !== trimmed), { name: trimmed, bands: drafts }]
    next.sort((a, b) => a.name.localeCompare(b.name))
    persist(next)
    setSelected(trimmed)
    toast(`プリセット「${trimmed}」を保存しました`, 'success')
  }

  const handleDelete = (e: React.MouseEvent<HTMLButtonElement>) => {
    setAnchor(e.currentTarget)
    if (!selected) return
    persist(presets.filter((p) => p.name !== selected))
    toast(`プリセット「${selected}」を削除しました`, 'success')
    setSelected('')
  }

  const handleExport = (e: React.MouseEvent<HTMLButtonElement>) => {
    setAnchor(e.currentTarget)
    const payload = { version: 1, codec, bands: drafts }
    downloadTextFile(`hapbeat-eq-${codec}-${Date.now()}.json`, JSON.stringify(payload, null, 2))
    toast('EQ 設定を JSON にエクスポートしました', 'success')
  }

  const handleImportFile = (file: File) => {
    const fr = new FileReader()
    fr.onload = () => {
      try {
        const parsed = JSON.parse(String(fr.result)) as unknown
        if (!parsed || typeof parsed !== 'object') throw new Error('不正な JSON です')
        const obj = parsed as Record<string, unknown>
        if (!Array.isArray(obj.bands)) {
          throw new Error('bands 配列が見つかりません')
        }
        onLoad(normalizeEqDrafts(obj.bands, codec, bandCount, allOffDefault))
        setImportError(null)
        setSelected('')
        toast('EQ 設定を JSON から読み込みました（未適用 — 「適用」で反映）', 'success')
      } catch (e) {
        setImportError(e instanceof Error ? e.message : 'JSON を解析できません')
        setTimeout(() => setImportError(null), 6000)
      }
    }
    fr.readAsText(file)
  }

  const applyAll = (e: React.MouseEvent<HTMLButtonElement>) => {
    setAnchor(e.currentTarget)
    drafts.forEach((draft, band) => {
      const result = computeAic3204Eq({
        ftype: draft.ftype,
        fs: EQ_FS[codec],
        fc: draft.fc,
        q: draft.q,
        gainDb: draft.gainDb,
      })
      sendTo({
        type: 'set_eq_band',
        payload: { codec, band, ftype: draft.ftype, coeffs: aic3204CoeffsToArray(result.coeffs), persist: true },
      })
    })
    toast(`${codecLabel} EQ ${bandCount} バンドをデバイスへ送信しました`, 'success')
  }

  return (
    <div className="form-section duo-v4-config">
      <div className="form-section-title">
        EQ プリセット
        <span className="form-section-sub-inline"> — 保存・呼び出し・JSON 共有（{codecLabel} {bandCount}band）</span>
      </div>
      <div className="form-row">
        <label>プリセット</label>
        <div className="form-row-multi" style={{ alignItems: 'center', gap: 8 }}>
          <select
            className="form-input"
            value={selected}
            onChange={(e) => handleSelectChange(e.target.value)}
            style={{ flex: 1 }}
          >
            <option value="">プリセットを選択…</option>
            {presets.map((p) => (
              <option key={p.name} value={p.name}>{p.name}</option>
            ))}
          </select>
          <button className="form-button-secondary" onClick={handleSave} style={{ flexShrink: 0 }}>
            保存
          </button>
          <button
            className="form-button-secondary"
            onClick={handleDelete}
            disabled={!selected}
            style={{ flexShrink: 0 }}
          >
            削除
          </button>
        </div>
        <span />
      </div>
      {/* Fixed-height status line (layout-shift rule): reserved even when idle
          so an import error never shifts the action row below. */}
      <div className="form-status muted" style={{ minHeight: 16, fontSize: 12 }}>
        {importError
          ? `⚠ インポート失敗: ${importError}`
          : '保存・呼び出し・読込は draft のみ変更します。デバイスへは下の各バンドの「適用」またはこの「適用」で反映してください。'}
      </div>

      <div className="form-action-row" style={{ marginTop: 8 }}>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,application/json"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) handleImportFile(f)
            e.target.value = '' // allow re-importing the same file
          }}
        />
        <button
          className="form-button-secondary"
          onClick={(e) => { setAnchor(e.currentTarget); fileInputRef.current?.click() }}
          title="JSON ファイルから EQ 設定を読み込む（適用ボタンで反映）"
        >
          JSON インポート
        </button>
        <button
          className="form-button-secondary"
          onClick={handleExport}
          title={`現在の${codecLabel} EQ 設定を JSON ファイルに保存`}
        >
          JSON エクスポート
        </button>
        <span style={{ flex: 1 }} />
        <button
          className="form-button"
          onClick={applyAll}
          disabled={offline}
          title={`${codecLabel} の ${bandCount} バンドをまとめてデバイスへ送信`}
        >
          適用
        </button>
      </div>
    </div>
  )
}

export function DuoWlV4EqSection({
  device,
  cachedInfo,
  sendTo,
  syncTick,
  onReconcile,
}: {
  device: DeviceInfo
  cachedInfo?: NodeConfigInfo
  sendTo: (msg: ManagerMessage) => void
  /** get_info counter — reconciles same-value device echoes (DSP profile /
   *  1st-order IIR device-backed fields, finding 3). */
  syncTick?: number
  /** Transport-correct get_info refresh, wired by DeviceDetail. */
  onReconcile?: () => void
}) {
  const ip = device.ipAddress

  // Local-only design state (fc/Q/gain aren't recoverable from the device) —
  // held in useDuoWlV4AudioStore (keyed per device IP), NOT local useState,
  // so it (a) survives switching between the 音声/EQ sub-tabs, which unmount
  // whichever isn't active, and (b) is reachable by the JSON export/import
  // pair on the 音声 tab (DuoWlV4SettingsBackup). normalizeEqDrafts fills an
  // empty/short/malformed raw array with the codec's defaults, so a device
  // never touched here still shows (and exports) sensible values.
  const rawHaptic = useDuoWlV4AudioStore((s) => s.draftFor(ip).eqHaptic)
  const rawHp = useDuoWlV4AudioStore((s) => s.draftFor(ip).eqHp)
  const setEq = useDuoWlV4AudioStore((s) => s.setEq)
  const hapticDrafts = useMemo(() => normalizeEqDrafts(rawHaptic, 'haptic'), [rawHaptic])
  const hpDrafts = useMemo(() => normalizeEqDrafts(rawHp, 'hp'), [rawHp])
  const setHapticDrafts = useCallback((next: EqBandDraft[]) => setEq(ip, 'haptic', next), [ip, setEq])
  const setHpDrafts = useCallback((next: EqBandDraft[]) => setEq(ip, 'hp', next), [ip, setEq])

  return (
    <>
      {/* Each codec block owns its own EqPresetBar (per-codec presets — see
          EqPresetBar above) rendered above its graph, so haptic and hp
          preset/save/load/JSON are fully independent. */}
      <DuoWlV4EqCodecBlock
        codec="haptic"
        title="触覚 EQ"
        fsLabel="16kHz"
        device={device}
        cachedInfo={cachedInfo}
        committed={cachedInfo?.eq?.haptic}
        drafts={hapticDrafts}
        onDraftsChange={setHapticDrafts}
        sendTo={sendTo}
        syncTick={syncTick}
        onReconcile={onReconcile}
      />
      <DuoWlV4EqCodecBlock
        codec="hp"
        title="ヘッドホン EQ"
        fsLabel="48kHz"
        device={device}
        cachedInfo={cachedInfo}
        committed={cachedInfo?.eq?.hp}
        drafts={hpDrafts}
        onDraftsChange={setHpDrafts}
        sendTo={sendTo}
        syncTick={syncTick}
        onReconcile={onReconcile}
      />
    </>
  )
}

// ---------------------------------------------------------------------
// Non-DuoWL-v4 (v3-family) haptic-only receivers: software biquad EQ.
// necklace_v3 / band_v2/v3/v4, over EITHER transport (espnow_stream OR
// wifi-udp) — `set_eq_band {codec:"haptic", band:0..2, ftype, coeffs, persist?}`
// runs as a plain SOFTWARE biquad on the 16kHz haptic mixer (no AIC3204, no
// hp codec, no DSP profiles, no IIR/DRC/3D/Beep). Gated purely on
// `cachedInfo.eq_engine === 'sw'` (presence-driven — no board allow-list to
// maintain) by the caller (DeviceDetail.tsx), not by this component.
//
// Reuses the EXACT same preset storage / graph / band-editor machinery as
// DuoWlV4EqCodecBlock — same Q1.23 wire coeffs, same fs (16000), so the
// per-codec haptic preset list (hapbeat.studio.eqPresets.haptic) is
// deliberately SHARED with DuoWL v4's 触覚 EQ block (a 100Hz LPF preset
// applies identically to both families).
// ---------------------------------------------------------------------

/** Fixed band count for the non-DuoWL-v4 software haptic EQ — these boards
 *  have no DSP-profile-driven variable band count (see DuoWlV4Draft's
 *  dsp_profile doc); it's always exactly 3. */
const SW_HAPTIC_EQ_BAND_COUNT = 3

/** Write-time draft default for the SW haptic EQ (v3 系列): band0 = LPF 200 Hz
 *  / Q 0.7071 (Butterworth), bands 1-2 off. The FIRMWARE boot default stays
 *  all-off (fleet-safe) — this only pre-fills a fresh editor so the first 適用
 *  writes the recommended motor LPF (user request 2026-07-21). Matches the
 *  device-side Btn4 preset (contracts audio-dsp-config.md §2.1). */
function swDefaultEqDrafts(): EqBandDraft[] {
  return Array.from({ length: SW_HAPTIC_EQ_BAND_COUNT }, (_, i) =>
    i === 0
      ? { ftype: 'lpf' as EqFtype, fc: 200, q: EQ_BUTTERWORTH_Q, gainDb: 0 }
      : defaultEqDraft('haptic', i, true),
  )
}

export function SwHapticEqSection({
  device,
  cachedInfo,
  sendTo,
  syncTick,
  onReconcile,
}: {
  device: DeviceInfo
  cachedInfo?: NodeConfigInfo
  sendTo: (msg: ManagerMessage) => void
  syncTick?: number
  onReconcile?: () => void
}) {
  const ip = device.ipAddress

  // Same store as DuoWL v4 (keyed per device IP, EqBandDraft[] shape is
  // identical) — a given IP is only ever one board family, so there's no
  // cross-contamination; normalizeEqDrafts pads/truncates to exactly 3.
  // Fresh editor (no store draft yet): pre-fill the write-time default
  // (band0 = LPF 200 Hz / Q 0.7071, see swDefaultEqDrafts) — the DEVICE
  // stays untouched until 適用 (firmware boot default = all off). Once the
  // user has edited (store draft exists), normalize with allOff fallbacks so
  // a malformed/partial entry degrades to off, not to a phantom design.
  const rawHaptic = useDuoWlV4AudioStore((s) => s.draftFor(ip).eqHaptic)
  const setEq = useDuoWlV4AudioStore((s) => s.setEq)
  const hapticDrafts = useMemo(() => {
    const hasRaw = Array.isArray(rawHaptic) && rawHaptic.length > 0
    if (!hasRaw) return swDefaultEqDrafts()
    return normalizeEqDrafts(rawHaptic, 'haptic', SW_HAPTIC_EQ_BAND_COUNT, true)
  }, [rawHaptic])
  const setHapticDrafts = useCallback((next: EqBandDraft[]) => setEq(ip, 'haptic', next), [ip, setEq])

  return (
    <DuoWlV4EqCodecBlock
      codec="haptic"
      title="触覚 EQ"
      fsLabel="16kHz"
      subtitle={`ソフトウェア biquad（ミキサー段）×${SW_HAPTIC_EQ_BAND_COUNT}band（16kHz）`}
      device={device}
      cachedInfo={cachedInfo}
      committed={cachedInfo?.eq?.haptic}
      drafts={hapticDrafts}
      onDraftsChange={setHapticDrafts}
      sendTo={sendTo}
      syncTick={syncTick}
      onReconcile={onReconcile}
      advanced={false}
    />
  )
}

// ---------------------------------------------------------------------
// DuoWL v4 ESP-NOW hp48 receiver: DSP sub-tab (aic3204-full-dsp-registers.md
// §2/§3/§4/§5) — DRC (compressor/limiter) + 3D effect + Beep (test tone) per
// codec, plus the global AGC (line-in / HP-codec ADC path). All device-backed
// (drc/effect_3d/agc round-trip losslessly through get_info) except Beep,
// which is fire-and-forget (no on-device config to reconcile against).
// ---------------------------------------------------------------------

/** DRC hold/attack/decay register-code → human-readable conversion
 *  (aic3204-full-dsp-registers.md §2's bit-field table — NOT SLAA557's prose,
 *  which disagrees by 10x). `fs` selects the codec's DAC word clock rate for
 *  the hold→ms conversion (16k haptic / 48k hp). */
function drcAttackDbPerSample(code: number): number {
  return 4.0 / Math.pow(2, code)
}
function drcDecayDbPerSample(code: number): number {
  return 1.5625e-2 / Math.pow(2, code)
}
/** null = code 0 = disabled (hold not confirmed as "0 word clocks", the
 *  reference doc lists code 0 as its own "無効" state, not 32·2⁰). */
function drcHoldMs(code: number, fs: number): number | null {
  if (code <= 0) return null
  return ((32 * Math.pow(2, code - 1)) / fs) * 1000
}

const DRC_HYSTERESIS_STEPS = [0, 1, 2, 3] as const

/** DuoWlV4DrcValue (camelCase) -> `set_drc` wire payload (audio-dsp-config
 *  field names). Shared by DrcPanel's device-backed send AND
 *  DuoWlV4SettingsBackup's bulk applyAll so the two can never drift apart. */
function drcValueToMessage(codec: EqCodec, v: DuoWlV4DrcValue, persist: boolean): ManagerMessage {
  return {
    type: 'set_drc',
    payload: {
      codec,
      enable_l: v.enableL,
      enable_r: v.enableR,
      threshold_db: v.thresholdDb,
      hysteresis_db: v.hysteresisDb,
      hold: v.hold,
      attack: v.attack,
      decay: v.decay,
      persist,
    },
  }
}

/** DuoWlV4AgcValue (camelCase) -> `set_agc` wire payload. Shared by AgcPanel
 *  and DuoWlV4SettingsBackup's bulk applyAll (see drcValueToMessage doc). */
function agcValueToMessage(v: DuoWlV4AgcValue, persist: boolean): ManagerMessage {
  return {
    type: 'set_agc',
    payload: {
      enable: v.enable,
      target_level_db: v.targetLevelDb,
      max_gain_db: v.maxGainDb,
      attack: v.attack,
      decay: v.decay,
      noise_threshold_db: v.noiseThresholdDb,
      hysteresis_db: v.hysteresisDb,
      persist,
    },
  }
}

/** get_info.drc.<codec> (DrcInfo, snake_case + live compressing_l/r) ->
 *  DuoWlV4DrcValue (camelCase, config-only). The INVERSE of drcValueToMessage
 *  minus the live status fields (those aren't part of the editable draft).
 *  Shared by DrcPanel's memoized deviceValue AND DuoWlV4SettingsBackup's
 *  export/import-fallback (adversarial review finding 2) — factored out so
 *  the mapping can't drift between the two call sites. */
function drcInfoToValue(info: DrcInfo): DuoWlV4DrcValue {
  return {
    enableL: info.enable_l,
    enableR: info.enable_r,
    thresholdDb: info.threshold_db,
    hysteresisDb: info.hysteresis_db,
    hold: info.hold,
    attack: info.attack,
    decay: info.decay,
  }
}

/** get_info.agc (AgcInfo, snake_case + applied-gain telemetry) ->
 *  DuoWlV4AgcValue (camelCase, config-only). See drcInfoToValue doc. */
function agcInfoToValue(info: AgcInfo): DuoWlV4AgcValue {
  return {
    enable: info.enable,
    targetLevelDb: info.target_level_db,
    maxGainDb: info.max_gain_db,
    attack: info.attack,
    decay: info.decay,
    noiseThresholdDb: info.noise_threshold_db,
    hysteresisDb: info.hysteresis_db,
  }
}

/** One codec's DRC (compressor/limiter) panel. Every control ships the
 *  FULL DuoWlV4DrcValue on commit (see that type's doc) — sliders debounce
 *  persist:false then commit persist:true on pointer-up (useDuoDrcField),
 *  the enable/hysteresis toggle buttons commit immediately. */
function DrcPanel({
  ip,
  codec,
  title,
  device,
  cachedInfo,
  sendTo,
  syncTick,
  onReconcile,
}: {
  ip: string
  codec: EqCodec
  title: string
  device: DeviceInfo
  cachedInfo?: NodeConfigInfo
  sendTo: (msg: ManagerMessage) => void
  syncTick?: number
  onReconcile?: () => void
}) {
  const offline = !device.online
  const { setAnchor } = useToast()
  const scheduleReconcile = useReconcileScheduler(onReconcile)
  const fs = EQ_FS[codec]
  const caps = useDspProfileCaps(ip, codec, cachedInfo)
  const deviceDrcInfo = cachedInfo?.drc?.[codec]
  // MUST be memoized on deviceDrcInfo (not rebuilt as a bare literal every
  // render) — this is `deviceValue` for useDeviceBackedValue, whose adopt
  // effect re-runs whenever this reference changes. An unmemoized literal is
  // a NEW object every render regardless of whether deviceDrcInfo changed,
  // which (even with the isEqual structural comparator below) still forces
  // the effect to re-run and diff on every render — memoizing here is what
  // makes the reference itself stable when nothing changed, so the effect
  // doesn't even need to run. See useDeviceBackedValue's `isEqual` doc.
  const deviceDrc: DuoWlV4DrcValue | undefined = useMemo(
    () => deviceDrcInfo && drcInfoToValue(deviceDrcInfo),
    [deviceDrcInfo],
  )
  const drc = useDuoDrcField(
    ip,
    codec,
    deviceDrc,
    (v, persist) => {
      sendTo(drcValueToMessage(codec, v, persist))
      if (persist) scheduleReconcile()
    },
    syncTick,
  )
  const v = drc.value
  // `disabled` is offline-only — a profile without DRC support does NOT
  // block editing (adversarial review finding 4): set_drc is always
  // accepted and cached/persisted by firmware regardless of the codec's
  // current profile (applied:false in the response, not a write failure),
  // and the status line below explicitly promises "値は保存され...反映され
  // ます" — disabling the controls would make that promise false and would
  // also be inconsistent with the "dim, don't disable" treatment already
  // given to inert EQ bands (EqBandEditor) and the IIR block (IirEditor).
  const disabled = offline
  const attackDb = drcAttackDbPerSample(v.attack)
  const decayDb = drcDecayDbPerSample(v.decay)
  const holdMs = drcHoldMs(v.hold, fs)

  return (
    <div className="form-section duo-v4-config">
      <div className="form-section-title">
        {title}
        <span className="form-section-sub-inline"> — DRC（コンプレッサ／リミッタ）</span>
      </div>
      {/* Fixed-height status line (layout-shift rule): always present. */}
      <div className="form-status muted" style={{ minHeight: 18, fontSize: 12 }}>
        {caps.has_drc
          ? '現在のプロファイルで有効です。'
          : `⚠ 現在のプロファイルは DRC 非対応です（eq6_drc / full を選択してください）。値は保存され、対応プロファイルに切り替えると反映されます。`}
      </div>

      {/* Dim (not disable) when the profile lacks DRC — same "still
          editable/stored, just inert" treatment as EQ bands beyond the
          active count / the IIR block, matching the status line's promise
          above. */}
      <div style={{ opacity: caps.has_drc ? 1 : 0.6 }}>
      <div className="form-row">
        <label>有効</label>
        <div className="device-toggle" role="group" aria-label="DRC enable L/R">
          <button
            type="button"
            className={`btn btn-sm device-toggle-btn ${v.enableL ? 'active' : ''}`}
            onClick={(e) => { setAnchor(e.currentTarget); drc.commit({ ...v, enableL: !v.enableL }) }}
            disabled={disabled}
          >
            L
          </button>
          <button
            type="button"
            className={`btn btn-sm device-toggle-btn ${v.enableR ? 'active' : ''}`}
            onClick={(e) => { setAnchor(e.currentTarget); drc.commit({ ...v, enableR: !v.enableR }) }}
            disabled={disabled}
          >
            R
          </button>
        </div>
        <DirtyMark dirty={drc.dirty} />
      </div>

      <div className="form-row">
        <label>しきい値</label>
        <div className="form-row-multi" style={{ alignItems: 'center', gap: 8 }}>
          <input
            type="range"
            min={-24}
            max={-3}
            step={3}
            value={v.thresholdDb}
            onChange={(e) => drc.onInput({ ...v, thresholdDb: Number(e.target.value) })}
            onPointerUp={() => drc.commit()}
            onBlur={() => drc.commit()}
            disabled={disabled}
            style={{ flex: 1 }}
          />
          <span className="mono" style={{ width: 56, textAlign: 'right' }}>{v.thresholdDb} dB</span>
        </div>
        <span />
      </div>

      <div className="form-row">
        <label>ヒステリシス</label>
        <div className="device-toggle" role="group" aria-label="DRC hysteresis">
          {DRC_HYSTERESIS_STEPS.map((step) => (
            <button
              key={step}
              type="button"
              className={`btn btn-sm device-toggle-btn ${v.hysteresisDb === step ? 'active' : ''}`}
              onClick={() => drc.commit({ ...v, hysteresisDb: step })}
              disabled={disabled}
            >
              {step} dB
            </button>
          ))}
        </div>
        <span />
      </div>

      <div className="form-row">
        <label>ホールド<br /><span style={{ fontSize: 11, color: 'var(--text-muted)' }}>raw code 0-15</span></label>
        <div className="form-row-multi" style={{ alignItems: 'center', gap: 8 }}>
          <input
            type="range"
            min={0}
            max={15}
            step={1}
            value={v.hold}
            onChange={(e) => drc.onInput({ ...v, hold: Number(e.target.value) })}
            onPointerUp={() => drc.commit()}
            onBlur={() => drc.commit()}
            disabled={disabled}
            style={{ flex: 1 }}
          />
          <span className="mono" style={{ width: 90, textAlign: 'right', fontSize: 11 }}>
            {v.hold}（{holdMs == null ? '無効' : `${holdMs.toFixed(1)} ms`}）
          </span>
        </div>
        <span />
      </div>

      <div className="form-row">
        <label>アタック<br /><span style={{ fontSize: 11, color: 'var(--text-muted)' }}>raw code 0-15</span></label>
        <div className="form-row-multi" style={{ alignItems: 'center', gap: 8 }}>
          <input
            type="range"
            min={0}
            max={15}
            step={1}
            value={v.attack}
            onChange={(e) => drc.onInput({ ...v, attack: Number(e.target.value) })}
            onPointerUp={() => drc.commit()}
            onBlur={() => drc.commit()}
            disabled={disabled}
            style={{ flex: 1 }}
          />
          <span className="mono" style={{ width: 110, textAlign: 'right', fontSize: 11 }}>
            {v.attack}（{attackDb.toFixed(4)} dB/sample）
          </span>
        </div>
        <span />
      </div>

      <div className="form-row">
        <label>ディケイ<br /><span style={{ fontSize: 11, color: 'var(--text-muted)' }}>raw code 0-15</span></label>
        <div className="form-row-multi" style={{ alignItems: 'center', gap: 8 }}>
          <input
            type="range"
            min={0}
            max={15}
            step={1}
            value={v.decay}
            onChange={(e) => drc.onInput({ ...v, decay: Number(e.target.value) })}
            onPointerUp={() => drc.commit()}
            onBlur={() => drc.commit()}
            disabled={disabled}
            style={{ flex: 1 }}
          />
          <span className="mono" style={{ width: 110, textAlign: 'right', fontSize: 11 }}>
            {v.decay}（{decayDb.toFixed(6)} dB/sample）
          </span>
        </div>
        <span />
      </div>
      </div>

      <div className="form-row">
        <label>圧縮中</label>
        <span className="mono" style={{ fontSize: 12 }}>
          L: {deviceDrcInfo?.compressing_l ? '● 圧縮中' : '－'} ／ R: {deviceDrcInfo?.compressing_r ? '● 圧縮中' : '－'}
        </span>
        <span />
      </div>
      <div className="form-status muted" style={{ fontSize: 11 }}>
        ※ get_info 取得時点のスナップショットです（連続読み出しは未対応・「デバイスから読み込み」で更新）。
      </div>
    </div>
  )
}

/** One codec's 3D effect depth (profile "full" only). */
function Effect3dPanel({
  ip,
  codec,
  title,
  device,
  cachedInfo,
  sendTo,
  syncTick,
  onReconcile,
}: {
  ip: string
  codec: EqCodec
  title: string
  device: DeviceInfo
  cachedInfo?: NodeConfigInfo
  sendTo: (msg: ManagerMessage) => void
  syncTick?: number
  onReconcile?: () => void
}) {
  const offline = !device.online
  const { setAnchor } = useToast()
  const caps = useDspProfileCaps(ip, codec, cachedInfo)
  const scheduleReconcile = useReconcileScheduler(onReconcile)
  const deviceValue = cachedInfo?.effect_3d?.[codec]
  const depth = useDuoEffect3dField(ip, codec, deviceValue, (v, persist) => {
    sendTo({ type: 'set_3d', payload: { codec, depth: v, persist } })
    if (persist) scheduleReconcile()
  }, syncTick)
  // `disabled` is offline-only — same reasoning as DrcPanel (adversarial
  // review finding 4): set_3d is always accepted/cached regardless of
  // profile, and the status line below promises the value is saved.
  const disabled = offline

  return (
    <div className="form-section duo-v4-config">
      <div className="form-section-title">
        {title}
        <span className="form-section-sub-inline"> — 3D エフェクト</span>
      </div>
      <div className="form-status muted" style={{ minHeight: 18, fontSize: 12 }}>
        {caps.has_3d
          ? '現在のプロファイルで有効です。'
          : '⚠ 現在のプロファイルは 3D 非対応です（full を選択してください）。値は保存され、full に切り替えると反映されます。'}
      </div>
      {/* Dim (not disable) when the profile lacks 3D — see DrcPanel's
          identical comment. */}
      <div style={{ opacity: caps.has_3d ? 1 : 0.6 }}>
      <div className="form-row">
        <label>深さ</label>
        <div className="form-row-multi" style={{ alignItems: 'center', gap: 8 }}>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={depth.value}
            onChange={(e) => depth.onInput(Number(e.target.value))}
            onPointerUp={() => depth.commit()}
            onBlur={() => depth.commit()}
            disabled={disabled}
            style={{ flex: 1 }}
          />
          <span className="mono" style={{ width: 56, textAlign: 'right' }}>{depth.value.toFixed(2)}</span>
        </div>
        <DirtyMark dirty={depth.dirty} deviceValue={deviceValue} format={(v) => Number(v).toFixed(2)} />
      </div>
      <div className="form-action-row" style={{ marginTop: 8 }}>
        <button
          className="form-button"
          onClick={(e) => { setAnchor(e.currentTarget); depth.commit() }}
          disabled={disabled}
        >
          深さを適用
        </button>
      </div>
      </div>
    </div>
  )
}

/** One codec's Beep (one-shot test tone, profile "full" only). Local-only —
 *  the part has no beep config readback, so this is NOT device-backed; the
 *  knobs just survive tab switches via the store (setBeep). */
function BeepPanel({
  ip,
  codec,
  title,
  device,
  cachedInfo,
  sendTo,
}: {
  ip: string
  codec: EqCodec
  title: string
  device: DeviceInfo
  cachedInfo?: NodeConfigInfo
  sendTo: (msg: ManagerMessage) => void
}) {
  const offline = !device.online
  const { setAnchor, toast } = useToast()
  const caps = useDspProfileCaps(ip, codec, cachedInfo)
  const beepField = codec === 'haptic' ? 'beepHaptic' : 'beepHp'
  const beep = useDuoWlV4AudioStore((s) => s.draftFor(ip)[beepField])
  const setBeep = useDuoWlV4AudioStore((s) => s.setBeep)
  const update = (patch: Partial<DuoWlV4BeepValue>) => setBeep(ip, codec, { ...beep, ...patch })
  const disabled = offline || !caps.has_beep

  const play = (e: React.MouseEvent<HTMLButtonElement>) => {
    setAnchor(e.currentTarget)
    sendTo({
      type: 'set_beep',
      payload: { codec, freq_hz: beep.freqHz, volume_db: beep.volumeDb, length_ms: beep.lengthMs, enable: true },
    })
    toast(`${title}: テストトーンを再生しました`, 'success')
  }

  return (
    <div className="form-section duo-v4-config">
      <div className="form-section-title">
        {title}
        <span className="form-section-sub-inline"> — Beep（テストトーン）</span>
      </div>
      <div className="form-status muted" style={{ minHeight: 18, fontSize: 12 }}>
        {caps.has_beep
          ? '一発鳴動（NVS には保存されません）。'
          : '⚠ 現在のプロファイルは Beep 非対応です（full を選択してください）。'}
      </div>
      <div className="form-row">
        <label>周波数</label>
        <div className="form-row-multi" style={{ alignItems: 'center', gap: 4 }}>
          <EqNumberField
            value={beep.freqHz}
            onCommit={(v) => { const c = Math.max(1, Math.round(v)); update({ freqHz: c }); return c }}
            disabled={disabled}
            width={80}
          />
          <span style={{ fontSize: 12 }}>Hz</span>
        </div>
        <span />
      </div>
      <div className="form-row">
        <label>音量</label>
        <div className="form-row-multi" style={{ alignItems: 'center', gap: 8 }}>
          <input
            type="range"
            min={-63}
            max={0}
            step={1}
            value={beep.volumeDb}
            onChange={(e) => update({ volumeDb: Number(e.target.value) })}
            disabled={disabled}
            style={{ flex: 1 }}
          />
          <span className="mono" style={{ width: 56, textAlign: 'right' }}>{beep.volumeDb} dB</span>
        </div>
        <span />
      </div>
      <div className="form-row">
        <label>長さ</label>
        <div className="form-row-multi" style={{ alignItems: 'center', gap: 4 }}>
          <EqNumberField
            value={beep.lengthMs}
            onCommit={(v) => { const c = Math.max(1, Math.round(v)); update({ lengthMs: c }); return c }}
            disabled={disabled}
            width={80}
          />
          <span style={{ fontSize: 12 }}>ms</span>
        </div>
        <span />
      </div>
      <div className="form-action-row" style={{ marginTop: 8 }}>
        <button className="form-button" onClick={play} disabled={disabled}>
          ▶ 再生
        </button>
      </div>
    </div>
  )
}

const AGC_TARGET_LEVELS_DB = [-5.5, -8, -10, -12, -14, -17, -20, -24] as const
const AGC_HYSTERESIS_OPTIONS = [0, 1.0, 2.0, 4.0] as const

/** Global AGC panel (line-in / HP-codec ADC path only — no per-codec split,
 *  see DuoWlV4AgcValue doc). Not gated by a DSP profile (AGC is available on
 *  every ADC PRB, independent of the DAC profile machinery). */
function AgcPanel({
  ip,
  device,
  cachedInfo,
  sendTo,
  syncTick,
  onReconcile,
}: {
  ip: string
  device: DeviceInfo
  cachedInfo?: NodeConfigInfo
  sendTo: (msg: ManagerMessage) => void
  syncTick?: number
  onReconcile?: () => void
}) {
  const offline = !device.online
  const { setAnchor } = useToast()
  const scheduleReconcile = useReconcileScheduler(onReconcile)
  const deviceAgcInfo = cachedInfo?.agc
  // MUST be memoized on deviceAgcInfo — same infinite-loop hazard as
  // DrcPanel's deviceDrc above (see that useMemo's comment).
  const deviceAgc: DuoWlV4AgcValue | undefined = useMemo(
    () => deviceAgcInfo && agcInfoToValue(deviceAgcInfo),
    [deviceAgcInfo],
  )
  const agc = useDuoAgcField(
    ip,
    deviceAgc,
    (v, persist) => {
      sendTo(agcValueToMessage(v, persist))
      if (persist) scheduleReconcile()
    },
    syncTick,
  )
  const v = agc.value
  const disabled = offline

  return (
    <div className="form-section duo-v4-config">
      <div className="form-section-title">
        AGC（ライン入力）
        <span className="form-section-sub-inline"> — 自動ゲイン制御・HP codec ADC 経路</span>
      </div>
      <div className="form-status muted" style={{ fontSize: 12 }}>
        ライン入力（HP codec の ADC 経路）に適用されます。入出力モードで「入力（ライン入力）」を選んでいる時のみ音声経路に乗ります。
      </div>

      <div className="form-row">
        <label>有効</label>
        <div className="device-toggle" role="group" aria-label="AGC enable">
          <button
            type="button"
            className={`btn btn-sm device-toggle-btn ${!v.enable ? 'active' : ''}`}
            onClick={(e) => { setAnchor(e.currentTarget); agc.commit({ ...v, enable: false }) }}
            disabled={disabled}
          >
            無効
          </button>
          <button
            type="button"
            className={`btn btn-sm device-toggle-btn ${v.enable ? 'active' : ''}`}
            onClick={(e) => { setAnchor(e.currentTarget); agc.commit({ ...v, enable: true }) }}
            disabled={disabled}
          >
            有効
          </button>
        </div>
        <DirtyMark dirty={agc.dirty} />
      </div>

      <div className="form-row">
        <label>目標レベル</label>
        <div className="device-toggle" role="group" aria-label="AGC target level" style={{ flexWrap: 'wrap' }}>
          {AGC_TARGET_LEVELS_DB.map((lv) => (
            <button
              key={lv}
              type="button"
              className={`btn btn-sm device-toggle-btn ${v.targetLevelDb === lv ? 'active' : ''}`}
              onClick={() => agc.commit({ ...v, targetLevelDb: lv })}
              disabled={disabled}
            >
              {lv} dB
            </button>
          ))}
        </div>
        <span />
      </div>

      <div className="form-row">
        <label>最大ゲイン</label>
        <div className="form-row-multi" style={{ alignItems: 'center', gap: 8 }}>
          <input
            type="range"
            min={0}
            max={58}
            step={0.5}
            value={v.maxGainDb}
            onChange={(e) => agc.onInput({ ...v, maxGainDb: Number(e.target.value) })}
            onPointerUp={() => agc.commit()}
            onBlur={() => agc.commit()}
            disabled={disabled}
            style={{ flex: 1 }}
          />
          <span className="mono" style={{ width: 56, textAlign: 'right' }}>{v.maxGainDb.toFixed(1)} dB</span>
        </div>
        <span />
      </div>

      <div className="form-row">
        <label>アタック<br /><span style={{ fontSize: 11, color: 'var(--text-muted)' }}>raw code 0-255</span></label>
        <div className="form-row-multi" style={{ alignItems: 'center', gap: 8 }}>
          <input
            type="range"
            min={0}
            max={255}
            step={1}
            value={v.attack}
            onChange={(e) => agc.onInput({ ...v, attack: Number(e.target.value) })}
            onPointerUp={() => agc.commit()}
            onBlur={() => agc.commit()}
            disabled={disabled}
            style={{ flex: 1 }}
          />
          <span className="mono" style={{ width: 40, textAlign: 'right' }}>{v.attack}</span>
        </div>
        <span />
      </div>

      <div className="form-row">
        <label>ディケイ<br /><span style={{ fontSize: 11, color: 'var(--text-muted)' }}>raw code 0-255</span></label>
        <div className="form-row-multi" style={{ alignItems: 'center', gap: 8 }}>
          <input
            type="range"
            min={0}
            max={255}
            step={1}
            value={v.decay}
            onChange={(e) => agc.onInput({ ...v, decay: Number(e.target.value) })}
            onPointerUp={() => agc.commit()}
            onBlur={() => agc.commit()}
            disabled={disabled}
            style={{ flex: 1 }}
          />
          <span className="mono" style={{ width: 40, textAlign: 'right' }}>{v.decay}</span>
        </div>
        <span />
      </div>

      <div className="form-row">
        <label>ノイズゲート</label>
        <div className="device-toggle" role="group" aria-label="AGC noise gate">
          <button
            type="button"
            className={`btn btn-sm device-toggle-btn ${v.noiseThresholdDb === 0 ? 'active' : ''}`}
            onClick={() => agc.commit({ ...v, noiseThresholdDb: 0 })}
            disabled={disabled}
          >
            無効
          </button>
          <button
            type="button"
            className={`btn btn-sm device-toggle-btn ${v.noiseThresholdDb !== 0 ? 'active' : ''}`}
            // Sensible on-grid default (-60dB, 2dB grid — see aic3204-full-
            // dsp-registers.md §5 agcNoiseCode) when enabling from the default
            // (0 = disabled) state — without this there was no path from a
            // default device to a non-zero threshold (adversarial review
            // finding 3): the slider below was disabled whenever the value
            // was 0, and 0 IS the module default, so nothing could ever
            // un-disable it.
            onClick={() => agc.commit({ ...v, noiseThresholdDb: v.noiseThresholdDb !== 0 ? v.noiseThresholdDb : -60 })}
            disabled={disabled}
          >
            有効
          </button>
        </div>
        <span />
      </div>
      {/* min-height reserved so this hint/slider row is always present
          (layout-shift rule) — dims instead of disappearing when disabled. */}
      <div className="form-row" style={{ opacity: v.noiseThresholdDb === 0 ? 0.45 : 1 }}>
        <label>しきい値</label>
        <div className="form-row-multi" style={{ alignItems: 'center', gap: 8 }}>
          <input
            type="range"
            min={-90}
            max={-30}
            step={2}
            value={v.noiseThresholdDb === 0 ? -30 : v.noiseThresholdDb}
            onChange={(e) => agc.onInput({ ...v, noiseThresholdDb: Number(e.target.value) })}
            onPointerUp={() => agc.commit()}
            onBlur={() => agc.commit()}
            disabled={disabled || v.noiseThresholdDb === 0}
            style={{ flex: 1 }}
          />
          <span className="mono" style={{ width: 56, textAlign: 'right' }}>
            {v.noiseThresholdDb === 0 ? '無効' : `${v.noiseThresholdDb} dB`}
          </span>
        </div>
        <span />
      </div>

      <div className="form-row">
        <label>ヒステリシス</label>
        <div className="device-toggle" role="group" aria-label="AGC hysteresis">
          {AGC_HYSTERESIS_OPTIONS.map((hy) => (
            <button
              key={hy}
              type="button"
              className={`btn btn-sm device-toggle-btn ${v.hysteresisDb === hy ? 'active' : ''}`}
              onClick={() => agc.commit({ ...v, hysteresisDb: hy })}
              disabled={disabled}
            >
              {hy === 0 ? '無効' : `${hy.toFixed(1)} dB`}
            </button>
          ))}
        </div>
        <span />
      </div>

      <div className="form-row">
        <label>適用ゲイン</label>
        <span className="mono" style={{ fontSize: 12 }}>
          L: {deviceAgcInfo?.applied_gain_l_db != null ? `${deviceAgcInfo.applied_gain_l_db.toFixed(1)} dB` : '—'}
          {' '}／ R: {deviceAgcInfo?.applied_gain_r_db != null ? `${deviceAgcInfo.applied_gain_r_db.toFixed(1)} dB` : '—'}
        </span>
        <span />
      </div>
      <div className="form-status muted" style={{ fontSize: 11 }}>
        ※ get_info 取得時点のスナップショットです（「デバイスから読み込み」で更新）。
      </div>
    </div>
  )
}

export function DuoWlV4DspSection({
  device,
  cachedInfo,
  sendTo,
  syncTick,
  onReconcile,
}: {
  device: DeviceInfo
  cachedInfo?: NodeConfigInfo
  sendTo: (msg: ManagerMessage) => void
  /** get_info counter — reconciles same-value device echoes (finding 3). */
  syncTick?: number
  /** Transport-correct get_info refresh, wired by DeviceDetail. */
  onReconcile?: () => void
}) {
  const ip = device.ipAddress
  return (
    <>
      <DrcPanel ip={ip} codec="haptic" title="触覚 DRC" device={device} cachedInfo={cachedInfo} sendTo={sendTo} syncTick={syncTick} onReconcile={onReconcile} />
      <DrcPanel ip={ip} codec="hp" title="ヘッドホン DRC" device={device} cachedInfo={cachedInfo} sendTo={sendTo} syncTick={syncTick} onReconcile={onReconcile} />
      <Effect3dPanel ip={ip} codec="haptic" title="触覚 3D" device={device} cachedInfo={cachedInfo} sendTo={sendTo} syncTick={syncTick} onReconcile={onReconcile} />
      <Effect3dPanel ip={ip} codec="hp" title="ヘッドホン 3D" device={device} cachedInfo={cachedInfo} sendTo={sendTo} syncTick={syncTick} onReconcile={onReconcile} />
      <BeepPanel ip={ip} codec="haptic" title="触覚 Beep" device={device} cachedInfo={cachedInfo} sendTo={sendTo} />
      <BeepPanel ip={ip} codec="hp" title="ヘッドホン Beep" device={device} cachedInfo={cachedInfo} sendTo={sendTo} />
      <AgcPanel ip={ip} device={device} cachedInfo={cachedInfo} sendTo={sendTo} syncTick={syncTick} onReconcile={onReconcile} />
    </>
  )
}

// ---------------------------------------------------------------------
// Defensive normalizers for the NEW full-DSP snapshot fields — same "fall
// back to the current draft on a missing/malformed field" discipline as the
// existing clampPamDb/clampLineoutDb/etc. above and normalizeEqBandDraft in
// the EQ section, so a hand-edited or partial (pre-DSP-feature) JSON import
// can never crash the editor or send NaN/garbage to the device.
// ---------------------------------------------------------------------

function clampDspProfile(v: unknown, fallback: DuoWlV4DspProfile): DuoWlV4DspProfile {
  return DSP_PROFILE_OPTIONS.some((o) => o.value === v) ? (v as DuoWlV4DspProfile) : fallback
}

function clampIirCoeffs(v: unknown, fallback: [number, number, number]): [number, number, number] {
  if (!Array.isArray(v) || v.length !== 3 || v.some((n) => typeof n !== 'number' || !Number.isFinite(n))) {
    return fallback
  }
  return [Math.round(v[0]), Math.round(v[1]), Math.round(v[2])]
}

// Snaps to the 3dB grid firmware actually stores (drcThresholdCode in
// duowl_v4_audio.cpp derives 8 discrete codes 0..7 <-> {-3,-6,...,-24}) —
// a plain Math.round(v) left an imported/hand-typed off-grid value (e.g.
// -10) disagreeing with the device's snapped echo (-9) until the next
// get_info reconcile (adversarial review finding 5).
function clampDrcThresholdDb(v: number): number {
  return Math.max(-24, Math.min(-3, Math.round(v / 3) * 3))
}
function clampDrcHysteresisDb(v: number): number {
  return Math.max(0, Math.min(3, Math.round(v)))
}
/** Shared 0..15 raw-code clamp for DRC hold/attack/decay. */
function clampDrcCode(v: number): number {
  return Math.max(0, Math.min(15, Math.round(v)))
}
function normalizeDrcValue(input: unknown, fallback: DuoWlV4DrcValue): DuoWlV4DrcValue {
  if (!input || typeof input !== 'object') return fallback
  const o = input as Partial<Record<keyof DuoWlV4DrcValue, unknown>>
  return {
    enableL: typeof o.enableL === 'boolean' ? o.enableL : fallback.enableL,
    enableR: typeof o.enableR === 'boolean' ? o.enableR : fallback.enableR,
    thresholdDb: typeof o.thresholdDb === 'number' && Number.isFinite(o.thresholdDb) ? clampDrcThresholdDb(o.thresholdDb) : fallback.thresholdDb,
    hysteresisDb: typeof o.hysteresisDb === 'number' && Number.isFinite(o.hysteresisDb) ? clampDrcHysteresisDb(o.hysteresisDb) : fallback.hysteresisDb,
    hold: typeof o.hold === 'number' && Number.isFinite(o.hold) ? clampDrcCode(o.hold) : fallback.hold,
    attack: typeof o.attack === 'number' && Number.isFinite(o.attack) ? clampDrcCode(o.attack) : fallback.attack,
    decay: typeof o.decay === 'number' && Number.isFinite(o.decay) ? clampDrcCode(o.decay) : fallback.decay,
  }
}

/** Shared 0..255 raw-code clamp for AGC attack/decay. */
function clampAgcCode(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)))
}
function normalizeAgcValue(input: unknown, fallback: DuoWlV4AgcValue): DuoWlV4AgcValue {
  if (!input || typeof input !== 'object') return fallback
  const o = input as Partial<Record<keyof DuoWlV4AgcValue, unknown>>
  return {
    enable: typeof o.enable === 'boolean' ? o.enable : fallback.enable,
    targetLevelDb: typeof o.targetLevelDb === 'number' && Number.isFinite(o.targetLevelDb) ? o.targetLevelDb : fallback.targetLevelDb,
    maxGainDb: typeof o.maxGainDb === 'number' && Number.isFinite(o.maxGainDb) ? Math.max(0, Math.min(58, o.maxGainDb)) : fallback.maxGainDb,
    attack: typeof o.attack === 'number' && Number.isFinite(o.attack) ? clampAgcCode(o.attack) : fallback.attack,
    decay: typeof o.decay === 'number' && Number.isFinite(o.decay) ? clampAgcCode(o.decay) : fallback.decay,
    noiseThresholdDb: typeof o.noiseThresholdDb === 'number' && Number.isFinite(o.noiseThresholdDb) ? o.noiseThresholdDb : fallback.noiseThresholdDb,
    hysteresisDb: typeof o.hysteresisDb === 'number' && Number.isFinite(o.hysteresisDb) ? o.hysteresisDb : fallback.hysteresisDb,
  }
}

function clampEffect3dDepth(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : fallback
}

/** `v !== null && typeof v === 'object'` — guards the `hadX` presence
 *  checks below against `typeof null === 'object'`. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object'
}

// ---------------------------------------------------------------------
// DuoWL v4: single-JSON backup of EVERY audio-tab + EQ-tab setting.
// Rendered once at the top of the 音声 sub-tab (DeviceDetail.tsx). Reads
// from / writes to useDuoWlV4AudioStore directly, so it's reachable from
// here regardless of whether the EQ tab has ever been mounted for this
// device (normalizeEqDrafts fills sensible defaults for an untouched
// codec). Import never auto-writes — it only loads the draft (marking
// every field dirty); "読み込んだ設定を書き込む" is the explicit write path,
// alongside each section's own 適用 buttons.
// ---------------------------------------------------------------------

export function DuoWlV4SettingsBackup({
  device,
  cachedInfo,
  sendTo,
}: {
  device: DeviceInfo
  cachedInfo?: NodeConfigInfo
  sendTo: (msg: ManagerMessage) => void
}) {
  const ip = device.ipAddress
  const draft = useDuoWlV4AudioStore((s) => s.draftFor(ip))
  const loadSnapshot = useDuoWlV4AudioStore((s) => s.loadSnapshot)
  const markAllClean = useDuoWlV4AudioStore((s) => s.markAllClean)
  const { setAnchor, toast } = useToast()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const offline = !device.online

  const eqHaptic = useMemo(() => normalizeEqDrafts(draft.eqHaptic, 'haptic'), [draft.eqHaptic])
  const eqHp = useMemo(() => normalizeEqDrafts(draft.eqHp, 'hp'), [draft.eqHp])

  // "Effective truth" for each full-DSP family: the user's own in-progress
  // edit when dirty, else the LIVE device value (cachedInfo — this
  // component now receives it, unlike before), else whatever the draft
  // currently holds (module default, only reached if this family has never
  // been reconciled with a real device this session — e.g. offline/never
  // connected). Adversarial review finding 2: without preferring cachedInfo
  // here, "設定を JSON 保存" silently exported/wrote module DEFAULTS
  // (DEFAULT_DRC/DEFAULT_AGC/'standard'/unity IIR/depth 0) whenever the
  // DSP/EQ sub-tabs — the ONLY components that otherwise reconcile these
  // fields — hadn't been visited this session (they're on separate tabs
  // from this component, which lives on the 音声 tab, and React unmounts
  // inactive tab content). Used for BOTH export and the import fallback.
  const deviceDrcHaptic = cachedInfo?.drc?.haptic
  const deviceDrcHp = cachedInfo?.drc?.hp
  const deviceAgcInfo = cachedInfo?.agc
  const effectiveProfileHaptic = draft.dspProfileHaptic.dirty
    ? draft.dspProfileHaptic.value
    : (cachedInfo?.dsp_profile?.haptic?.profile ?? draft.dspProfileHaptic.value)
  const effectiveProfileHp = draft.dspProfileHp.dirty
    ? draft.dspProfileHp.value
    : (cachedInfo?.dsp_profile?.hp?.profile ?? draft.dspProfileHp.value)
  const effectiveIirHaptic = draft.iirHaptic.dirty
    ? draft.iirHaptic.value
    : (cachedInfo?.eq_iir?.haptic ?? draft.iirHaptic.value)
  const effectiveIirHp = draft.iirHp.dirty
    ? draft.iirHp.value
    : (cachedInfo?.eq_iir?.hp ?? draft.iirHp.value)
  const effectiveDrcHaptic = draft.drcHaptic.dirty
    ? draft.drcHaptic.value
    : (deviceDrcHaptic ? drcInfoToValue(deviceDrcHaptic) : draft.drcHaptic.value)
  const effectiveDrcHp = draft.drcHp.dirty
    ? draft.drcHp.value
    : (deviceDrcHp ? drcInfoToValue(deviceDrcHp) : draft.drcHp.value)
  const effectiveEffect3dHaptic = draft.effect3dHaptic.dirty
    ? draft.effect3dHaptic.value
    : (cachedInfo?.effect_3d?.haptic ?? draft.effect3dHaptic.value)
  const effectiveEffect3dHp = draft.effect3dHp.dirty
    ? draft.effect3dHp.value
    : (cachedInfo?.effect_3d?.hp ?? draft.effect3dHp.value)
  const effectiveAgc = draft.agc.dirty
    ? draft.agc.value
    : (deviceAgcInfo ? agcInfoToValue(deviceAgcInfo) : draft.agc.value)

  const handleExport = (e: React.MouseEvent<HTMLButtonElement>) => {
    setAnchor(e.currentTarget)
    const snapshot: DuoWlV4AudioSnapshot = {
      version: 1,
      pam_db: draft.pamDb.value,
      lineout_db: draft.lineoutDb.value,
      boost_db: draft.boostDb.value,
      hp_db: draft.hpDb.value,
      input_mode: draft.inputMode.value,
      stream_buffer_ms: draft.bufferMs.value,
      av_delay_ms: draft.avDelayMs.value,
      eq: { haptic: eqHaptic, hp: eqHp },
      eq_iir: { haptic: effectiveIirHaptic, hp: effectiveIirHp },
      dsp_profile: { haptic: effectiveProfileHaptic, hp: effectiveProfileHp },
      drc: { haptic: effectiveDrcHaptic, hp: effectiveDrcHp },
      effect_3d: { haptic: effectiveEffect3dHaptic, hp: effectiveEffect3dHp },
      agc: effectiveAgc,
    }
    downloadTextFile(`hapbeat-duowlv4-audio-${Date.now()}.json`, JSON.stringify(snapshot, null, 2))
    toast('DuoWL v4 設定を JSON にエクスポートしました', 'success')
  }

  const handleImportFile = (file: File) => {
    const fr = new FileReader()
    fr.onload = () => {
      try {
        const parsed = JSON.parse(String(fr.result)) as unknown
        if (!parsed || typeof parsed !== 'object') throw new Error('不正な JSON です')
        const o = parsed as Record<string, unknown>
        const eqObj = isPlainObject(o.eq) ? o.eq : undefined
        // Did the file EXPLICITLY carry each family's section? Only then is
        // that family adopted + made bulk-writable — mirrors the existing
        // hadEq discipline (finding 1), extended to every full-DSP family
        // (adversarial review finding 2): a file that doesn't mention a
        // family must never silently seed it with a fallback default AND
        // mark it dirty/loaded, which would make applyAll ship that default
        // over the device's real (possibly very different) state.
        const hadEq = !!eqObj && (Array.isArray(eqObj.haptic) || Array.isArray(eqObj.hp))
        const iirObj = isPlainObject(o.eq_iir) ? o.eq_iir : undefined
        const hadIir = !!iirObj && (Array.isArray(iirObj.haptic) || Array.isArray(iirObj.hp))
        const dspProfileObj = isPlainObject(o.dsp_profile) ? o.dsp_profile : undefined
        const hadProfile = !!dspProfileObj && (typeof dspProfileObj.haptic === 'string' || typeof dspProfileObj.hp === 'string')
        const drcObj = isPlainObject(o.drc) ? o.drc : undefined
        const hadDrc = !!drcObj && (isPlainObject(drcObj.haptic) || isPlainObject(drcObj.hp))
        const effect3dObj = isPlainObject(o.effect_3d) ? o.effect_3d : undefined
        const had3d = !!effect3dObj && (typeof effect3dObj.haptic === 'number' || typeof effect3dObj.hp === 'number')
        const hadAgc = isPlainObject(o.agc)
        const snapshot: DuoWlV4AudioSnapshot = {
          version: 1,
          pam_db: clampPamDb(Number(o.pam_db)),
          lineout_db: clampLineoutDb(Number(o.lineout_db)),
          boost_db: clampBoostDb(Number(o.boost_db)),
          hp_db: clampHpDb(Number(o.hp_db)),
          input_mode: o.input_mode === 'line_in' ? 'line_in' : 'output',
          stream_buffer_ms: clampBufferMs(Number(o.stream_buffer_ms)),
          av_delay_ms: clampAvDelayMs(Number(o.av_delay_ms)),
          eq: {
            haptic: normalizeEqDrafts(eqObj?.haptic, 'haptic'),
            hp: normalizeEqDrafts(eqObj?.hp, 'hp'),
          },
          // Fallback (used only when hadX is false, in which case
          // loadSnapshot ignores this family's value entirely — see its
          // doc) is the SAME "effective truth" used for export, not a bare
          // draft/module-default read (adversarial review finding 2).
          eq_iir: {
            haptic: clampIirCoeffs(iirObj?.haptic, effectiveIirHaptic),
            hp: clampIirCoeffs(iirObj?.hp, effectiveIirHp),
          },
          dsp_profile: {
            haptic: clampDspProfile(dspProfileObj?.haptic, effectiveProfileHaptic),
            hp: clampDspProfile(dspProfileObj?.hp, effectiveProfileHp),
          },
          drc: {
            haptic: normalizeDrcValue(drcObj?.haptic, effectiveDrcHaptic),
            hp: normalizeDrcValue(drcObj?.hp, effectiveDrcHp),
          },
          effect_3d: {
            haptic: clampEffect3dDepth(effect3dObj?.haptic, effectiveEffect3dHaptic),
            hp: clampEffect3dDepth(effect3dObj?.hp, effectiveEffect3dHp),
          },
          agc: normalizeAgcValue(o.agc, effectiveAgc),
        }
        loadSnapshot(ip, snapshot, { eq: hadEq, iir: hadIir, drc: hadDrc, profile: hadProfile, effect3d: had3d, agc: hadAgc })
        setImportError(null)
        const loadedFamilies = [
          hadProfile && 'DSP プロファイル',
          hadEq && 'EQ',
          hadIir && '1次IIR',
          hadDrc && 'DRC',
          had3d && '3D',
          hadAgc && 'AGC',
        ].filter((x): x is string => !!x)
        toast(
          loadedFamilies.length > 0
            ? `DuoWL v4 設定（音声 + ${loadedFamilies.join('/')}）を JSON から読み込みました（未適用 — 各「適用」または下の書き込みボタンで反映）`
            : 'DuoWL v4 音声設定を JSON から読み込みました（EQ/DSP 情報なし → EQ/DSP は変更しません。未適用 — 各「適用」または下の書き込みボタンで反映）',
          'success',
        )
      } catch (e) {
        setImportError(e instanceof Error ? e.message : 'JSON を解析できません')
        setTimeout(() => setImportError(null), 6000)
      }
    }
    fr.readAsText(file)
  }

  // Sends every DuoWL v4 AUDIO setter with persist:true unconditionally
  // (round-trips losslessly, always safe), then marks every device-backed
  // field clean — the same optimistic-commit behavior as each section's own
  // 適用 button, just for all of them at once.
  //
  // EVERY full-DSP family (EQ biquad bands, 1st-order IIR, DRC, 3D, DSP
  // profile, AGC) is gated behind its own `*Loaded` flag (adversarial
  // review finding 2 — extends the pre-existing `eqLoaded` gate to all of
  // them): each family's draft is only trustworthy once its owning panel
  // has reconciled with a live device value OR the user edited it OR an
  // import explicitly carried it — see DuoWlV4Draft.eqLoaded doc for why
  // "round-trips losslessly through get_info" is NOT the same guarantee as
  // "this draft's CURRENT value reflects that round-trip" (the owning panel
  // lives on a different, possibly-never-visited sub-tab).
  const applyAll = (e: React.MouseEvent<HTMLButtonElement>) => {
    setAnchor(e.currentTarget)
    sendTo({
      type: 'set_haptic_gain',
      payload: { pam_db: draft.pamDb.value, lineout_db: draft.lineoutDb.value, persist: true },
    })
    sendTo({ type: 'set_dac_boost', payload: { boost_db: draft.boostDb.value, persist: true } })
    sendTo({ type: 'set_headphone_volume', payload: { hp_db: draft.hpDb.value, persist: true } })
    sendTo({ type: 'set_input_mode', payload: { mode: draft.inputMode.value, persist: true } })
    sendTo({ type: 'set_stream_buffer', payload: { buffer_ms: draft.bufferMs.value, persist: true } })
    sendTo({ type: 'set_av_delay', payload: { ms: draft.avDelayMs.value, persist: true } })

    const sentFamilies: string[] = []
    if (draft.profileLoaded) {
      sendTo({ type: 'set_dsp_profile', payload: { codec: 'haptic', profile: draft.dspProfileHaptic.value, persist: true } })
      sendTo({ type: 'set_dsp_profile', payload: { codec: 'hp', profile: draft.dspProfileHp.value, persist: true } })
      sentFamilies.push('DSP プロファイル')
    }
    if (draft.eqLoaded) {
      eqHaptic.forEach((b, band) => {
        const result = computeAic3204Eq({ ftype: b.ftype as EqFtype, fs: EQ_FS.haptic, fc: b.fc, q: b.q, gainDb: b.gainDb })
        sendTo({ type: 'set_eq_band', payload: { codec: 'haptic', band, ftype: b.ftype, coeffs: aic3204CoeffsToArray(result.coeffs), persist: true } })
      })
      eqHp.forEach((b, band) => {
        const result = computeAic3204Eq({ ftype: b.ftype as EqFtype, fs: EQ_FS.hp, fc: b.fc, q: b.q, gainDb: b.gainDb })
        sendTo({ type: 'set_eq_band', payload: { codec: 'hp', band, ftype: b.ftype, coeffs: aic3204CoeffsToArray(result.coeffs), persist: true } })
      })
      sentFamilies.push('EQ')
    }
    if (draft.iirLoaded) {
      sendTo({ type: 'set_eq_iir', payload: { codec: 'haptic', coeffs: draft.iirHaptic.value, persist: true } })
      sendTo({ type: 'set_eq_iir', payload: { codec: 'hp', coeffs: draft.iirHp.value, persist: true } })
      sentFamilies.push('1次IIR')
    }
    if (draft.drcLoaded) {
      sendTo(drcValueToMessage('haptic', draft.drcHaptic.value, true))
      sendTo(drcValueToMessage('hp', draft.drcHp.value, true))
      sentFamilies.push('DRC')
    }
    if (draft.effect3dLoaded) {
      sendTo({ type: 'set_3d', payload: { codec: 'haptic', depth: draft.effect3dHaptic.value, persist: true } })
      sendTo({ type: 'set_3d', payload: { codec: 'hp', depth: draft.effect3dHp.value, persist: true } })
      sentFamilies.push('3D')
    }
    if (draft.agcLoaded) {
      sendTo(agcValueToMessage(draft.agc.value, true))
      sentFamilies.push('AGC')
    }
    markAllClean(ip)
    toast(
      sentFamilies.length > 0
        ? `音声設定 + ${sentFamilies.join('/')} をデバイスへ書き込みました`
        : '音声設定のみ書き込みました（EQ/DSP は未編集・未読込のため送信していません。各タブで編集するか対応 JSON を読み込むと対象になります）',
      'success',
    )
  }

  return (
    <div className="form-section duo-v4-config">
      <div className="form-section-title">
        設定のバックアップ
        <span className="form-section-sub-inline"> — 音声・A-V ディレイ・EQ・DSP（プロファイル/IIR/DRC/3D/AGC）を JSON でまとめて保存/復元</span>
      </div>
      {/* EQ readback caveat (finding 1): the device only reports the committed
          ftype + raw coeffs, not the fc/Q/gain they were designed from — so an
          exported EQ reflects the Studio-side design, which may not match the
          device's actual on-codec EQ. Always-present muted note. */}
      <div className="form-status muted" style={{ fontSize: 12 }}>
        ※ EQ の fc/Q/gain はデバイスから読み戻せません。エクスポートされる EQ は Studio 側の設計値で、デバイスの現在値と一致しない場合があります。「読み込んだ設定を書き込む」は各項目（EQ/1次IIR/DRC/3D/DSP プロファイル/AGC）を編集済み・読込済み・またはそれを含む JSON を読み込んだ場合のみ、その項目を送信します（音声設定は常に送信）。
      </div>
      {/* Fixed-height status line (layout-shift rule): reserved even when idle
          so an import error never shifts the action row below. */}
      <div className="form-status muted" style={{ minHeight: 16, fontSize: 12 }}>
        {importError
          ? `⚠ インポート失敗: ${importError}`
          : '保存・読込は draft のみ変更します（デバイスへは各「適用」または右の書き込みボタンで反映）。'}
      </div>
      <div className="form-action-row" style={{ marginTop: 8 }}>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,application/json"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) handleImportFile(f)
            e.target.value = '' // allow re-importing the same file
          }}
        />
        <button
          className="form-button-secondary"
          onClick={(e) => { setAnchor(e.currentTarget); fileInputRef.current?.click() }}
          title="JSON ファイルから DuoWL v4 の全設定を読み込む"
        >
          設定を JSON 読込
        </button>
        <button
          className="form-button-secondary"
          onClick={handleExport}
          title="現在の DuoWL v4 全設定を JSON ファイルに保存"
        >
          設定を JSON 保存
        </button>
        <span style={{ flex: 1 }} />
        <button
          className="form-button"
          onClick={applyAll}
          disabled={offline}
          title="読み込んだ（または編集中の）設定をすべてデバイスへ書き込みます"
        >
          読み込んだ設定を書き込む
        </button>
      </div>
    </div>
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
