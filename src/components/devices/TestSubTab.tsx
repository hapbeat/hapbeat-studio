import { useEffect, useRef, useState } from 'react'
import { useHelperConnection } from '@/hooks/useHelperConnection'
import type { DeviceInfo, ManagerMessage } from '@/types/manager'
import { StreamingTestSection } from './StreamingTestSection'

const HISTORY_KEY = 'hapbeat-studio-test-event-history'
const TARGET_KEY = 'hapbeat-studio-test-target'
const INTENSITY_KEY = 'hapbeat-studio-test-intensity'
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
 * Per-device 再生テスト pane. Layout mirrors the Kit editor's mode
 * grouping: top section = `[♪] CLIP ストリーミングテスト`, bottom
 * section = `[>] FIRE コマンド送信テスト` (event-id + history +
 * selected-device send + broadcast send).
 *
 * Intensity scope: only the CLIP streaming pipeline. FIRE PLAY honors
 * the manifest-baked `intensity` field (entry->gain on the device,
 * set when the kit was deployed) — passing a runtime gain multiplier
 * here would override that intent, so we send `gain = 1.0` for FIRE.
 * That matches what the Studio CLAUDE.md describes as the kit-time
 * source of truth.
 */
export function TestSubTab({ device, sendTo }: Props) {
  const { lastMessage, send } = useHelperConnection()

  const [history, setHistory] = useState<string[]>(loadHistory)
  const [eventId, setEventId] = useState<string>(history[0] ?? '')
  const [target, setTarget] = useState<string>(
    () => localStorage.getItem(TARGET_KEY) ?? '',
  )
  const [pingResult, setPingResult] = useState<string>('')

  // Intensity slider — scoped to the streaming test only. CLIP stream
  // multiplies PCM samples by this value per chunk (live). FIRE
  // (command) playback does *not* read this; the firmware uses the
  // kit's manifest intensity (entry->gain) baked in at deploy time.
  const [intensityPct, setIntensityPct] = useState<number>(() => {
    const raw = localStorage.getItem(INTENSITY_KEY)
    if (raw === null) return 100
    const v = Number(raw)
    return Number.isFinite(v) && v >= 0 && v <= 100 ? v : 100
  })
  useEffect(() => {
    localStorage.setItem(INTENSITY_KEY, String(intensityPct))
  }, [intensityPct])
  const intensityRef = useRef(intensityPct)
  intensityRef.current = intensityPct

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

  // FIRE PLAY uses gain=1.0 so the manifest-baked intensity is the
  // sole source of truth. The user controls FIRE intensity by editing
  // the kit's clip amp (kit-time), not by this transient slider.
  const playSelected = () => {
    if (!eventId.trim()) return
    recordEvent(eventId.trim())
    sendTo({
      type: 'preview_event',
      payload: {
        event_id: eventId.trim(),
        target: device.address || '',
        gain: 1.0,
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
    // gain=1.0 — see playSelected note: manifest intensity wins.
    send({
      type: 'preview_event',
      payload: {
        event_id: eventId.trim(),
        target: target.trim(),
        gain: 1.0,
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
      {/* CLIP — UDP streaming test (folder browser, top of pane) */}
      <StreamingTestSection
        device={device}
        intensityRef={intensityRef}
        intensityPct={intensityPct}
        onIntensityChange={setIntensityPct}
      />

      {/* FIRE — command send test (event-id + history + send buttons) */}
      <div className="form-section">
        <div className="form-section-title">
          <span className="mode-prefix mode-prefix-fire">&gt;&nbsp;FIRE</span>
          コマンド送信テスト
          <span className="form-section-sub-inline">
            {' '}— Event ID を投げて Kit が再生する FIRE モードのイベントを試す
          </span>
        </div>

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

        <div className="form-status muted" style={{ padding: '0 4px 6px' }}>
          履歴 ({history.length}/{MAX_HISTORY}):
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

        <div className="form-action-row">
          <span className="form-action-label">選択デバイス</span>
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
          <span className="form-action-label">ブロードキャスト</span>
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
    </>
  )
}
