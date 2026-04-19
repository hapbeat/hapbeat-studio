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

const MANAGER_WS_URL = 'ws://localhost:7703'
const RECONNECT_INTERVAL_BASE = 2000
const RECONNECT_INTERVAL_MAX = 30000

interface ManagerConnectionValue {
  isConnected: boolean
  devices: DeviceInfo[]
  lastMessage: ManagerMessage | null
  send: (message: ManagerMessage) => void
}

const ManagerConnectionContext = createContext<ManagerConnectionValue | null>(null)

/**
 * Provider that owns the single WebSocket to Manager.
 * Wrap the app once (in main.tsx). All useManagerConnection() consumers
 * share the same connection and state.
 */
export function ManagerConnectionProvider({ children }: { children: ReactNode }) {
  const [isConnected, setIsConnected] = useState(false)
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
      ws = new WebSocket(MANAGER_WS_URL)
    } catch (err) {
      console.error('[Manager] 接続の作成に失敗:', err)
      scheduleReconnect()
      return
    }
    wsRef.current = ws

    // 各 handler は「今もアクティブな ws か」を確認してから動く
    ws.onopen = () => {
      if (wsRef.current !== ws) return
      console.log('[Manager] 接続成功')
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
      } catch (err) {
        console.error('[Manager] メッセージのパースに失敗:', err)
      }
    }

    ws.onclose = () => {
      if (wsRef.current !== ws) return
      console.log('[Manager] 接続が切断されました')
      setIsConnected(false)
      wsRef.current = null
      scheduleReconnect()
    }

    ws.onerror = (err) => {
      if (wsRef.current !== ws) return
      console.error('[Manager] WebSocket エラー:', err)
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
    console.log(`[Manager] ${Math.round(delay / 1000)}秒後に再接続を試行...`)
    reconnectTimerRef.current = setTimeout(() => {
      reconnectAttemptRef.current += 1
      connect()
    }, delay)
  }, [clearReconnectTimer, connect])

  const send = useCallback((message: ManagerMessage) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message))
    } else {
      console.warn('[Manager] 未接続のため送信できません:', message.type)
    }
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
    <ManagerConnectionContext.Provider value={{ isConnected, devices, lastMessage, send }}>
      {children}
    </ManagerConnectionContext.Provider>
  )
}

/**
 * Consume the shared Manager connection.
 * Must be inside <ManagerConnectionProvider>.
 */
export function useManagerConnection(): ManagerConnectionValue {
  const ctx = useContext(ManagerConnectionContext)
  if (!ctx) {
    throw new Error('useManagerConnection must be used inside <ManagerConnectionProvider>')
  }
  return ctx
}
