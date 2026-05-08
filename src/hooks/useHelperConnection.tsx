import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type { DeviceInfo, ManagerMessage } from '@/types/manager'

const HELPER_WS_URL = 'ws://localhost:7703'
const RECONNECT_INTERVAL_BASE = 2000
const RECONNECT_INTERVAL_MAX = 30000

interface HelperConnectionValue {
  isConnected: boolean
  /** Helper version (e.g. "0.2.3") sent by helper on connect. null until
   *  the `helper_hello` message arrives. */
  helperVersion: string | null
  devices: DeviceInfo[]
  lastMessage: ManagerMessage | null
  send: (message: ManagerMessage) => void
  /**
   * Push a synthetic `ManagerMessage` into the `lastMessage` channel as
   * if it had arrived from helper. Used by the Serial transport
   * (`useDeviceTransport`) to forward firmware responses through the
   * same `*_result` handlers that LAN devices use — the alternative is
   * to duplicate the deviceStore wiring in both transports. Synthetic
   * messages must carry `payload.device = <selectedIp>` so the
   * existing handlers that key on `p.device` route them correctly.
   */
  injectMessage: (message: ManagerMessage) => void
}

const HelperConnectionContext = createContext<HelperConnectionValue | null>(null)

/**
 * Provider that owns the single WebSocket to hapbeat-helper.
 * Wrap the app once (in main.tsx). All useHelperConnection() consumers
 * share the same connection and state.
 */
export function HelperConnectionProvider({ children }: { children: ReactNode }) {
  const [isConnected, setIsConnected] = useState(false)
  const [helperVersion, setHelperVersion] = useState<string | null>(null)
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [lastMessage, setLastMessage] = useState<ManagerMessage | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reconnectAttemptRef = useRef(0)

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
  }, [])

  const connect = useCallback(() => {
    // 既存の接続があれば、ハンドラを detach してから閉じる
    // (古い ws の遅延発火 onclose が新しい wsRef を null 化するのを防ぐ)
    const old = wsRef.current
    if (old) {
      old.onopen = null
      old.onmessage = null
      old.onclose = null
      old.onerror = null
      try { old.close() } catch { /* ignore */ }
    }
    wsRef.current = null

    let ws: WebSocket
    try {
      ws = new WebSocket(HELPER_WS_URL)
    } catch (err) {
      console.error('[Helper] 接続の作成に失敗:', err)
      scheduleReconnect()
      return
    }
    wsRef.current = ws

    // 各 handler は「今もアクティブな ws か」を確認してから動く
    ws.onopen = () => {
      if (wsRef.current !== ws) return
      console.log('[Helper] 接続成功')
      setIsConnected(true)
      reconnectAttemptRef.current = 0
      ws.send(JSON.stringify({ type: 'list_devices', payload: {} }))
    }

    ws.onmessage = (event) => {
      if (wsRef.current !== ws) return
      try {
        const message: ManagerMessage = JSON.parse(event.data)
        setLastMessage(message)
        if (message.type === 'device_list' && Array.isArray(message.payload.devices)) {
          setDevices(message.payload.devices as DeviceInfo[])
        }
        if (message.type === 'helper_hello') {
          const v = (message.payload as { version?: string }).version
          if (v) setHelperVersion(v)
        }
      } catch (err) {
        console.error('[Helper] メッセージのパースに失敗:', err)
      }
    }

    ws.onclose = () => {
      if (wsRef.current !== ws) return
      console.log('[Helper] 接続が切断されました')
      setIsConnected(false)
      setHelperVersion(null)
      wsRef.current = null
      scheduleReconnect()
    }

    ws.onerror = (err) => {
      if (wsRef.current !== ws) return
      console.error('[Helper] WebSocket エラー:', err)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const scheduleReconnect = useCallback(() => {
    clearReconnectTimer()
    const attempt = reconnectAttemptRef.current
    const delay = Math.min(
      RECONNECT_INTERVAL_BASE * Math.pow(1.5, attempt),
      RECONNECT_INTERVAL_MAX
    )
    console.log(`[Helper] ${Math.round(delay / 1000)}秒後に再接続を試行...`)
    reconnectTimerRef.current = setTimeout(() => {
      reconnectAttemptRef.current += 1
      connect()
    }, delay)
  }, [clearReconnectTimer, connect])

  const send = useCallback((message: ManagerMessage) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message))
    } else {
      console.warn('[Helper] 未接続のため送信できません:', message.type)
    }
  }, [])

  const injectMessage = useCallback((message: ManagerMessage) => {
    setLastMessage(message)
  }, [])

  useEffect(() => {
    connect()
    return () => {
      clearReconnectTimer()
      const ws = wsRef.current
      if (ws) {
        ws.onopen = null
        ws.onmessage = null
        ws.onclose = null
        ws.onerror = null
        try { ws.close() } catch { /* ignore */ }
        wsRef.current = null
      }
    }
  }, [connect, clearReconnectTimer])

  return (
    <HelperConnectionContext.Provider value={{ isConnected, helperVersion, devices, lastMessage, send, injectMessage }}>
      {children}
    </HelperConnectionContext.Provider>
  )
}

/**
 * Consume the shared Helper connection.
 * Must be inside <HelperConnectionProvider>.
 */
export function useHelperConnection(): HelperConnectionValue {
  const ctx = useContext(HelperConnectionContext)
  if (!ctx) {
    throw new Error('useHelperConnection must be used inside <HelperConnectionProvider>')
  }
  return ctx
}
