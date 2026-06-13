import { create } from 'zustand'

/**
 * Registry of MQTT topics the user can pick from when configuring a sensor.
 *
 * A "topic" is just a single name = one channel ("有線ケーブル 1 本", user
 * 2026-06-13). No separate friendly-label, no root/subtopic in the user's
 * model: you register a topic name, and it appears in the sensor's 送信 topic
 * dropdown. The special "default-topic" (the empty selection) always exists
 * and needs no registration — if you set nothing, everything goes there.
 *
 * Studio-side only (never sent verbatim to a device); the chosen topic name is
 * written into the sensor mapping's `topic` field. Persisted in localStorage.
 */
const STORAGE_KEY = 'hapbeat-studio-mqtt-topics'

/** Topic name rule: 1–32 chars, no slashes (mirrors the firmware mq_root). */
export function sanitizeTopic(s: string): string {
  return s.trim().replace(/\//g, '').slice(0, 32)
}

function load(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    // Accept the legacy {name, root} shape (migrate to the root string).
    return arr
      .map((t) => (typeof t === 'string' ? t : (t && typeof t.root === 'string' ? t.root : '')))
      .map((s) => sanitizeTopic(s))
      .filter((s) => s.length > 0)
  } catch {
    return []
  }
}

function persist(topics: string[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(topics))
  } catch {
    /* quota / privacy mode */
  }
}

interface MqttTopicsState {
  /** Registered topic names (default-topic is implicit, not in this list). */
  topics: string[]
  /** Add a topic name. No-op on empty / duplicate. */
  addTopic: (topic: string) => void
  removeTopic: (topic: string) => void
}

export const useMqttTopicsStore = create<MqttTopicsState>((set, get) => ({
  topics: load(),

  addTopic: (topic) => {
    const t = sanitizeTopic(topic)
    if (!t || get().topics.includes(t)) return
    const next = [...get().topics, t]
    persist(next)
    set({ topics: next })
  },

  removeTopic: (topic) =>
    set((s) => {
      const next = s.topics.filter((t) => t !== topic)
      persist(next)
      return { topics: next }
    }),
}))
