import { useCallback, useEffect, useMemo, useState } from 'react'
import { usePageVisible } from '@/hooks/usePageVisible'
import type { DockviewApi } from 'dockview-react'
import { useI18n } from '@/i18n/I18nProvider'
import { useSceneSettingsFolderSync } from '@/hooks/useSceneSettingsFolderSync'
import type { SettingsSyncNotice } from '@/hooks/useEditorSettingsFolderSync'
import { useConfirm } from '@/components/common/useConfirm'
import { useSceneStore } from '@/stores/sceneStore'
import { useWaveformStore } from '@/stores/waveformStore'
import { useSceneOverrides } from '@/hooks/useSceneOverrides'
import { useSceneSettings } from '@/stores/sceneSettings'
import { focusEvent, isTick } from '@/utils/sceneData'
import { isTypingTarget } from '@/utils/playbackShortcut'
import { openSceneSelectionInEditor } from '@/stores/eventStore'
import { SceneRuntime } from './sceneRuntime'
import { useSceneRuntimeHelper } from './useSceneRuntimeHelper'
import { useSceneStrength } from '@/stores/sceneStrength'
import { strengthStep } from '@/utils/sceneStrength'
import { firingSelectionAt } from '@/utils/sceneTimelineEdit'
import { SceneContext, type SceneShared } from './sceneContext'
import { SceneDockLayout } from './SceneDockLayout'
import { SceneTopBar } from './SceneTopBar'
import { useSceneKitCheck } from './SceneKitStatus'
import '@/components/waveform/WaveformEditor.css'
import './SceneView.css'

/** ↑ / ↓ strength steps this close (ms, auto-repeat included) are one change (one undo step), like the timeline's Alt + wheel. */
const KEY_BURST_MS = 400

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
  const dirty = useSceneStore(s => s.dirty)
  const notice = useSceneStore(s => s.notice)
  const onSettingsNotice = useCallback((value: SettingsSyncNotice) => setLayoutNotice(value.kind === 'unreadable'
    ? t('scene.settings.unreadable', { error: value.error, file: value.keptAs }) : t('scene.settings.writeFailed', { error: value.error })), [t])
  useSceneSettingsFolderSync(root, onSettingsNotice)

  const { isConnected, targetDevices } = useSceneRuntimeHelper(runtime)
  const kit = useSceneKitCheck(targetDevices, isConnected)

  const { ask, dialog } = useConfirm()
  const confirmDiscard = useCallback(() => ask({ message: t('scene.confirmDiscard'), danger: true }), [ask, t])
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (useSceneStore.getState().dirty) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [])

  // Keys (viewer's): ↑↓ item, Space play (App forwards it as studio:scene-playback), ←→ frame / Shift 1 s,
  // E before the cue, W ±0.5 s loop, R restart, F back to the full replay (where the moment / span is now), S speed, L loop, , . previous / next cue, M sound, H haptics,
  // O the selected event in the editor, 1–9 the project's chapters 1–9 (only with chapters: digits stay free otherwise).
  // Strength edits (the strength panel / timeline): Ctrl+Z undo, Ctrl+Shift+Z / Ctrl+Y redo, Esc clears the firing selection,
  // ↑↓ on the focused timeline with a firing selection: ±1 dB (Shift ±3 dB), shown live and one undo step per burst
  // (held or pressed within KEY_BURST_MS: applied on the key's release or after that pause; not while the strength is locked).
  useEffect(() => {
    if (!active) return
    const playback = () => { if (useSceneStore.getState().items.length) { runtime.audio(); runtime.togglePlay() } }
    const burst = { ratio: 1, timer: undefined as ReturnType<typeof setTimeout> | undefined }
    const commit = () => {
      clearTimeout(burst.timer); burst.timer = undefined
      const ratio = burst.ratio, st = useSceneStrength.getState()
      burst.ratio = 1
      if (ratio === 1) return
      st.setDragRatio(null)
      st.scaleSelected(ratio)
    }
    // A key that moves the picked cue (↑↓, E, , .) also moves the firing selection to it, as a moments row click does: the
    // selected row, the chosen bar and the 「発生」 panel always name one firing.
    const syncFiring = () => {
      const s = useSceneStore.getState(), sel = s.sel
      useSceneStrength.getState().select(sel && sel.t != null && s.data
        ? firingSelectionAt(s.table, s.lib?.ticks ?? [], s.data.full.events, s.edited?.full.events ?? null, sel.name, sel.t) : [], 'replace')
    }
    const keyup = (e: KeyboardEvent) => { if (burst.timer !== undefined && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) commit() }
    const keydown = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      // Not while a dialog is open (its own Esc / buttons; a strength edit under it would go unseen).
      if (!e.altKey && !e.defaultPrevented && !isTypingTarget(el) && !document.querySelector('[aria-modal="true"]') && !(el.closest && el.closest('[role="dialog"]'))) {
        const st = useSceneStrength.getState(), k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey
        let done = false
        // A strength burst still showing is applied first (Undo then takes it back as one step).
        if (mod && (k === 'z' || k === 'y') && burst.timer !== undefined) commit()
        if (mod && k === 'z' && !e.shiftKey) { if (st.undo.length) { st.undoLast(); done = true } }
        else if (mod && ((k === 'z' && e.shiftKey) || k === 'y')) { if (st.redo.length) { st.redoLast(); done = true } }
        else if (!mod && e.key === 'Escape' && st.selected.size) { st.clear(); done = true }
        // ↑↓ on the focused timeline with firings selected: their strength ±1 dB (Shift ±3 dB) instead of the moment.
        else if (!mod && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && st.selected.size && el.classList?.contains('scene-timeline-canvas')) {
          if (!useSceneSettings.getState().lockGain) {
            burst.ratio *= strengthStep(e.shiftKey) ** (e.key === 'ArrowUp' ? 1 : -1)
            st.setDragRatio(burst.ratio)
            clearTimeout(burst.timer); burst.timer = setTimeout(commit, KEY_BURST_MS)
          }
          done = true
        }
        if (done) { e.preventDefault(); return }
      }
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
      else if (key === 'o') { if (!openSceneSelectionInEditor(s.table, s.sel)) return }
      else if (key === ',' || key === '.') {
        const ev = runtime.events().filter(x => !isTick(ticks, x.name)), time = v.currentTime
        const next = key === '.' ? ev.find(x => x.t > time + 0.05) : [...ev].reverse().find(x => x.t < time - 0.3)
        if (next) { runtime.seek(next.t - 0.5); s.selectCue(next.name, next.t); if (runtime.part) runtime.setPart(true) }
      }
      else if (/^[1-9]$/.test(key) && Number(key) <= (s.data?.chapters.length ?? 0)) runtime.playChapter(Number(key) - 1)
      else return
      e.preventDefault()
      if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'e' || key === ',' || key === '.') syncFiring()
    }
    window.addEventListener('keydown', keydown)
    window.addEventListener('keyup', keyup)
    window.addEventListener('studio:scene-playback', playback)
    return () => {
      window.removeEventListener('keydown', keydown); window.removeEventListener('keyup', keyup); window.removeEventListener('studio:scene-playback', playback)
      if (burst.timer !== undefined) commit()
    }
  }, [active, runtime])
  useEffect(() => useSceneSettings.subscribe((s, prev) => { if (s.loop !== prev.loop) runtime.applyLoop() }), [runtime])

  const shared: SceneShared = { runtime, active, helperConnected: isConnected, devices: targetDevices, kit, confirmDiscard }
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
