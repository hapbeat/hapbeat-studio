import { create } from 'zustand'

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
 */
interface MqttFlowState {
  /** The detached flow-chart window, or null when shown inline. */
  popout: Window | null
  /**
   * How many inline flow panels are currently mounted (i.e. an MQTT tab is
   * open). The controller polls the broker ONLY while this is > 0 or the
   * pop-out is open — otherwise an always-on 2 s broker poll keeps displacing
   * the broker's log-tail on its single TCP slot for no reason
   * (user report 2026-06-13). Ref-counted so it survives broker↔sensor tab
   * switches where one panel mounts as the other unmounts.
   */
  viewers: number
  addViewer: () => void
  removeViewer: () => void
  /** Open (or focus) the pop-out window. No-op if already open. */
  openPopout: () => void
  /** Close the pop-out (chart returns inline). */
  closePopout: () => void
  /** Called by the controller's watchdog when the user closed the window. */
  notePopoutClosed: () => void
}

export const useMqttFlowStore = create<MqttFlowState>((set, get) => ({
  popout: null,
  viewers: 0,

  addViewer: () => set((s) => ({ viewers: s.viewers + 1 })),
  removeViewer: () => set((s) => ({ viewers: Math.max(0, s.viewers - 1) })),

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
