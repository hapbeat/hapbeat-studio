import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useHelperConnection } from '@/hooks/useHelperConnection'
import { useMqttFlowStore } from '@/stores/mqttFlowStore'
import { useDeviceStore } from '@/stores/deviceStore'
import type { DeviceInfo, MqttClientEntry } from '@/types/manager'

/**
 * MQTT 通信フロー — sensors → broker → receivers, with live publish stats.
 *
 * Page-level singleton (user feedback 2026-06-13): the chart is fed by the
 * BROKER's get_info (mqtt_clients / mqtt_pub_count / mqtt_last_*) regardless
 * of which device is currently selected, so it reads the same whether you're
 * on a sensor's MQTT tab or the broker's. `MqttFlowController` (mounted once
 * at the Devices root) drives the polling and the pop-out window; the inline
 * `MqttFlowPanel` shown in each MQTT tab is just a view onto the same data.
 *
 * Diagnostic (item 5): a sensor that is *discovered on the network* (mDNS /
 * helper device list) but is NOT in the broker's client list is drawn as a
 * dashed "未接続" ghost node. That makes the common "sender doesn't show up"
 * situation self-explanatory — the node IS there, it just hasn't connected
 * to the broker (mDNS resolve / topic_root / network), which is a
 * device-side link problem, not a Studio display gap.
 */

interface FlowNode {
  key: string
  label: string
  /** true = present in the broker's client list; false = discovered-only. */
  connected: boolean
  /** Topic this node uses, from its get_info (sender: 送信 topic_root;
   *  receiver: 購読 recv_topics). undefined = not fetched yet. (item, 06-14) */
  topic?: string
}

function clientLabel(c: MqttClientEntry): string {
  if (c.name) return c.name
  // Fallback: clientId tail (firmware without a presence message yet).
  return c.id.length > 14 ? `…${c.id.slice(-12)}` : c.id
}

// --- shared data hook ------------------------------------------------------

export interface MqttFlowData {
  broker: DeviceInfo | undefined
  brokerName: string
  port: number
  running: boolean
  left: FlowNode[]   // senders (+ unknown-role clients), connected first
  right: FlowNode[]  // receivers
  pubCount?: number
  lastTopic?: string
  lastPayload?: string
  // --- last event detail (for the "information exchange" panel) ---
  lastFrom?: string       // publishing client (送信元)
  lastEventId?: string    // parsed from the play payload
  lastTarget?: string     // parsed from the play payload
  lastAt?: number         // epoch ms Studio observed the event
  /** Connected receivers right now. 0 → a publish reaches no one (QoS 1
   *  guarantees sender→broker only; absent receivers are NOT queued). */
  receiverCount: number
  /** True when there's no broker on the network at all. */
  noBroker: boolean
}

/** True if a device is *expected* to be an MQTT client of the broker. */
function isMqttClientNode(d: DeviceInfo): boolean {
  if (d.role === 'sensor') return true
  if (d.role === 'broker') return false
  // receivers: only those that actually speak mqtt
  const transports = d.transports ?? (d.transport ? [d.transport] : [])
  return transports.includes('mqtt')
}

