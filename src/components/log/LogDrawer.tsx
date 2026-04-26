import { useEffect, useRef } from 'react'
import { useHelperConnection } from '@/hooks/useHelperConnection'
import { useDeviceStore } from '@/stores/deviceStore'
import { useLogStore } from '@/stores/logStore'
import './LogDrawer.css'

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
    <div className={`log-drawer${visible ? '' : ' collapsed'}`}>
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
