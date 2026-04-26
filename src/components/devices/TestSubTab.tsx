import { useEffect, useState } from 'react'
import { useHelperConnection } from '@/hooks/useHelperConnection'
import type { DeviceInfo, ManagerMessage } from '@/types/manager'
import { StreamingTestSection } from './StreamingTestSection'

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

interface Props {
  device: DeviceInfo
  sendTo: (msg: ManagerMessage) => void
}

/**
 * Per-device 再生テスト pane — Event ID + Gain + PLAY/STOP/PING
 * for the selected device, plus a broadcast PLAY ALL / STOP ALL with
 * an optional target filter.
 */
export function TestSubTab({ device, sendTo }: Props) {
  const { lastMessage, send } = useHelperConnection()

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

  useEffect(() => { localStorage.setItem(GAIN_KEY, String(gain)) }, [gain])
  useEffect(() => { localStorage.setItem(TARGET_KEY, target) }, [target])

  useEffect(() => {
    if (!lastMessage || lastMessage.type !== 'ping_result') return
    const p = lastMessage.payload as Record<string, unknown>
    if (p.error) {
      setPingResult(`PING failed: ${p.error}`)
    } else if (typeof p.rtt_ms === 'number') {
      setPingResult(`PONG ${p.rtt_ms.toFixed(2)} ms`)
    }
    const t = setTimeout(() => setPingResult(''), 4000)
    return () => clearTimeout(t)
  }, [lastMessage])

  const recordEvent = (id: string) => {
    if (!id) return
    const next = [id, ...history.filter((h) => h !== id)].slice(0, MAX_HISTORY)
    setHistory(next)
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(next)) } catch { /* ignore */ }
  }

  const gainFloat = gain / 100

  const playSelected = () => {
    if (!eventId.trim()) return
    recordEvent(eventId.trim())
    sendTo({
      type: 'preview_event',
      payload: {
        event_id: eventId.trim(),
        target: device.address || '',
        gain: gainFloat,
      },
    })
  }

  const stopSelected = () => {
    if (!eventId.trim()) return
    sendTo({
      type: 'stop_event',
      payload: {
        event_id: eventId.trim(),
        target: device.address || '',
      },
    })
  }

  const ping = () => {
    sendTo({ type: 'ping_device', payload: {} })
    setPingResult('pinging…')
    // Local watchdog: helper waits up to 2 s for the PONG, plus tiny
    // round-trip overhead. If nothing arrives in 3 s, it's a helper-or-
    // network problem the user should know about.
    setTimeout(() => {
      setPingResult((cur) => (cur === 'pinging…' ? 'no response (timeout)' : cur))
    }, 3000)
  }

  const playAll = () => {
    if (!eventId.trim()) return
    recordEvent(eventId.trim())
    // Broadcast — bypass selected device, use the global send.
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

  return (
    <>
      <div className="form-section">
        <div className="form-section-title">イベント設定</div>
        <div className="form-row">
          <label>Event ID</label>
          <input
            list="hapbeat-event-history"
            className="form-input mono"
            value={eventId}
            onChange={(e) => setEventId(e.target.value)}
            placeholder="impact.damage"
          />
          <datalist id="hapbeat-event-history">
            {history.map((h) => <option key={h} value={h} />)}
          </datalist>
          <span />
        </div>
        <div className="form-row">
          <label>Gain</label>
          <div className="form-row-multi" style={{ width: '100%' }}>
            <input
              type="range"
              min={0}
              max={100}
              value={gain}
              onChange={(e) => setGain(Number(e.target.value))}
              style={{ flex: 1 }}
            />
            <span className="form-input mono short" style={{ textAlign: 'right' }}>
              {gain}%
            </span>
          </div>
          <span />
        </div>
      </div>

      <div className="form-section">
        <div className="form-section-title">
          選択デバイスに送信
          <span className="form-section-sub-inline">
            {' — '}{device.name} ({device.address || device.ipAddress})
          </span>
        </div>
        <div className="form-action-row">
          <button
            className="form-button"
            onClick={playSelected}
            disabled={!device.online || !eventId.trim()}
          >
            ▶ PLAY
          </button>
          <button
            className="form-button-secondary"
            onClick={stopSelected}
            disabled={!device.online || !eventId.trim()}
          >
            ■ STOP
          </button>
          <button
            className="form-button-secondary"
            onClick={ping}
            disabled={!device.online}
          >
            PING
          </button>
          {pingResult && <span className="form-status muted">{pingResult}</span>}
        </div>
      </div>

      <div className="form-section">
        <div className="form-section-title">ブロードキャスト送信</div>
        <div className="form-row">
          <label>Target</label>
          <input
            className="form-input mono"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder="例: player_1, */chest, 空 = 全台"
          />
          <span />
        </div>
        <div className="form-action-row">
          <button
            className="form-button"
            onClick={playAll}
            disabled={!eventId.trim()}
          >
            ▶ PLAY ALL
          </button>
          <button className="form-button-secondary" onClick={stopAll}>
            ■ STOP ALL
          </button>
        </div>
      </div>

      <StreamingTestSection device={device} />

      <div className="form-status muted" style={{ padding: '0 4px' }}>
        Event ID 履歴 ({history.length}/{MAX_HISTORY}):
        {history.length === 0 ? (
          <em> （履歴なし）</em>
        ) : (
          <ul className="event-history-list">
            {history.map((h) => (
              <li key={h}>
                <button
                  className="event-history-btn"
                  onClick={() => setEventId(h)}
                >
                  {h}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  )
}
