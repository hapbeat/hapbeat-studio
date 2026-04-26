import { create } from 'zustand'

export interface LogEntry {
  id: number
  ts: number  // ms
  source: string  // "device 192.168.x.x" / "ota" / "ws" / etc.
  message: string
}

const MAX_LINES = 1000
const VISIBLE_KEY = 'hapbeat-studio-log-visible'

interface LogState {
  entries: LogEntry[]
  visible: boolean
  /** When the log drawer is open we keep a TCP log_stream subscription
   * for this IP. Tracked so the App can issue subscribe/unsubscribe
   * messages on visibility / device-selection changes. */
  subscribedIp: string | null
  push: (source: string, message: string) => void
  clear: () => void
  setVisible: (v: boolean) => void
  setSubscribedIp: (ip: string | null) => void
}

let _seq = 0
const initialVisible = (() => {
  try {
    return localStorage.getItem(VISIBLE_KEY) === '1'
  } catch {
    return false
  }
})()

export const useLogStore = create<LogState>((set) => ({
  entries: [],
  visible: initialVisible,
  subscribedIp: null,

  push: (source, message) =>
    set((s) => {
      const next = [
        ...s.entries,
        { id: ++_seq, ts: Date.now(), source, message },
      ]
      if (next.length > MAX_LINES) next.splice(0, next.length - MAX_LINES)
      return { entries: next }
    }),

  clear: () => set({ entries: [] }),

  setVisible: (v) => {
    try {
      localStorage.setItem(VISIBLE_KEY, v ? '1' : '0')
    } catch {
      /* ignore */
    }
    set({ visible: v })
  },

  setSubscribedIp: (ip) => set({ subscribedIp: ip }),
}))