export function useMqttFlowData(): MqttFlowData {
  const { devices } = useHelperConnection()
  // Broker telemetry comes from mqttFlowStore (written by MqttFlowController),
  // NOT deviceStore.infoCache — the latter is wiped by DeviceDetail's
  // clearCachesFor on device switch, which used to blank the client list and
  // turn every connected sender into a 未接続 ghost (workflow root cause).
  const telemetry = useMqttFlowStore((s) => s.brokerTelemetry)
  // Per-device topic config (sender topic_root / receiver recv_topics) comes
  // from each device's get_info, cached in deviceStore.infoCache. The flow
  // controller polls the MQTT nodes so this is kept fresh while viewing.
  const infoCache = useDeviceStore((s) => s.infoCache)

  return useMemo(() => {
    const broker = devices.find((d) => d.role === 'broker')
    const info = broker && telemetry && telemetry.ip === broker.ipAddress ? telemetry : undefined
    const clients = info?.mqtt_clients ?? []

    const senders = clients.filter((c) => c.role === 'sensor')
    const receivers = clients.filter((c) => c.role === 'receiver')
    const others = clients.filter((c) => c.role !== 'sensor' && c.role !== 'receiver')

    // Names the broker reports as connected (presence). Used to find
    // discovered-but-not-connected nodes.
    const connectedNames = new Set(
      clients.map((c) => c.name).filter((n): n is string => !!n),
    )
    const discovered = devices.filter(
      (d) => isMqttClientNode(d) && d.online && !connectedNames.has(d.name),
    )
    const discoveredSenders = discovered.filter((d) => d.role === 'sensor')
    const discoveredReceivers = discovered.filter((d) => d.role !== 'sensor')

    // Topic label for a node, by correlating its name → device → infoCache.
    const ipByName = new Map(devices.map((d) => [d.name, d.ipAddress]))
    const topicFor = (ip: string | undefined, kind: 'sender' | 'receiver'): string | undefined => {
      if (!ip) return undefined
      const ci = infoCache[ip]
      if (!ci) return undefined
      if (kind === 'sender') return ci.topic_root || undefined
      const rt = ci.recv_topics
      if (rt == null) return undefined
      return rt.length ? rt.join(', ') : 'default-topic'
    }

    const left: FlowNode[] = [
      ...senders.map((c) => ({ key: `c-${c.id}`, label: clientLabel(c), connected: true, topic: topicFor(ipByName.get(c.name ?? ''), 'sender') })),
      ...others.map((c) => ({ key: `c-${c.id}`, label: clientLabel(c), connected: true })),
      ...discoveredSenders.map((d) => ({
        key: `d-${d.ipAddress}`, label: d.name || d.ipAddress, connected: false, topic: topicFor(d.ipAddress, 'sender'),
      })),
    ]
    const right: FlowNode[] = [
      ...receivers.map((c) => ({ key: `c-${c.id}`, label: clientLabel(c), connected: true, topic: topicFor(ipByName.get(c.name ?? ''), 'receiver') })),
      ...discoveredReceivers.map((d) => ({
        key: `d-${d.ipAddress}`, label: d.name || d.ipAddress, connected: false, topic: topicFor(d.ipAddress, 'receiver'),
      })),
    ]

    // Parse the last play/stop payload (the sensor sends
    // {event_id,target,gain}) for the info panel.
    let lastEventId: string | undefined
    let lastTarget: string | undefined
    if (info?.mqtt_last_payload) {
      try {
        const o = JSON.parse(info.mqtt_last_payload) as Record<string, unknown>
        if (typeof o.event_id === 'string') lastEventId = o.event_id
        if (typeof o.target === 'string') lastTarget = o.target
      } catch { /* truncated / non-JSON preview — leave undefined */ }
    }

    return {
      broker,
      brokerName: broker?.name || 'BROKER',
      port: info?.mqtt_port ?? 1883,
      running: info?.mqtt_running ?? false,
      left,
      right,
      pubCount: info?.mqtt_pub_count,
      lastTopic: info?.mqtt_last_topic,
      lastPayload: info?.mqtt_last_payload,
      lastFrom: info?.mqtt_last_from,
      lastEventId,
      lastTarget,
      lastAt: info?.lastEventAt,
      receiverCount: receivers.length,
      noBroker: !broker,
    }
  }, [devices, telemetry, infoCache])
}

// --- pure SVG --------------------------------------------------------------

