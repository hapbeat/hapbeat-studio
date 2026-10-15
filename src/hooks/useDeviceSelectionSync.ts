import { useEffect, useMemo, useRef } from 'react'
import { useHelperConnection } from '@/hooks/useHelperConnection'
import { useDeviceStore, type DeviceSelectionScope } from '@/stores/deviceStore'
import { useSerialMaster } from '@/stores/serialMaster'
import { connectedHapbeats, type ConnectedHapbeat } from '@/utils/deviceSelection'

/** The USB port an automatic config connect is running for (one at a time). */
let autoOpeningPortId: string | null = null

/**
 * Pick the only connected Hapbeat for `scope` when the scope has nothing
 * usable selected (empty, or only devices Helper / USB no longer lists). A
 * selected device that is merely offline (e.g. rebooting after an OTA) is
 * kept — the default never steals an existing choice.
 */
function applyDefaultSelection(
  scope: DeviceSelectionScope,
  connected: ConnectedHapbeat[],
  listedIps: ReadonlySet<string>,
) {
  if (connected.length !== 1) return
  const only = connected[0]
  const st = useDeviceStore.getState()
  if (scope !== 'manage') {
    // Kit / UI targets are Wi-Fi only.
    if (!only.lanIp) return
    const current = scope === 'kit' ? st.kitSelectedIps : st.displaySelectedIps
    if (current.some((ip) => listedIps.has(ip))) return
    st.selectScopedExclusive(scope, only.lanIp)
    return
  }
  const sm = useSerialMaster.getState()
  if (sm.selectedPortIds.length > 0) return
  const hasListed = st.selectedIps.some((ip) =>
    ip.startsWith('serial:') ? !!sm.conn : listedIps.has(ip))
  if (hasListed) return
  if (only.lanIp) {
    st.selectExclusive(only.lanIp)
    return
  }
  // USB-only device: the Manage detail pane shows a USB device through its
  // config connection (the same as pressing the card's 設定 button).
  if (only.usbPortId && !sm.conn && sm.mode === 'idle' && !autoOpeningPortId) {
    autoOpeningPortId = only.usbPortId
    void sm.openConfigFor(only.usbPortId).finally(() => { autoOpeningPortId = null })
  }
}

/**
 * Cross-tab device selection (owner 2026-10-15). Mounted once in App with the
 * active tab's selection scope:
 *   - on a tab switch the new tab inherits the previous tab's selection;
 *   - when exactly one Hapbeat is connected (USB or Wi-Fi) it becomes the
 *     default for a tab with nothing selected — on opening the tab and when
 *     the set of connected devices changes (not when the user clears the
 *     selection, so an intentional "none" stays none).
 */
export function useDeviceSelectionSync(scope: DeviceSelectionScope) {
  const { devices } = useHelperConnection()
  const knownPorts = useSerialMaster((s) => s.knownPorts)
  const infoCache = useDeviceStore((s) => s.infoCache)
  const connected = useMemo(
    () => connectedHapbeats(devices, infoCache, knownPorts),
    [devices, infoCache, knownPorts],
  )
  const connectedKey = connected
    .map((d) => `${d.lanIp ?? ''}|${d.usbPortId ?? ''}`)
    .sort()
    .join(',')

  // Latest snapshots for the effect below, which runs only on a tab switch or
  // a change of the connected set (not on every device-list push).
  const latest = useRef({ devices, connected })
  latest.current = { devices, connected }

  const prevScopeRef = useRef(scope)
  useEffect(() => {
    const { devices: list, connected: now } = latest.current
    const listedIps = list.map((d) => d.ipAddress).filter(Boolean)
    const prev = prevScopeRef.current
    prevScopeRef.current = scope
    if (prev !== scope) useDeviceStore.getState().carrySelection(prev, scope, listedIps)
    applyDefaultSelection(scope, now, new Set(listedIps))
  }, [scope, connectedKey])
}
