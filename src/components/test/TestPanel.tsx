import { useEffect, useState } from 'react'
import { useHelperConnection } from '@/hooks/useHelperConnection'
import { useDeviceStore } from '@/stores/deviceStore'
import './Test.css'

const HISTORY_KEY = 'hapbeat-studio-test-event-history'
const GAIN_KEY = 'hapbeat-studio-test-gain'
const TARGET_KEY = 'hapbeat-studio-test-target'
const MAX_HISTORY = 5

function loadHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((s) => typeof s === 'string') : []
  } catch {
    return []
  }
}

/**
 * Replicates the Manager `TestPage` controls — event id history,
 * gain slider, PLAY/STOP/PING for the selected device, and
 * PLAY ALL / STOP ALL broadcast with optional target filter.
 *
 * Streaming-test (folder browse + audio file player) is intentionally
 * not ported: the existing Audio Bridge in Manager handles the same
 * use case and is being relocated to a future Live Audio tab.
 */
export function TestPanel() {
  const { isConnected, devices, lastMessage, send } = useHelperConnection()
  const selectedIp = useDeviceStore((s) => s.selectedIp)

  const [history, setHistory] = useState<string[]>(loadHistory)
  const [eventId, setEventId] = useState<string>(history[0] ?? '')
  const [gain, setGain] = useState<number>(() => {
    const v = Number(localStorage.getItem(GAIN_KEY))
    return Number.isFinite(v) && v >= 0 && v <= 100 ? v : 50
  })
  const [target, setTarget] = useState<string>(
    () => localStorage.getItem(TARGET_KEY) ?? '',
  )
  const [pingResult, setPingResult] = useState<string>('')

  useEffect(() => {
    localStorage.setItem(GAIN_KEY, String(gain))
  }, [gain])

  useEffect(() => {
    localStorage.setItem(TARGET_KEY, target)
  }, [target])

  // Listen for ping_result push.
  useEffect(() => {
    if (!lastMessage) return
    if (lastMessage.type !== 'ping_result') return
    const p = lastMessage.payload as Record<string, unknown>
    if (p.error) {
      setPingResult(`PING failed: ${p.error}`)
    } else if (typeof p.rtt_ms === 'number') {
      setPingResult(`PONG ${p.rtt_ms.toFixed(2)} ms (${String(p.device)})`)
    }
    const t = setTimeout(() => setPingResult(''), 4000)
    return () => clearTimeout(t)
  }, [lastMessage])

  const recordEvent = (id: string) => {
    if (!id) return
    const next = [id, ...history.filter((h) => h !== id)].slice(0, MAX_HISTORY)
    setHistory(next)
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(next))
    } catch {
      /* ignore */
    }
  }

  const gainFloat = gain / 100

  const playSelected = () => {
    if (!eventId.trim()) return
    recordEvent(eventId.trim())
    send({
      type: 'preview_event',
      payload: {
        event_id: eventId.trim(),
        // PLAY is broadcast; the address/group filter is up to the device.
        // For "selected only" we still pass the device's address as target so
        // other devices ignore it.
        target: selectedDeviceAddress(devices, selectedIp) ?? '',
        gain: gainFloat,
      },
    })
  }

  const stopSelected = () => {
    if (!eventId.trim()) return
    send({
      type: 'stop_event',
      payload: {
        event_id: eventId.trim(),
        target: selectedDeviceAddress(devices, selectedIp) ?? '',
      },
    })
  }

  const ping = () => {
    if (!selectedIp) {
      setPingResult('PING: デバイス未選択')
      return
    }
    send({ type: 'ping_device', payload: { ip: selectedIp } })
    setPingResult('pinging…')
  }

  const playAll = () => {
    if (!eventId.trim()) return
    recordEvent(eventId.trim())
    send({
      type: 'preview_event',
      payload: {
        event_id: eventId.trim(),
        target: target.trim(),
        gain: gainFloat,
      },
    })
  }

  const stopAll = () => {
    send({
      type: 'stop_event',
      payload: { event_id: '', target: target.trim() },
    })
  }

  const selDev = devices.find((d) => d.ipAddress === selectedIp)

  return (
    <div className="test-page">
      {!isConnected && (
        <div className="test-banner warn">
          Helper 未接続 — 起動するまで PLAY/STOP は届きません
        </div>
      )}

      {/* === Event ID === */}
      <div className="test-section">
        <div className="test-section-title">イベント設定</div>
        <div className="test-row">
          <label>Event ID</label>
          <input
            list="hapbeat-event-history"
            className="form-input mono"
            value={eventId}
            onChange={(e) => setEventId(e.target.value)}
            placeholder="impact.damage"
          />
          <datalist id="hapbeat-event-history">
            {history.map((h) => (
              <option key={h} value={h} />
            ))}
          </datalist>
        </div>
        <div className="test-row">
          <label>Gain</label>
          <input
            type="range"
            min={0}
            max={100}
            value={gain}
            onChange={(e) => setGain(Number(e.target.value))}
            style={{ flex: 1 }}
          />
          <span className="test-gain-readout">{gain}%</span>
        </div>
      </div>

      {/* === Selected device === */}
      <div className="test-section">
        <div className="test-section-title">
          選択デバイスに送信
          {selDev && (
            <span className="test-section-sub">
              {' '}— {selDev.name} ({selDev.address || selDev.ipAddress})
            </span>
          )}
        </div>
        <div className="test-action-row">
          <button
            className="form-button"
            onClick={playSelected}
            disabled={!isConnected || !eventId.trim() || !selDev}
          >
            ▶ PLAY
          </button>
          <button
            className="form-button-secondary"
            onClick={stopSelected}
            disabled={!isConnected || !eventId.trim() || !selDev}
          >
            ■ STOP
          </button>
          <button
            className="form-button-secondary"
            onClick={ping}
            disabled={!isConnected || !selDev}
          >
            PING
          </button>
          {pingResult && <span className="form-status muted">{pingResult}</span>}
        </div>
      </div>

      {/* === Broadcast === */}
      <div className="test-section">
        <div className="test-section-title">ブロードキャスト送信</div>
        <div className="test-row">
          <label>Target</label>
          <input
            className="form-input mono"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder="例: player_1, */chest, 空 = 全台"
          />
        </div>
        <div className="test-action-row">
          <button
            className="form-button"
            onClick={playAll}
            disabled={!isConnected || !eventId.trim()}
          >
            ▶ PLAY ALL
          </button>
          <button
            className="form-button-secondary"
            onClick={stopAll}
            disabled={!isConnected}
          >
            ■ STOP ALL
          </button>
        </div>
      </div>

      <div className="test-foot">
        Event ID 履歴 ({history.length}/{MAX_HISTORY}):
        {history.length === 0 ? (
          <em> （履歴なし）</em>
        ) : (
          <ul className="test-history">
            {history.map((h) => (
              <li key={h}>
                <button
                  className="test-history-btn"
                  onClick={() => setEventId(h)}
                >
                  {h}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function selectedDeviceAddress(
  devices: { ipAddress: string; address: string }[],
  ip: string | null,
): string | null {
  if (!ip) return null
  const d = devices.find((dd) => dd.ipAddress === ip)
  return d?.address || null
}