function MqttFlowChartSvg(props: MqttFlowData) {
  const {
    brokerName, port, running, left, right, pubCount,
    lastTopic, lastFrom, lastEventId, lastTarget, lastAt, receiverCount,
  } = props

  // Pulse the edges briefly whenever the publish counter advances.
  const prevCountRef = useRef<number | undefined>(undefined)
  const [pulse, setPulse] = useState(false)
  useEffect(() => {
    if (pubCount == null) return
    const prev = prevCountRef.current
    prevCountRef.current = pubCount
    if (prev != null && pubCount > prev) {
      setPulse(true)
      const t = setTimeout(() => setPulse(false), 600)
      return () => clearTimeout(t)
    }
  }, [pubCount])

  const rows = Math.max(left.length, right.length, 1)
  const ROW_H = 34
  const height = 60 + rows * ROW_H
  const W = 560
  const brokerY = height / 2

  const nodeBox = (
    x: number, y: number, node: FlowNode, kind: 'sender' | 'receiver',
  ) => {
    const stroke = !node.connected ? '#777'
      : kind === 'sender' ? '#e8a33d' : '#4caf50'
    const fill = !node.connected ? 'rgba(128,128,128,0.06)'
      : kind === 'sender' ? 'rgba(255,165,0,0.12)' : 'rgba(76,175,80,0.12)'
    const label = node.label.length > 16 ? `${node.label.slice(0, 15)}…` : node.label
    // Topic sub-label: receiver 購読 / sender 送信 root. Truncate to fit.
    const topic = node.topic
      ? (node.topic.length > 18 ? `${node.topic.slice(0, 17)}…` : node.topic)
      : undefined
    const hasSub = !node.connected || !!topic   // a second line under the name
    return (
      <g key={node.key}>
        <rect
          x={x} y={y - 15} width={150} height={30} rx={5}
          fill={fill} stroke={stroke} strokeWidth={1}
          strokeDasharray={node.connected ? undefined : '4 3'}
        />
        <text x={x + 75} y={hasSub ? y - 2 : y + 4} textAnchor="middle" fontSize={11}
          fill={node.connected ? 'var(--text-primary, #ddd)' : 'var(--text-muted, #888)'}
          style={{ fontFamily: 'var(--font-mono)' }}>
          {label}
        </text>
        {!node.connected ? (
          <text x={x + 75} y={y + 10} textAnchor="middle" fontSize={8} fill="#c9742e">未接続</text>
        ) : topic ? (
          <text x={x + 75} y={y + 9} textAnchor="middle" fontSize={8}
            fill={kind === 'sender' ? '#c9742e' : '#3f9c42'}
            style={{ fontFamily: 'var(--font-mono)' }}>
            {kind === 'sender' ? '→ ' : '← '}{topic}
          </text>
        ) : null}
      </g>
    )
  }

  const edge = (x1: number, y1: number, x2: number, y2: number, key: string, connected: boolean) => (
    <line
      key={key}
      x1={x1} y1={y1} x2={x2} y2={y2}
      stroke={!connected ? 'rgba(150,150,150,0.25)' : pulse ? 'var(--accent, #7b6cff)' : 'rgba(150,150,150,0.45)'}
      strokeWidth={connected && pulse ? 2.5 : 1.2}
      strokeDasharray={connected ? undefined : '4 3'}
      markerEnd={connected ? 'url(#mqtt-arrow)' : undefined}
    />
  )

  return (
    <div style={{ overflowX: 'auto' }}>
      <svg
        viewBox={`0 0 ${W} ${height}`}
        // Fluid: fill the container (inline panel OR pop-out window). The
        // viewBox scales, so a wide pop-out no longer leaves big margins
        // (user feedback 2026-06-13). preserveAspectRatio keeps it centered.
        style={{ width: '100%', display: 'block' }}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label="MQTT 通信フロー図"
      >
        <defs>
          <marker id="mqtt-arrow" viewBox="0 0 8 8" refX="7" refY="4"
            markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L8,4 L0,8 z" fill={pulse ? 'var(--accent, #7b6cff)' : 'rgba(150,150,150,0.6)'} />
          </marker>
        </defs>

        {/* column headers */}
        <text x={85} y={16} textAnchor="middle" fontSize={11} fill="var(--text-muted, #888)">SENDER</text>
        <text x={W / 2} y={16} textAnchor="middle" fontSize={11} fill="var(--text-muted, #888)">BROKER</text>
        <text x={W - 85} y={16} textAnchor="middle" fontSize={11} fill="var(--text-muted, #888)">RECEIVER</text>

        {/* broker box */}
        <rect
          x={W / 2 - 80} y={brokerY - 24} width={160} height={48} rx={7}
          fill={running ? 'rgba(123,108,255,0.14)' : 'rgba(244,67,54,0.12)'}
          stroke={running ? 'var(--accent, #7b6cff)' : '#f44336'} strokeWidth={1.4}
        />
        <text x={W / 2} y={brokerY - 5} textAnchor="middle" fontSize={12} fontWeight={600}
          fill="var(--text-primary, #ddd)">
          {brokerName.length > 20 ? `${brokerName.slice(0, 19)}…` : brokerName}
        </text>
        <text x={W / 2} y={brokerY + 13} textAnchor="middle" fontSize={10.5}
          fill="var(--text-muted, #999)" style={{ fontFamily: 'var(--font-mono)' }}>
          {running ? `:${port} 稼働中` : '停止中'}{pubCount != null ? ` · pub ${pubCount}` : ''}
        </text>

        {/* sender (+unknown) nodes & edges into the broker */}
        {left.map((node, i) => {
          const y = 40 + i * ROW_H + 13
          return (
            <g key={node.key}>
              {nodeBox(10, y, node, 'sender')}
              {edge(162, y, W / 2 - 82, brokerY, `e-l-${node.key}`, node.connected)}
            </g>
          )
        })}
        {left.length === 0 && (
          <text x={85} y={brokerY + 4} textAnchor="middle" fontSize={11}
            fill="var(--text-muted, #777)">(なし)</text>
        )}

        {/* receiver nodes & edges out of the broker */}
        {right.map((node, i) => {
          const y = 40 + i * ROW_H + 13
          return (
            <g key={node.key}>
              {nodeBox(W - 160, y, node, 'receiver')}
              {edge(W / 2 + 82, brokerY, W - 162, y, `e-r-${node.key}`, node.connected)}
            </g>
          )
        })}
        {right.length === 0 && (
          <text x={W - 85} y={brokerY + 4} textAnchor="middle" fontSize={11}
            fill="var(--text-muted, #777)">(なし)</text>
        )}
      </svg>

      {/* Last-event info — what actually moved across the wire (時刻 / 送信元 /
          イベント / トピック / ターゲット). Surfacing this is the whole point of
          the chart (user feedback 2026-06-13). */}
      {(lastTopic || pubCount != null) && (
        <div className="mqtt-flow-info">
          <div className="mqtt-flow-info-title">
            最終イベント{pubCount != null ? `（broker 受信 ${pubCount} 件）` : ''}
          </div>
          {lastTopic ? (
            <div className="mqtt-flow-info-grid">
              {lastAt != null && (<><span>時刻</span><span className="mono">{new Date(lastAt).toLocaleTimeString()}</span></>)}
              {lastFrom && (<><span>送信元</span><span className="mono">{lastFrom}</span></>)}
              {lastEventId && (<><span>イベント</span><span className="mono">{lastEventId}</span></>)}
              <><span>topic</span><span className="mono">{lastTopic.replace(/\/(play|stop)$/, '')}</span></>
              <><span>ターゲット</span><span className="mono">{lastTarget || '（全台）'}</span></>
            </div>
          ) : (
            <div className="form-status muted" style={{ margin: 0 }}>まだイベントは届いていません。</div>
          )}
        </div>
      )}

      {/* QoS-1 reality check: with no connected receiver, a publish reaches
          the broker (PUBACK = QoS-1 guarantee) but is NOT queued for an
          absent receiver — so it goes nowhere. Make that explicit instead of
          implying a "待機" queue that MQTT doesn't provide. */}
      {running && receiverCount === 0 && (
        <div className="form-status warn" style={{ marginTop: 4 }}>
          受信機 (Hapbeat) が接続していません。QoS 1 が保証するのは「送信元 → ブローカー」の到達までで、
          受信機が居ない間のイベントはブローカーに保持されず届きません。受信機を MQTT で接続してください。
        </div>
      )}
    </div>
  )
}

