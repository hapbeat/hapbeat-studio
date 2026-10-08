import { useCallback, useEffect, useMemo, useState } from 'react'
import { usePageVisible } from '@/hooks/usePageVisible'
import type { DockviewApi } from 'dockview-react'
import { useI18n } from '@/i18n/I18nProvider'
import { useHelperConnection } from '@/hooks/useHelperConnection'
import { useSceneSettingsFolderSync } from '@/hooks/useSceneSettingsFolderSync'
import type { SettingsSyncNotice } from '@/hooks/useEditorSettingsFolderSync'
import { useConfirm } from '@/components/common/useConfirm'
import { useDeviceStore } from '@/stores/deviceStore'
import { useSceneStore } from '@/stores/sceneStore'
import { useWaveformStore } from '@/stores/waveformStore'
import { useSceneOverrides } from '@/hooks/useSceneOverrides'
import { useSceneSettings } from '@/stores/sceneSettings'
import { resolvePlaybackTargets } from '@/utils/playbackDevices'
import { matchesAddress, RETRY_MS, tableTargets, type HapticDevice, type StreamAck, type StreamDisplaced } from '@/utils/sceneHaptics'
import { focusEvent } from '@/utils/sceneData'
import { isTypingTarget } from '@/utils/playbackShortcut'
import { SceneRuntime } from './sceneRuntime'
import { SceneContext, type SceneShared } from './sceneContext'
import { SceneDockLayout } from './SceneDockLayout'
import { SceneTopBar } from './SceneTopBar'
import '@/components/waveform/WaveformEditor.css'
import './SceneView.css'

/**
 * Scene tab: check and edit a game project's haptic / sound cue assignment
 * against its recorded gameplay (the haptic authoring viewer, inside Studio).
 * The project folder holds the recording (`Saved/HapticViewer/`, written by
 * hapbeat-haptic-authoring) and the cue table + WAVs this tab saves back.
 */
