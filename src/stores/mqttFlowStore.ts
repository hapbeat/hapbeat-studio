import { create } from 'zustand'
import type { MqttClientEntry } from '@/types/manager'

/**
 * Page-level state for the MQTT 通信フロー chart.
 *
 * The flow chart is a SINGLE instance shared by the broker's MQTT tab and
 * every sensor/receiver's MQTT tab (user feedback 2026-06-13: 「通信フローは
 * 各デバイスごとではなく、ページ全体で 1 つ」). The pop-out window therefore
 * has to survive switching the selected device (broker ↔ sensor) and even
 * switching sub-tabs — so its handle lives here, in a store, not in any one
 * panel component that unmounts on navigation. `MqttFlowController`
 * (mounted once at the Devices page root) renders the live chart into this
 * window via createPortal and clears it when the user closes it.
 *
 * It ALSO owns the broker telemetry (mqtt_clients / pub stats). Previously the
 * chart read this out of `deviceStore.infoCache[brokerIp]`, but DeviceDetail
 * wipes that entry via `clearCachesFor` whenever the selected device changes
 * — so after switching from the broker to a sensor's MQTT tab the broker's
 * client list went empty and every connected sender rendered as a dashed
 * "未接続" ghost (root cause of the persistent "sender doesn't show up", found
 * 2026-06-13 by the sender-missing-trace workflow). Keeping the telemetry here,
 * written by the controller straight from the broker's get_info_result,
 * decouples the chart from the selection lifecycle entirely.
 */

/** Live broker telemetry for the flow chart, owned by MqttFlowController. */
export interface BrokerTelemetry {
  /** IP the telemetry belongs to (guards against showing a stale broker). */
  ip: string
  mqtt_running?: boolean
  mqtt_port?: number
  mqtt_clients?: MqttClientEntry[]
  mqtt_pub_count?: number
  mqtt_last_topic?: string
  mqtt_last_payload?: string
  /** Name/sid of the client that published the last play/stop. */
  mqtt_last_from?: string
  /** Wall-clock time (epoch ms) Studio first observed the latest pub_count
   *  increment — the broker only reports device-millis, so this is the
   *  closest "時刻" the chart can show for the last event. */
  lastEventAt?: number
}

interface MqttFlowState {
  /** The detached flow-chart window, or null when shown inline. */
  popout: Window | null
  /**
   * Stable ids of the inline flow panels currently mounted (an MQTT tab is
   * open). The controller polls the broker ONLY while this is non-empty or
   * the pop-out is open — otherwise an always-on 2 s broker poll needlessly
   * displaces the broker's log-tail on its single TCP slot. A SET of ids
   * (not a counter) so React 18 StrictMode's dev double-mount / fast tab
   * remounts stay idempotent and can't desync the gate to a false 0.
   */
  viewerIds: string[]
  registerViewer: (id: string) => void
  unregisterViewer: (id: string) => void
  /** Latest broker telemetry (mqtt_clients etc.), written by the controller. */
  brokerTelemetry: BrokerTelemetry | null
  /** Merge a fresh broker get_info into the telemetry (drops undefined keys
   *  so a failed/partial poll never blanks a known-good client list; replaces
   *  wholesale when the broker IP changes). */
  setBrokerTelemetry: (t: BrokerTelemetry) => void
  /** Open (or focus) the pop-out window. No-op if already open. */
  openPopout: () => void
  /** Close the pop-out (chart returns inline). */
  closePopout: () => void
  /** Called by the controller's watchdog when the user closed the window. */
  notePopoutClosed: () => void
}

export const useMqttFlowStore = create<MqttFlowState>((set, get) => ({
  popout: null,
  viewerIds: [],
  brokerTelemetry: null,

  registerViewer: (id) =>
    set((s) => (s.viewerIds.includes(id) ? s : { viewerIds: [...s.viewerIds, id] })),
  unregisterViewer: (id) =>
    set((s) => ({ viewerIds: s.viewerIds.filter((x) => x !== id) })),

  setBrokerTelemetry: (t) =>
    set((s) => {
      const prev = s.brokerTelemetry
      if (!prev || prev.ip !== t.ip) return { brokerTelemetry: t }
      // Same broker — merge only the defined keys so a poll that came back
      // without (e.g.) mqtt_clients keeps the last good list.
      const defined = Object.fromEntries(
        Object.entries(t).filter(([, v]) => v !== undefined),
      )
      const merged: BrokerTelemetry = { ...prev, ...defined }
      // Stamp the time we observed a new publish (pub_count advanced).
      if (t.mqtt_pub_count != null && (prev.mqtt_pub_count ?? 0) < t.mqtt_pub_count) {
        merged.lastEventAt = Date.now()
      }
      return { brokerTelemetry: merged }
    }),

  openPopout: () => {
    const existing = get().popout
    if (existing && !existing.closed) {
      existing.focus()
      return
    }
    const w = window.open('', 'hapbeat-mqtt-flow', 'width=860,height=620')
    if (!w) return // popup blocked
    w.document.title = 'Hapbeat — MQTT 通信フロー'
    w.document.body.style.cssText =
      'margin:0;padding:16px;background:#16161a;color:#ddd;'
      + 'font-family:system-ui,-apple-system,sans-serif'
    // Closing the window via its own chrome can't call back into React, so
    // the controller polls `popout.closed`; this handler covers the case
    // where the parent tab is closed/navigated.
    w.addEventListener('beforeunload', () => set({ popout: null }))
    set({ popout: w })
  },

  closePopout: () => {
    const w = get().popout
    if (w && !w.closed) w.close()
    set({ popout: null })
  },

  notePopoutClosed: () => set({ popout: null }),
}))
