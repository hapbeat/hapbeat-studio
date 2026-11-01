import { useEffect, useRef, useState } from 'react'
import { useHelperConnection } from '@/hooks/useHelperConnection'
import type { DeviceInfo, ManagerMessage } from '@/types/manager'
import { useToast } from '@/components/common/Toast'
import { StreamingTestSection } from './StreamingTestSection'
import { useI18n } from '@/i18n/I18nProvider'

const HISTORY_KEY = 'hapbeat-studio-test-event-history'
const TARGET_KEY = 'hapbeat-studio-test-target'
const GAIN_KEY = 'hapbeat-studio-test-gain'
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
 * Gain scope: only the CLIP streaming pipeline. The FIRE test sends a
 * free-text Event ID with `gain = 1.0`: the device does not read the
 * manifest's `clip_gain` (DEC-103, the sender multiplies it in), so this
 * test plays the installed WAV as it is (no Kit lookup here).
 */
export function TestSubTab({ device, sendTo }: Props) {
  const { t } = useI18n()
  const { lastMessage, send } = useHelperConnection()
  const { toast, setAnchor } = useToast()

  const [history, setHistory] = useState<string[]>(loadHistory)
  const [eventId, setEventId] = useState<string>(history[0] ?? '')
  const [target, setTarget] = useState<string>(
    () => localStorage.getItem(TARGET_KEY) ?? '',
  )
  // PING tracking. `ping_result` carries no correlation token, so we tag
  // each click with a generation number: only the latest outstanding ping
  // resolves, and a stale watchdog from an earlier click can't fire a false
  // timeout or swallow a real PONG (rapid re-ping). `pingBtnRef` lets the
  // async PONG/timeout toast re-anchor to the PING button even if another
  // control set the shared toast anchor meanwhile.
  const pingGenRef = useRef(0)       // generation of the most recent ping
  const pingDoneRef = useRef(0)      // highest generation already resolved
  const pingBtnRef = useRef<HTMLButtonElement | null>(null)
  const pingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Clear the watchdog if the component unmounts mid-ping (tab/device switch)
  // so it can't toast a stray timeout after navigating away.
  useEffect(() => () => { if (pingTimerRef.current) clearTimeout(pingTimerRef.current) }, [])

  // Gain slider (app gain) — scoped to the streaming test only. The CLIP
  // stream multiplies PCM samples by this value per chunk (live). The
  // FIRE test below does *not* read it (it sends gain = 1.0).
  const [gainPct, setGainPct] = useState<number>(() => {
    const raw = localStorage.getItem(GAIN_KEY)
    if (raw === null) return 100
    const v = Number(raw)
    return Number.isFinite(v) && v >= 0 && v <= 100 ? v : 100
  })
  useEffect(() => {
    localStorage.setItem(GAIN_KEY, String(gainPct))
  }, [gainPct])
  const gainRef = useRef(gainPct)
  gainRef.current = gainPct

  useEffect(() => { localStorage.setItem(TARGET_KEY, target) }, [target])

  useEffect(() => {
    if (!lastMessage || lastMessage.type !== 'ping_result') return
    // Resolve only if a ping is still outstanding (latest gen unresolved).
    if (pingDoneRef.current >= pingGenRef.current) return
    pingDoneRef.current = pingGenRef.current
    if (pingTimerRef.current) { clearTimeout(pingTimerRef.current); pingTimerRef.current = null }
    if (pingBtnRef.current) setAnchor(pingBtnRef.current)
    const p = lastMessage.payload as Record<string, unknown>
    if (p.error) {
      toast(`PING failed: ${p.error}`, 'error')
    } else if (typeof p.rtt_ms === 'number') {
      toast(`PONG ${p.rtt_ms.toFixed(2)} ms`, 'success')
    }
  }, [lastMessage, toast, setAnchor])

  const recordEvent = (id: string) => {
    if (!id) return
    const next = [id, ...history.filter((h) => h !== id)].slice(0, MAX_HISTORY)
    setHistory(next)
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(next)) } catch { /* ignore */ }
  }

  // FIRE PLAY uses gain=1.0: the installed WAV as it is (the device
  // never applies the manifest clip_gain; see the component comment).
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

  const ping = (e: React.MouseEvent<HTMLButtonElement>) => {
    const gen = ++pingGenRef.current
    pingBtnRef.current = e.currentTarget
    setAnchor(e.currentTarget)
    sendTo({ type: 'ping_device', payload: {} })
    toast(t('manage.fire.pingSent'), 'info')
    // Local watchdog: helper waits up to 2 s for the PONG, plus tiny
    // round-trip overhead. If nothing arrives in 3 s, it's a helper-or-
    // network problem the user should know about. Replace any prior
    // pending watchdog; only fire if *this* gen is still unresolved.
    if (pingTimerRef.current) clearTimeout(pingTimerRef.current)
    pingTimerRef.current = setTimeout(() => {
      pingTimerRef.current = null
      if (pingDoneRef.current < gen) {
        pingDoneRef.current = gen
        if (pingBtnRef.current) setAnchor(pingBtnRef.current)
        toast('no response (timeout)', 'error')
      }
    }, 3000)
  }

  const playAll = () => {
    if (!eventId.trim()) return
    recordEvent(eventId.trim())
    // Broadcast — bypass selected device, use the global send.
    // gain=1.0 — see playSelected note.
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
        gainRef={gainRef}
        gainPct={gainPct}
        onGainChange={setGainPct}
      />

      {/* FIRE — command send test (event-id + history + send buttons) */}
      <div className="form-section">
        <div className="form-section-title">
          <span className="mode-prefix mode-prefix-fire">&gt;&nbsp;FIRE</span>
          {t('manage.fire.title')}
          <span className="form-section-sub-inline">
            {' '}{t('manage.fire.description')}
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
          {t('manage.fire.history', { count: history.length, max: MAX_HISTORY })}
          {history.length === 0 ? (
            <em> {t('manage.fire.noHistory')}</em>
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
          <span className="form-action-label">{t('manage.fire.selected')}</span>
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
        </div>

        <div className="form-row">
          <label>Target</label>
          <input
            className="form-input mono"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder={t('manage.fire.targetPlaceholder')}
          />
          <span />
        </div>
        <div className="form-action-row">
          <span className="form-action-label">{t('manage.fire.broadcast')}</span>
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
