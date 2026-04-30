import { useCallback, useEffect, useRef, useState } from 'react'
import { useHelperConnection } from '@/hooks/useHelperConnection'
import { useDeviceStore } from '@/stores/deviceStore'
import { useLogStore } from '@/stores/logStore'
import { LocalFsStatus } from '@/components/common/LocalFsStatus'
import './LogDrawer.css'

const HEIGHT_KEY = 'hapbeat-studio-log-drawer-height'
const MIN_HEIGHT = 80
const MAX_HEIGHT_FRACTION = 0.7 // never let the drawer eat more than 70% of viewport
const HARD_MAX_HEIGHT = 5000 // sanity cap for absurd persisted values (corruption)

/**
 * Bottom collapsible log panel mirroring the Manager's `LogDrawer`.
 *
 * - Shows every helper push that has a message field, plus firmware
 *   log lines streamed via `device_log`.
 * - Auto-(un)subscribes to the selected device's TCP log_stream when
 *   the drawer is open.
 * - Auto-scrolls to bottom unless the user scrolled up manually.
 */
export function LogDrawer() {
  const { lastMessage, send, isConnected } = useHelperConnection()
  const selectedIp = useDeviceStore((s) => s.selectedIp)
  const entries = useLogStore((s) => s.entries)
  const visible = useLogStore((s) => s.visible)
  const subscribedIp = useLogStore((s) => s.subscribedIp)
  const setSubscribedIp = useLogStore((s) => s.setSubscribedIp)
  const setVisible = useLogStore((s) => s.setVisible)
  const push = useLogStore((s) => s.push)
  const clear = useLogStore((s) => s.clear)

  const bodyRef = useRef<HTMLDivElement | null>(null)
  const stickToBottomRef = useRef(true)

  // Drawer height — user-adjustable via a drag handle on the header.
  // Persisted so the height is remembered across reloads.
  const [height, setHeight] = useState<number>(() => {
    const raw = localStorage.getItem(HEIGHT_KEY)
    if (raw === null) return 280
    const n = Number(raw)
    // Sanity-cap absurd values so a corrupted localStorage entry
    // (or a previous viewport with a tall window) doesn't render the
    // drawer over the whole UI on first paint. The drag handler also
    // re-clamps against the live viewport on every move.
    if (!Number.isFinite(n) || n < MIN_HEIGHT || n > HARD_MAX_HEIGHT) return 280
    return n
  })
  const dragRef = useRef<{
    startY: number
    startHeight: number
    pointerId: number
  } | null>(null)

  const onDragStart = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // Only allow drag when the drawer is open — collapsed strip is too
      // thin to host a sensible resize gesture and would jump open
      // unexpectedly.
      if (!visible) return
      e.preventDefault()
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      dragRef.current = {
        startY: e.clientY,
        startHeight: height,
        pointerId: e.pointerId,
      }
      document.body.classList.add('log-drawer-resizing')
    },
    [visible, height],
  )

  const onDragMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    // Drag handle sits at the *top* of the drawer; dragging down should
    // shrink the drawer, dragging up should grow it.
    const dy = e.clientY - drag.startY
    const proposed = drag.startHeight - dy
    const cap = Math.max(MIN_HEIGHT, Math.floor(window.innerHeight * MAX_HEIGHT_FRACTION))
    const next = Math.max(MIN_HEIGHT, Math.min(cap, proposed))
    setHeight(next)
  }, [])

  const onDragEnd = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current
      if (!drag || drag.pointerId !== e.pointerId) return
      ;(e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId)
      dragRef.current = null
      document.body.classList.remove('log-drawer-resizing')
      // Save once at the end of the gesture — no point spamming
      // localStorage on every pointermove. Quota / private-mode
      // failures are non-fatal; just skip the persist.
      try {
        localStorage.setItem(HEIGHT_KEY, String(height))
      } catch {
        /* storage unavailable / quota exceeded — drag still works in-memory */
      }
    },
    [height],
  )

  // Defensive cleanup: if the drawer is collapsed (or unmounted)
  // mid-drag, the body class would otherwise stay stuck and lock the
  // cursor / disable text selection forever. The pointercancel
  // handler covers most cases; this useEffect catches the rest.
  useEffect(() => {
    return () => {
      dragRef.current = null
      document.body.classList.remove('log-drawer-resizing')
    }
  }, [])

  // Drain helper push messages into the log buffer.
  useEffect(() => {
    if (!lastMessage) return
    const t = lastMessage.type
    const p = lastMessage.payload as Record<string, unknown>

    if (t === 'device_log' && typeof p.device === 'string') {
      push(`device ${p.device}`, String(p.msg ?? ''))
      return
    }

    // Surface ack/error/result messages so the user can see what helper did.
    if (t === 'write_result') {
      const ip = (p.ip as string) || ''
      push(`write ${ip}`,
        `${p.success ? 'OK' : 'NG'} — ${p.message ?? p.error ?? ''}`)
    } else if (t === 'deploy_result') {
      const ip = (p.ip as string) || ''
      push(`kit ${ip}`,
        `${p.success ? 'OK' : 'NG'} — ${p.message ?? ''} ${p.kit_id ? `[${p.kit_id}]` : ''}`)
    } else if (t === 'ota_progress') {
      push(`ota ${p.device}`, `${p.percent}% — ${p.message}`)
    } else if (t === 'ota_result') {
      push(`ota ${p.device}`,
        `${p.success ? '✓' : '✗'} ${p.message ?? ''}`)
    } else if (t === 'error') {
      push('helper', `ERROR: ${p.message ?? ''}`)
    } else if (t === 'log_subscription' && typeof p.device === 'string') {
      if (p.stopped) push('helper', `log_stream stopped (${p.device})`)
      else if (p.ok) push('helper', `log_stream subscribed (${p.device})`)
    } else if (t === 'ping_result' && typeof p.device === 'string') {
      if (typeof p.rtt_ms === 'number') {
        push(`ping ${p.device}`, `PONG ${(p.rtt_ms as number).toFixed(2)} ms`)
      } else {
        push(`ping ${p.device}`, `PING failed: ${p.error ?? 'no response'}`)
      }
    }
  }, [lastMessage, push])

  // Subscribe / unsubscribe to firmware log stream as drawer + device change.
  useEffect(() => {
    if (!isConnected) return
    if (visible && selectedIp) {
      if (subscribedIp !== selectedIp) {
        if (subscribedIp) {
          send({ type: 'unsubscribe_logs', payload: { ip: subscribedIp } })
        }
        send({ type: 'subscribe_logs', payload: { ip: selectedIp } })
        setSubscribedIp(selectedIp)
      }
    } else if (subscribedIp) {
      send({ type: 'unsubscribe_logs', payload: { ip: subscribedIp } })
      setSubscribedIp(null)
    }
  }, [visible, selectedIp, subscribedIp, isConnected, send, setSubscribedIp])

  // Auto-scroll: stick to bottom unless the user scrolled up.
  useEffect(() => {
    const el = bodyRef.current
    if (!el || !stickToBottomRef.current) return
    el.scrollTop = el.scrollHeight
  }, [entries, visible])

  const onScroll = () => {
    const el = bodyRef.current
    if (!el) return
    // 2 px slop for sub-pixel rounding.
    stickToBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight <= 2
  }

  return (
    <div
      className={`log-drawer${visible ? '' : ' collapsed'}`}
      style={visible ? { height } : undefined}
    >
      {visible && (
        <div
          className="log-drawer-resize"
          onPointerDown={onDragStart}
          onPointerMove={onDragMove}
          onPointerUp={onDragEnd}
          onPointerCancel={onDragEnd}
          title="ドラッグでログ高さを調整"
          role="separator"
          aria-orientation="horizontal"
          aria-label="ログ高さリサイズ"
        />
      )}
      <div className="log-drawer-header">
        <button
          className="log-drawer-toggle"
          onClick={() => setVisible(!visible)}
          title={visible ? 'ログを隠す' : 'ログを表示'}
        >
          {visible ? '▼' : '▲'} ログ
        </button>
        <span className="log-drawer-count">
          {entries.length} 行{subscribedIp ? ` · ${subscribedIp} 購読中` : ''}
        </span>
        <span style={{ flex: 1 }} />
        <LocalFsStatus />
        <button className="log-drawer-clear" onClick={clear}>クリア</button>
      </div>
      {visible && (
        <div className="log-drawer-body" ref={bodyRef} onScroll={onScroll}>
          {entries.length === 0 ? (
            <div className="log-drawer-empty">
              （まだログはありません）
            </div>
          ) : (
            entries.map((e) => (
              <div key={e.id} className="log-line">
                <span className="log-time">{fmtTime(e.ts)}</span>
                <span className="log-source">{e.source}</span>
                <span className="log-msg">{e.message}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}

function fmtTime(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