// --- inline panel (rendered in each MQTT tab) ------------------------------

export function MqttFlowPanel() {
  const data = useMqttFlowData()
  const popout = useMqttFlowStore((s) => s.popout)
  const openPopout = useMqttFlowStore((s) => s.openPopout)
  const registerViewer = useMqttFlowStore((s) => s.registerViewer)
  const unregisterViewer = useMqttFlowStore((s) => s.unregisterViewer)
  // Tell the controller a flow chart is on screen so it polls the broker
  // only while one is actually being viewed. Keyed by a stable id (not a
  // bare counter) so StrictMode's dev double-mount can't desync the gate.
  const viewerId = useId()
  useEffect(() => {
    registerViewer(viewerId)
    return () => unregisterViewer(viewerId)
  }, [viewerId, registerViewer, unregisterViewer])
  const hasGhost = data.left.some((n) => !n.connected) || data.right.some((n) => !n.connected)

  return (
    <div className="form-section">
      <div
        className="form-section-title"
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
      >
        <span>
          通信フロー
          <span className="form-section-sub-inline">
            {' '}— 検知 → ブローカー → Hapbeat (2 秒ごとに更新・全デバイス共通)
          </span>
        </span>
        <button
          type="button"
          className="form-button-secondary"
          style={{ fontSize: 12, padding: '2px 10px' }}
          onClick={openPopout}
          title="通信フローを別ウィンドウで開く（デバイスを切り替えても保持されます）"
        >
          ⤢ {popout ? '別窓を前面に' : 'ポップアウト'}
        </button>
      </div>

      {data.noBroker ? (
        <div className="form-status muted">
          ブローカー (role=broker) がネットワーク上に見つかりません。AtomS3 ブローカーの電源と Wi-Fi を確認してください。
        </div>
      ) : popout ? (
        <div className="form-status muted">別ウィンドウで表示中（閉じるとここに戻ります）。</div>
      ) : (
        <MqttFlowChartSvg {...data} />
      )}

      {hasGhost && !data.noBroker && (
        <div className="form-status warn" style={{ marginTop: 4 }}>
          破線の「未接続」ノードは、ネットワーク上には居る（mDNS で検出済み）がブローカーに MQTT 接続できていない
          デバイスです。センサ側の「MQTT」タブでブローカー自動検出 / topic root を確認してください。
        </div>
      )}
      <div className="form-status muted" style={{ marginTop: 0 }}>
        クライアント名は各ノードが接続時に publish する presence 情報 (デバイス名) です。
      </div>
    </div>
  )
}