export function SceneView({ active }: { active: boolean }) {
  const { t } = useI18n()
  const [dockApi, setDockApi] = useState<DockviewApi | null>(null)
  const [layoutNotice, setLayoutNotice] = useState<string | null>(null)
  const runtime = useMemo(() => new SceneRuntime(), [])
  useEffect(() => () => runtime.dispose(), [runtime])
  // The runtime (10 ms tick, video) runs only while this tab is shown and the page is visible.
  const visible = usePageVisible()
  useEffect(() => {
    if (active && visible) runtime.start()
    else { runtime.video.pause(); runtime.stop() }
  }, [active, visible, runtime])
  useEffect(() => { void useSceneStore.getState().restore(); void useWaveformStore.getState().restoreFolder() }, [])
  useSceneOverrides()

  const root = useSceneStore(s => s.root)
  const table = useSceneStore(s => s.table)
  const dirty = useSceneStore(s => s.dirty)
  const notice = useSceneStore(s => s.notice)
  const onSettingsNotice = useCallback((value: SettingsSyncNotice) => setLayoutNotice(value.kind === 'unreadable'
    ? t('scene.settings.unreadable', { error: value.error, file: value.keptAs }) : t('scene.settings.writeFailed', { error: value.error })), [t])
  useSceneSettingsFolderSync(root, onSettingsNotice)

  // Haptic targets: the shared Kit device selection (Devices modal), narrowed to devices whose address a table route reaches.
  const { isConnected, devices, send, subscribe } = useHelperConnection()
  const kitSelectedIps = useDeviceStore(s => s.kitSelectedIps)
  const targetDevices = useMemo<HapticDevice[]>(() => {
    if (!isConnected || !table) return []
    const targets = tableTargets(table)
    return resolvePlaybackTargets(devices, kitSelectedIps).filter(d => d.address && targets.some(tg => matchesAddress(tg, d.address)))
      .map(d => ({ ipAddress: d.ipAddress, address: d.address, name: d.name }))
  }, [isConnected, table, devices, kitSelectedIps])
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
    } else if (message.type === 'error' && runtime.streaming) useSceneStore.getState().addLog(`helper error: ${p.message ?? ''}`)
  }), [subscribe, runtime, t])
  // Leaving the page (reload / close): end the device streams now, the helper otherwise ends them only on the socket close.
  useEffect(() => {
    const end = () => runtime.endStreams()
    window.addEventListener('pagehide', end); window.addEventListener('beforeunload', end)
    return () => { window.removeEventListener('pagehide', end); window.removeEventListener('beforeunload', end) }
  }, [runtime])

  const { ask, dialog } = useConfirm()
  const confirmDiscard = useCallback(() => ask({ message: t('scene.confirmDiscard'), danger: true }), [ask, t])
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (useSceneStore.getState().dirty) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [])

  // Keys (viewer's): ↑↓ item, Space play (App forwards it as studio:scene-playback), ←→ frame / Shift 1 s,
  // E before the cue, W ±0.5 s loop, R restart, F back to the full replay (where the moment / span is now), S speed, L loop, , . previous / next cue, M sound, H haptics.
  useEffect(() => {
    if (!active) return
    const playback = () => { if (useSceneStore.getState().items.length) { runtime.audio(); runtime.togglePlay() } }
    const keydown = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(el) || (el.closest && el.closest('input'))) return
      const s = useSceneStore.getState(), it = s.items[s.cur], v = runtime.video
      if (!it || !s.lib) return
      runtime.audio()
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
      const ticks = s.lib.ticks
      if (key === 'ArrowDown') s.select(s.cur + 1)
      else if (key === 'ArrowUp') s.select(s.cur - 1)
      else if (key === 'ArrowRight' || key === 'ArrowLeft') { const dir = key === 'ArrowRight' ? 1 : -1; if (e.shiftKey) runtime.seek(v.currentTime + dir); else runtime.step(dir) }
      else if (key === 'e') { const ev = focusEvent(it, runtime.events(), v.currentTime, ticks); if (ev) { runtime.seek(ev.t - 0.5); void v.play().catch(() => {}); s.selectCue(ev.name, ev.t) } }
      else if (key === 'w') runtime.setPart(!runtime.part)
      else if (key === 'r') runtime.restart()
      else if (key === 'f') runtime.returnToFull()
      else if (key === 's') runtime.cycleSpeed()
      else if (key === 'l') { useSceneSettings.getState().update({ loop: !useSceneSettings.getState().loop }); runtime.applyLoop() }
      else if (key === 'm') useSceneSettings.getState().update({ pcSound: !useSceneSettings.getState().pcSound })
      else if (key === 'h') useSceneSettings.getState().update({ sendHaptics: !useSceneSettings.getState().sendHaptics })
      else if (key === ',' || key === '.') {
        const ev = runtime.events().filter(x => !ticks.includes(x.name)), time = v.currentTime
        const next = key === '.' ? ev.find(x => x.t > time + 0.05) : [...ev].reverse().find(x => x.t < time - 0.3)
        if (next) { runtime.seek(next.t - 0.5); s.selectCue(next.name, next.t); if (runtime.part) runtime.setPart(true) }
      }
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', keydown)
    window.addEventListener('studio:scene-playback', playback)
    return () => { window.removeEventListener('keydown', keydown); window.removeEventListener('studio:scene-playback', playback) }
  }, [active, runtime])
  useEffect(() => useSceneSettings.subscribe((s, prev) => { if (s.loop !== prev.loop) runtime.applyLoop() }), [runtime])

  const shared: SceneShared = { runtime, active, helperConnected: isConnected, devices: targetDevices, confirmDiscard }
  const shownNotice = notice ? { text: t(notice.id, notice.params), error: !!notice.error } : layoutNotice ? { text: layoutNotice, error: true } : null
  return <SceneContext.Provider value={shared}>
    <div className="waveform-editor scene-view" data-dirty={dirty || undefined}
      onDragOver={e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault() }}
      onDrop={e => { if (e.dataTransfer.files.length) e.preventDefault() }}
      onPointerDown={() => { if (useSceneStore.getState().items.length) runtime.audio() }}>
      <SceneTopBar dockApi={dockApi} notice={shownNotice} />
      <SceneDockLayout onApi={setDockApi} onNotice={setLayoutNotice} />
      {dialog}
    </div>
  </SceneContext.Provider>
}
