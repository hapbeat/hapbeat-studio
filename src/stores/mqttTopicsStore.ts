import { create } from 'zustand'

/**
 * Registry of named MQTT topics ("送り先") the user can pick from when
 * configuring a sensor (item 6, user request 2026-06-13).
 *
 * Hapbeat's default routing is single-topic payload routing: a sensor
 * publishes every color to `<root>/play` and the `target` field in the
 * payload selects which Hapbeats react. That stays the default. This
 * registry adds the *option* to route by TOPIC instead — register named
 * topics here (each = a topic root), then per sensor / per color pick one
 * from a dropdown. Receivers subscribe to their own configured root, so
 * choosing a topic = choosing which receiver group hears that color.
 * Useful when you add more sensors or split deployments into groups.
 *
 * This list is a Studio-side convenience only (it never goes to a device);
 * the chosen root is written into each mapping's `topic` field. Persisted
 * in localStorage so it survives reloads and is shared across every
 * sensor's MQTT tab.
 */
export interface MqttTopic {
  /** Friendly label shown in dropdowns, e.g. "病棟A". */
  name: string
  /** Topic root published to (no slashes), e.g. "ward-a". */
  root: string
}

const STORAGE_KEY = 'hapbeat-studio-mqtt-topics'

function load(): MqttTopic[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr
      .filter((t): t is MqttTopic =>
        t && typeof t.name === 'string' && typeof t.root === 'string')
      .map((t) => ({ name: t.name, root: t.root }))
  } catch {
    return []
  }
}

function persist(topics: MqttTopic[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(topics))
  } catch {
    /* quota / privacy mode */
  }
}

/** Topic root rule: 1–32 chars, no slashes (mirrors firmware mq_root). */
export function sanitizeTopicRoot(s: string): string {
  return s.trim().replace(/\//g, '').slice(0, 32)
}

interface MqttTopicsState {
  topics: MqttTopic[]
  /** Add (or update by root) a topic. No-op on empty root. */
  upsertTopic: (t: MqttTopic) => void
  removeTopic: (root: string) => void
}

export const useMqttTopicsStore = create<MqttTopicsState>((set, get) => ({
  topics: load(),

  upsertTopic: (t) => {
    const root = sanitizeTopicRoot(t.root)
    if (!root) return
    const name = t.name.trim() || root
    const existing = get().topics
    const idx = existing.findIndex((x) => x.root === root)
    const next = idx >= 0
      ? existing.map((x, i) => (i === idx ? { name, root } : x))
      : [...existing, { name, root }]
    persist(next)
    set({ topics: next })
  },

  removeTopic: (root) =>
    set((s) => {
      const next = s.topics.filter((t) => t.root !== root)
      persist(next)
      return { topics: next }
    }),
}))