// --- page-level controller (mounted once at the Devices root) --------------

/**
 * Drives the page-level flow chart: polls the broker's get_info every 2 s
 * (independent of the selected device) so the chart is live in any MQTT
 * tab, and renders the live chart into the pop-out window when open. Renders
 * no visible DOM in the main document.
 */
export function MqttFlowController() {
  const { devices, send, lastMessage } = useHelperConnection()
  const data = useMqttFlowData()
  const popout = useMqttFlowStore((s) => s.popout)
  const viewerCount = useMqttFlowStore((s) => s.viewerIds.length)
  const setBrokerTelemetry = useMqttFlowStore((s) => s.setBrokerTelemetry)
  const notePopoutClosed = useMqttFlowStore((s) => s.notePopoutClosed)

  const broker = devices.find((d) => d.role === 'broker')
  const brokerIp = broker?.ipAddress
  // Poll while the chart is on screen (an MQTT tab open or the pop-out open)
  // and a broker exists. NOT gated on the broker's helper-liveness flag: that
  // can false-negative when the single-threaded broker is briefly busy and
  // misses a PING, which would otherwise stop the only poll that refreshes
  // the client list and freeze every sender as a 未接続 ghost (workflow
  // cause #2). A poll to a truly-down broker just fails harmlessly.
  const shouldPoll = !!brokerIp && (viewerCount > 0 || !!popout)

  // Poll the broker for fresh telemetry while a broker exists and is viewed,
  // plus each online MQTT-client device's get_info so the flow can show their
  // topic config (sender topic_root / receiver recv_topics — item 06-14). The
  // results land in infoCache via DeviceDetail's get_info handler. Topic config
  // is near-static, so 2 s is plenty (small deployments — a handful of nodes).
  const sendRef = useRef(send)
  sendRef.current = send
  const mqttNodeIps = devices
    .filter((d) => d.online && (d.role === 'sensor'
      || (d.transports ?? (d.transport ? [d.transport] : [])).includes('mqtt')))
    .map((d) => d.ipAddress)
  const mqttNodeKey = mqttNodeIps.join(',')
  useEffect(() => {
    if (!brokerIp || !shouldPoll) return
    const tick = () => {
      sendRef.current({ type: 'get_info', payload: { ip: brokerIp } })
      for (const ip of mqttNodeKey ? mqttNodeKey.split(',') : []) {
        sendRef.current({ type: 'get_info', payload: { ip } })
      }
    }
    tick()
    const id = window.setInterval(tick, 2000)
    return () => window.clearInterval(id)
  }, [brokerIp, shouldPoll, mqttNodeKey])

  // OWN the broker telemetry: write every broker get_info_result straight into
  // mqttFlowStore, decoupled from deviceStore.infoCache (which DeviceDetail
  // wipes via clearCachesFor on device switch — the root cause of the
  // persistent "sender shows as 未接続 ghost", found 2026-06-13). The DeviceDetail
  // handler still mirrors it into infoCache for other consumers; this is the
  // chart's own authoritative copy.
  useEffect(() => {
    if (!brokerIp || !lastMessage || lastMessage.type !== 'get_info_result') return
    const p = lastMessage.payload as Record<string, unknown>
    if (p.device !== brokerIp) return
    setBrokerTelemetry({
      ip: brokerIp,
      mqtt_running: p.mqtt_running as boolean | undefined,
      mqtt_port: p.mqtt_port as number | undefined,
      mqtt_clients: p.mqtt_clients as MqttClientEntry[] | undefined,
      mqtt_pub_count: p.mqtt_pub_count as number | undefined,
      mqtt_last_topic: p.mqtt_last_topic as string | undefined,
      mqtt_last_payload: p.mqtt_last_payload as string | undefined,
      mqtt_last_from: p.mqtt_last_from as string | undefined,
    })
  }, [lastMessage, brokerIp, setBrokerTelemetry])

  // Watchdog: detect when the user closed the pop-out via its own chrome.
  // (A closed `window` can't notify React; `popout.closed` flipping is
  // invisible until this fires, so keep it brisk — the inline panel shows
  // "別ウィンドウで表示中" until then.)
  useEffect(() => {
    if (!popout) return
    const id = window.setInterval(() => {
      if (popout.closed) notePopoutClosed()
    }, 350)
    return () => window.clearInterval(id)
  }, [popout, notePopoutClosed])

  if (!popout || popout.closed) return null
  return createPortal(
    <div>
      <h3 style={{ margin: '0 0 10px', fontSize: 14, fontWeight: 600 }}>MQTT 通信フロー</h3>
      <MqttFlowChartSvg {...data} />
    </div>,
    popout.document.body,
  )
}
