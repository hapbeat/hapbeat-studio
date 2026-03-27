import { useEffect, useRef, useState, useCallback } from 'react'
import type { DeviceInfo, ManagerMessage } from '@/types/manager'

const MANAGER_WS_URL = 'ws://localhost:7703'
const RECONNECT_INTERVAL_BASE = 2000
const RECONNECT_INTERVAL_MAX = 30000

interface UseManagerConnectionReturn {
  isConnected: boolean
  devices: DeviceInfo[]
  lastMessage: ManagerMessage | null
  send: (message: ManagerMessage) => void
}

export function useManagerConnection(): UseManagerConnectionReturn {
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
    // 既存の接続があれば閉じる
    if (wsRef.current) {
      wsRef.current.close()
      wsRef.current = null
    }

    try {
      const ws = new WebSocket(MANAGER_WS_URL)
      wsRef.current = ws

      ws.onopen = () => {
        console.log('[Manager] 接続成功')
        setIsConnected(true)
        reconnectAttemptRef.current = 0

        // デバイス一覧を要求
        ws.send(JSON.stringify({ type: 'list_devices', payload: {} }))
      }

      ws.onmessage = (event) => {
        try {
          const message: ManagerMessage = JSON.parse(event.data)
          setLastMessage(message)

          // デバイス一覧の更新
          if (message.type === 'device_list' && Array.isArray(message.payload.devices)) {
            setDevices(message.payload.devices as DeviceInfo[])
          }
        } catch (err) {
          console.error('[Manager] メッセージのパースに失敗:', err)
        }
      }

      ws.onclose = () => {
        console.log('[Manager] 接続が切断されました')
        setIsConnected(false)
        wsRef.current = null
        scheduleReconnect()
      }

      ws.onerror = (err) => {
        console.error('[Manager] WebSocket エラー:', err)
        // onclose が自動的に呼ばれるため、ここでは再接続しない
      }
    } catch (err) {
      console.error('[Manager] 接続の作成に失敗:', err)
      scheduleReconnect()
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
      if (wsRef.current) {
        wsRef.current.close()
        wsRef.current = null
      }
    }
  }, [connect, clearReconnectTimer])

  return { isConnected, devices, lastMessage, send }
}
