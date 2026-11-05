import { useEffect, useMemo } from 'react'
import { useI18n } from '@/i18n/I18nProvider'
import { useHelperConnection } from '@/hooks/useHelperConnection'
import { useDeviceStore } from '@/stores/deviceStore'
import { useSceneStore } from '@/stores/sceneStore'
import { useScenePlayback } from '@/stores/scenePlayback'
import { resolvePlaybackTargets } from '@/utils/playbackDevices'
import { matchesAddress, RETRY_MS, tableTargets, type HapticDevice, type StreamAck, type StreamDisplaced, type StreamLost } from '@/utils/sceneHaptics'
import type { SceneRuntime } from './sceneRuntime'

/** Connects a SceneRuntime to hapbeat-helper (the Scene tab and the player): its target devices and its stream messages. */
export function useSceneRuntimeHelper(runtime: SceneRuntime): { isConnected: boolean; targetDevices: HapticDevice[] } {
  const { t } = useI18n()
  const table = useSceneStore(s => s.table)
  // Haptic targets: the shared Kit device selection (Devices modal), narrowed to devices whose address a table route
  // reaches; with all devices on, every selected device (every route plays on all of them, cue-table §4.5 substitution).
  const { isConnected, devices, send, subscribe } = useHelperConnection()
  const kitSelectedIps = useDeviceStore(s => s.kitSelectedIps)
  const allDevices = useScenePlayback(s => s.allDevices)
  const targetDevices = useMemo<HapticDevice[]>(() => {
    if (!isConnected || !table) return []
    const targets = tableTargets(table)
    return resolvePlaybackTargets(devices, kitSelectedIps).filter(d => allDevices || (d.address && targets.some(tg => matchesAddress(tg, d.address))))
      .map(d => ({ ipAddress: d.ipAddress, address: d.address, name: d.name }))
  }, [isConnected, table, devices, kitSelectedIps, allDevices])
  useEffect(() => {
    runtime.setHelper({ send: (type, payload) => send({ type, payload } as Parameters<typeof send>[0]), connected: isConnected, devices: targetDevices })
  }, [runtime, send, isConnected, targetDevices])
  // This tab's stream acknowledgements go to the mixer (a rejected BEGIN re-opens the stream) and, like helper errors
  // while this tab streams, to the Project panel log.
  useEffect(() => subscribe(message => {
    const p = (message.payload ?? {}) as StreamAck
    if (message.type === 'stream_ack' && runtime.ownsStream(p.stream_id)) {
      useSceneStore.getState().addLog(`stream_ack ${p.stream_id} ${p.status ?? ''}${p.targets ? ' → ' + p.targets.join(', ') : ''}${p.deferred ? ` (${t('scene.log.deferred')}: ${p.deferred.join(', ')})` : ''}${p.message ? ' ' + p.message : ''}`)
      runtime.streamAck(p)
    } else if (message.type === 'stream_displaced' && runtime.ownsStream(p.stream_id)) {
      const d = message.payload as StreamDisplaced
      useSceneStore.getState().addLog(`stream_displaced ${d.stream_id} → ${(d.targets ?? []).join(', ')}: ${t(d.same_client ? 'scene.log.displacedSameClient' : 'scene.log.displaced', { by: d.by ?? '?', seconds: RETRY_MS / 1000 })}`)
      runtime.streamDisplaced(d)
    } else if (message.type === 'stream_lost' && runtime.ownsStream(p.stream_id)) {
      const l = message.payload as StreamLost
      useSceneStore.getState().addLog(`stream_lost ${l.stream_id} → ${(l.targets ?? []).join(', ')}: ${t('scene.log.lost', { reason: l.reason ?? '?', seconds: RETRY_MS / 1000 })}`)
      runtime.streamLost(l)
    } else if (message.type === 'error' && runtime.streaming) useSceneStore.getState().addLog(`helper error: ${p.message ?? ''}`)
  }), [subscribe, runtime, t])
  // Leaving the page (reload / close): end the device streams now, the helper otherwise ends them only on the socket close.
  useEffect(() => {
    const end = () => runtime.endStreams()
    window.addEventListener('pagehide', end); window.addEventListener('beforeunload', end)
    return () => { window.removeEventListener('pagehide', end); window.removeEventListener('beforeunload', end) }
  }, [runtime])
  return { isConnected, targetDevices }
}
