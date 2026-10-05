import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DockviewApi } from 'dockview-react'
import { effectsPending, useWaveformStore } from '@/stores/waveformStore'
import { useDeviceStore } from '@/stores/deviceStore'
import { useI18n } from '@/i18n/I18nProvider'
import { useHelperConnection } from '@/hooks/useHelperConnection'
import { EditorPlayback } from '@/utils/editorPlayback'
import { cropBuffer } from '@/utils/audioDsp'
import { encodeWavBlob } from '@/utils/wavIO'
import type { SampleRate } from '@/types/waveform'
import './WaveformEditor.css'
import { useEditorSettings } from '@/stores/editorSettings'
import { EditorBufferPlayer } from '@/utils/editorBufferPlayer'
import { useEditorPreview } from '@/hooks/useEditorPreview'
import type { Recipe } from '@/utils/recipe'
import type { MessageId } from '@/i18n/I18nProvider'
import { RecipeDialog } from './RecipeDialog'
import { useAgentTrialStore } from '@/stores/agentTrialStore'
import { useAgentEndpoint } from '@/hooks/useAgentEndpoint'
import { isDemoMode } from '@/demo/isDemoMode'
import { lookupMaterials, provenanceLine } from '@/utils/materials'
import type { WaveformClip } from '@/types/waveform'
import { onlinePlaybackDevices, resolvePlaybackTargets } from '@/utils/playbackDevices'
import { handlePlaybackShortcut, isTypingTarget } from '@/utils/playbackShortcut'
import { useEditorSettingsFolderSync, type SettingsSyncNotice } from '@/hooks/useEditorSettingsFolderSync'
import { EditorContext, type EditorShared } from './editorContext'
import { EditorDockLayout, focusPanel, POPOUT_URL } from './EditorDockLayout'
import { EditorTopBar } from './EditorTopBar'
import { playStart, useStartMarker } from '@/utils/editorStartMarker'
import { scenePause, scenePreRoll, useSceneVideoTarget, type SceneVideoTarget } from '@/utils/editorSceneSync'
import { useSceneStore } from '@/stores/sceneStore'
import { useEventStore } from '@/stores/eventStore'
import { showDockPanel } from '@/utils/dockPanels'
import { trialTarget } from '@/utils/agentProtocol'
import { waveformOnPc } from '@/utils/agentTrialUi'
import { DecideDialog } from './DecideDialog'
import { openEventDefault, repeatBuffer, useDecidedSoundSync } from './eventAudio'
import { useAuditionPlan } from './EditorScenePanel'

export function WaveformEditor({ active }: { active: boolean }) {
  const { t } = useI18n()
  const s = useWaveformStore()
  const [original, setOriginal] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [dockApi, setDockApi] = useState<DockviewApi | null>(null)
  const [popoutWindows, setPopoutWindows] = useState<Window[]>([])
  /** Clip order as shown in the Clips panel; ↑↓ follows it. */
  const visibleClipIds = useRef<string[]>([])
  const setVisibleClipIds = useCallback((ids: string[]) => { visibleClipIds.current = ids }, [])
  /** AI trial candidate shown / played instead of the clip (agentTrialStore). Editing is disabled meanwhile. */
  const audition = useAgentTrialStore(state => state.audition)
  /** An event's sound / haptic opened from the Events panel: shown and played like an audition (read only). */
  const eventPreview = useEventStore(state => state.preview)
  const auditionKey = audition ? `${audition.trialId}/${audition.candidateId}` : eventPreview ? `event:${eventPreview.id}` : null
  useEffect(() => { if (audition) useEventStore.getState().clearPreview() }, [audition])
  const focusRequest = useAgentTrialStore(state => state.focusRequest)
  useEffect(() => { if (focusRequest && dockApi) focusPanel(dockApi, 'agent', t) }, [focusRequest, dockApi])
  // Scene tab "open in editor": the Events panel with the event selected, and its moment in the Scene video panel.
  const eventFocusRequest = useEventStore(state => state.focusRequest)
  useEffect(() => {
    const key = useEventStore.getState().selected
    if (!eventFocusRequest || !dockApi) return
    focusPanel(dockApi, 'events', t)
    if (key) { useSceneVideoTarget.getState().setTarget({ kind: 'event', key }); openEventDefault(key) }
  }, [eventFocusRequest, dockApi])
  /** A sound AI trial (target "sound") is auditioned on the PC only: no haptic targets while one is shown. */
  const auditionIsSound = useAgentTrialStore(state => {
    const shown = state.audition
    const trial = shown ? state.trials.find(r => r.trial.id === shown.trialId)?.trial : undefined
    return !!trial && trialTarget(trial) === 'sound'
  })
  useEffect(() => {
    if (!active || !s.folder) return
    useAgentTrialStore.getState().startPolling()
    return () => useAgentTrialStore.getState().stopPolling()
  }, [active, s.folder])
  useAgentEndpoint(active && !!s.folder, s.folder?.root.name ?? null)
  /** "Edited" always reflects the effect chain: while it has unapplied changes the editor shows a live (debounced, cancellable) render. */
  const pendingChain = effectsPending(s.clip, s.effects)
  const previewActive = pendingChain && !original && !audition && !eventPreview
  const preview = useEditorPreview(s.clip, s.effects, previewActive)
  useEffect(() => { void useWaveformStore.getState().restoreFolder() }, [])
  const onSettingsNotice = useCallback((value: SettingsSyncNotice) => setNotice(value.kind === 'unreadable'
    ? t('editor.settings.unreadable', { error: value.error, file: value.keptAs }) : t('editor.settings.writeFailed', { error: value.error })), [t])
  useEditorSettingsFolderSync(s.folder, onSettingsNotice)
  const { isConnected, devices, send, subscribe } = useHelperConnection()
  // Refresh provenance from the helper ledger on connect and when sources change;
  // the result is stored in project.json so it also shows without the helper.
  const sourceShaKey = useMemo(() => [...new Set(s.documents.map(doc => doc.clip.sourceSha256).filter(Boolean))].sort().join(','), [s.documents])
  useEffect(() => {
    if (!isConnected || !sourceShaKey || s.isProcessing || isDemoMode()) return
    let cancelled = false
    void lookupMaterials({ send, subscribe }, sourceShaKey.split(','))
      .then(found => { if (!cancelled) useWaveformStore.getState().setProvenance(found) })
      .catch(error => console.warn('[editor] material_lookup failed', error))
    return () => { cancelled = true }
  }, [isConnected, sourceShaKey, s.isProcessing, send, subscribe])
  const provenanceText = useCallback((clip: WaveformClip) => {
    const line = provenanceLine(clip)
    if (line.key === 'known') return t('editor.provenance.known', { site: line.site, license: line.license }) + (line.needsReview ? t('editor.provenance.review') : '')
    return line.key === 'none' ? '' : t(`editor.provenance.${line.key}`)
  }, [t])
  // Haptic targets: the shared Kit device selection (header device pill / Devices modal), same rule as Kit playback.
  const kitSelectedIps = useDeviceStore(state => state.kitSelectedIps)
  const muted = useEditorSettings(state => state.muted)
  const sendHaptics = useEditorSettings(state => state.sendHaptics)
  const playbackDevices = useMemo(() => isConnected ? onlinePlaybackDevices(devices) : [], [isConnected, devices])
  // "Send haptics" off → no targets, so EditorPlayback never opens a stream (PC-only audition).
  const targets = useMemo(() => isConnected && sendHaptics && !auditionIsSound && eventPreview?.target !== 'sound' ? resolvePlaybackTargets(devices, kitSelectedIps).map(device => device.ipAddress) : [], [isConnected, sendHaptics, auditionIsSound, eventPreview?.target, devices, kitSelectedIps])
  const targetKey = targets.join(',')
  const shownBuffer = audition ? audition.buffer : eventPreview ? eventPreview.buffer : original ? s.clip?.originalBuffer : previewActive ? (preview.buffer ?? s.clip?.buffer) : s.clip?.buffer
  // Auditions (AI candidate / event material) play at the scene's timing: on every target firing, without jitter
  // (DEC-085); one buffer, so Stop ends them all and seeks follow the video.
  const plan = useAuditionPlan()
  const audioBuffer = useMemo(() => shownBuffer && plan && (audition || eventPreview) && !(plan.targets.length === 1 && plan.targets[0] === 0)
    ? repeatBuffer(shownBuffer, plan.targets.map(atSec => ({ atSec, gain: 1, rate: 1 }))) : shownBuffer, [shownBuffer, plan, audition, eventPreview])
  const player = useMemo(() => new EditorBufferPlayer(null, undefined, s.setError), [s.clip?.id, original, auditionKey])
  useEffect(() => {player.activate(); return () => player.dispose()}, [player])
  useDecidedSoundSync(player)
  player.setBuffer(audioBuffer ?? null)
  useEffect(() => {
    const selection = useWaveformStore.getState().selectedRegion
    if (selection && audioBuffer) useWaveformStore.getState().setSelectedRegion(selection, original, audioBuffer.duration)
  }, [audioBuffer, original])
  const [pending, setPending] = useState(false)
  const playback = useMemo(() => {
    let cached: {buffer: AudioBuffer; start: number; end: number; blob: Promise<Blob>} | null = null
    const keys = new WeakMap<Blob, string>()
    return new EditorPlayback(player, (start, end) => {
      const buffer = player.getBuffer()
      if (!buffer) return Promise.reject(new Error('Select a clip first'))
      if (!cached || cached.buffer !== buffer || cached.start !== start || cached.end !== end) cached = {buffer, start, end, blob: encodeWavBlob(start === 0 && end === buffer.duration ? buffer : cropBuffer(buffer, start, end), buffer.sampleRate as SampleRate)}
      return cached.blob
    }, targetKey ? targetKey.split(',') : [], send, async (blob, route, options) => {
      let key = keys.get(blob); if (!key) {key = crypto.randomUUID(); keys.set(blob, key)}
      await (await import('@/utils/audioStreamer')).streamClip(blob, route, {...options, cacheKey: key})
    }, setPending, s.setError)
  }, [player, targetKey, send, s.setError])
  // The Scene video panel's lead-in (audio / haptics start on the cue mark).
  playback.preRoll = scenePreRoll
  // "×5" plays once from the start as soon as it is shown.
  const autoplayed = useRef<AudioBuffer | null>(null)
  useEffect(() => {
    if (!eventPreview?.autoplay || autoplayed.current === eventPreview.buffer) return
    autoplayed.current = eventPreview.buffer
    if (active && !useWaveformStore.getState().isProcessing) { useStartMarker.getState().set(null); void playback.play(0, player.getDuration(), true).catch(s.setError) }
  }, [eventPreview, playback, player, active, s.setError])
  useEffect(() => () => playback?.stop(), [playback])
  useEffect(() => { if (!active) playback?.stop() }, [active, playback])
  useEffect(() => {
    if (!playback) return
    const unsubs = [player.on('pause', () => playback.paused()), player.on('finish', () => playback.paused()), player.on('timeupdate', time => playback.timeUpdated(time)), player.on('seeking', time => playback.seek(time))]
    return () => unsubs.forEach(unsub => unsub())
  }, [player, playback])
  /** Play / stop (no pause): stopping rewinds to the selection start (or 0). */
  const togglePlay = useCallback(() => {
    if (useWaveformStore.getState().isProcessing) return
    const start = playStart(useWaveformStore.getState().selectedRegion, useStartMarker.getState().start)
    if (playback.pending || player.isPlaying()) { playback.stop(); player.setTime(start); return }
    // A clicked start (no range) plays from there again, also after the previous play ran to the end.
    if (!useWaveformStore.getState().selectedRegion && useStartMarker.getState().start !== null) player.setTime(start)
    void playback.toggle().catch(s.setError)
  }, [playback, player, s.setError])
  const stopPlayback = useCallback(() => {
    playback.stop()
    player.setTime(playStart(useWaveformStore.getState().selectedRegion, useStartMarker.getState().start))
  }, [playback, player])
  const isPlaybackActive = useCallback(() => playback.pending || player.isPlaying(), [playback, player])
  const playAt = useCallback((time: number) => {
    if (useWaveformStore.getState().isProcessing) return
    useWaveformStore.getState().setSelectedRegion(null)
    useStartMarker.getState().set(time)
    const settings = useEditorSettings.getState()
    playback.configure(null, settings.loop, settings.loopDelay)
    player.setTime(time)
    void playback.play(time).catch(s.setError)
  }, [playback, player, s.setError])
  const playFromStart = useCallback((once = false) => {
    if (useWaveformStore.getState().isProcessing) return
    playback.stop()
    useStartMarker.getState().set(null)
    if (once) { player.setTime(0); void playback.play(0, player.getDuration(), true).catch(s.setError); return }
    player.setTime(useWaveformStore.getState().selectedRegion?.start ?? 0)
    void playback.toggle().catch(s.setError)
  }, [playback, player, s.setError])
  const toggleCandidate = useCallback((trialId: string, candidateId: string) => {
    const shown = useAgentTrialStore.getState().audition
    if (shown && shown.trialId === trialId && shown.candidateId === candidateId && isPlaybackActive()) { stopPlayback(); return }
    // Audition (if needed) and play through the usual path (WaveformEditor's playRequested effect).
    // No focus request: the AI trials panel is where the user is (and must keep its scroll position).
    void useAgentTrialStore.getState().requestAudition(trialId, candidateId, true, false).catch(s.setError)
  }, [isPlaybackActive, stopPlayback, s.setError])
  useEffect(() => {
    const toggle = () => {
      if (!active) return
      // Space with focus on an AI candidate card acts like the card's ▶ (typing in its rating fields never reaches here).
      const docs = [document, ...popoutWindows.map(w => w.document)]
      const card = docs.map(d => (d.activeElement as HTMLElement | null)?.closest?.<HTMLElement>('[data-candidate-id]')).find(Boolean)
      if (card?.dataset.trialId && card.dataset.candidateId) { toggleCandidate(card.dataset.trialId, card.dataset.candidateId); return }
      // Focus in the synced Scene video panel, or the video paused: pause / resume there (same as its ⏸/▶ button).
      const scene = scenePause()
      if (scene && (scene.paused() || docs.some(d => (d.activeElement as HTMLElement | null)?.closest?.('.editor-scene-panel')))) { scene.toggle(); return }
      togglePlay()
    }
    window.addEventListener('studio:editor-playback', toggle)
    return () => window.removeEventListener('studio:editor-playback', toggle)
  }, [active, togglePlay, toggleCandidate, popoutWindows])
  const [recipeDialog, setRecipeDialog] = useState<{ container: HTMLElement; initial?: Recipe } | null>(null)
  const openRecipe = useCallback((doc: Document, initial?: Recipe) => setRecipeDialog({ container: doc.body, initial }), [])
  const createRecipeClip = (recipe: Recipe, presetId: string | null) => {
    void s.addRecipeClip(recipe, presetId ? t(`editor.recipe.preset.${presetId}` as MessageId) : t('editor.recipe.clipName'), `recipe:${presetId ?? 'custom'}`, useAgentTrialStore.getState().folder)
    setRecipeDialog(null)
  }
  useEffect(() => { player.setMuted(muted) }, [player, muted])
  // A haptic audition goes to the devices only; the PC plays the event's representative sound with it (not the haptic waveform).
  const hapticOnPc = useEditorSettings(state => state.hapticOnPc)
  const hapticAudition = (!!audition && !auditionIsSound) || (!audition && eventPreview?.target === 'haptic')
  useEffect(() => { player.setOutput(waveformOnPc({ hapticAudition, hapticOnPc })) }, [player, hapticAudition, hapticOnPc])
  useEffect(() => { setOriginal(false); useAgentTrialStore.getState().clearAudition(); useEventStore.getState().clearPreview() }, [s.clip?.id])
  // MCP `audition` with play: true — the usual playback path (selected haptic targets, PC audio per the mute toggle).
  const playRequested = useAgentTrialStore(state => state.playRequested)
  useEffect(() => {
    if (!playRequested || !audition) return
    useAgentTrialStore.getState().clearPlayRequest()
    if (active && !useWaveformStore.getState().isProcessing) void playback.play().catch(s.setError)
  }, [playRequested, audition, playback, active, s.setError])
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      const state = useWaveformStore.getState()
      if (state.isProcessing || ['pending', 'saving', 'error'].includes(state.saveStatus)) { event.preventDefault(); event.returnValue = '' }
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [])
  useEffect(() => {
    if (!active) return
    const keydown = (event: KeyboardEvent) => {
      const element = event.target as HTMLElement
      // Typing (shared rule) and any other form control keep their keys; buttons too, except clip rows.
      if (!element.closest || isTypingTarget(element) || element.closest('input') || (element.closest('button') && !element.closest('.editor-clip'))) return
      const state = useWaveformStore.getState()
      if (state.isProcessing) return

      if (original || audition || eventPreview) return
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? state.redo() : state.undo() }
      if (event.key === 'Delete' && state.selectedRegion) { event.preventDefault(); state.deleteRegion() }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const ids = visibleClipIds.current
        const index = ids.indexOf(state.clip?.id ?? '')
        const next = ids[index + (event.key === 'ArrowDown' ? 1 : -1)]
        if (next) { event.preventDefault(); state.selectClip(next) }
      }
    }
    // Popped-out panels live in their own windows: forward Space (playback) and the editor keys from there too.
    const space = (event: KeyboardEvent) => handlePlaybackShortcut(event, 'editor', e => window.dispatchEvent(e))
    window.addEventListener('keydown', keydown)
    for (const popup of popoutWindows) { popup.addEventListener('keydown', space, true); popup.addEventListener('keydown', keydown) }
    return () => {
      window.removeEventListener('keydown', keydown)
      for (const popup of popoutWindows) { popup.removeEventListener('keydown', space, true); popup.removeEventListener('keydown', keydown) }
    }
  }, [active, original, audition, eventPreview, popoutWindows])
  /** Project names whose folder link the user refused this session (the trials filter does not ask again). */
  const refusedScenes = useRef(new Set<string>())
  const linkSceneProject = useCallback(async (name: string | null, options?: { quietIfRefused?: boolean }) => {
    if (options?.quietIfRefused && name && refusedScenes.current.has(name)) return false
    const result = await useSceneStore.getState().linkProject(name, true)
    if (result.ok) { if (name) refusedScenes.current.delete(name); return true }
    if (name && (result.reason === 'cancelled' || result.reason === 'failed')) refusedScenes.current.add(name)
    if (result.notice) setNotice(t(result.notice.id, result.notice.params))
    return false
  }, [t])
  /**
   * "▶ Video" (AI trial / Properties): picks what the Scene video panel shows, links its Scene
   * project if it is not the open one (registered folder: permission if needed; else the folder
   * picker once — both need this click), then shows the panel in its own window. A blocked pop-up
   * leaves it docked in the editor with a notice.
   */
  const openSceneVideo = useCallback((target: SceneVideoTarget, project: string | null) => {
    useSceneVideoTarget.getState().setTarget(target)
    if (!dockApi) return
    const show = () => {
      focusPanel(dockApi, 'scene', t)
      const panel = dockApi.getPanel('scene')
      if (!panel) return
      if (panel.group.api.location.type === 'popout') { dockApi.getPopouts().find(p => p.group === panel.group)?.window.focus(); return }
      void dockApi.addPopoutGroup(panel, { popoutUrl: POPOUT_URL }).then(opened => {
        if (!opened) { const panel = dockApi.getPanel('scene'); if (panel) showDockPanel(panel); setNotice(t('editor.scene.popupBlocked')) }
      })
    }
    const scene = useSceneStore.getState()
    if (scene.root && scene.lib && (!project || scene.lib.project_name === project)) { show(); return }
    void linkSceneProject(project).then(show, s.setError)
  }, [dockApi, t, s.setError, linkSceneProject])
  const focusEditorPanel = useCallback((id: Parameters<EditorShared['focusEditorPanel']>[0]) => { if (dockApi) focusPanel(dockApi, id, t) }, [dockApi, t])
  const shared: EditorShared = {
    active, original, setOriginal, pendingChain, preview, auditionKey, audioBuffer, player, playback, pending, togglePlay, playAt, stopPlayback, isPlaybackActive, playFromStart, toggleCandidate,
    openRecipe, provenanceText, isConnected, playbackDevices, targets, setVisibleClipIds, openSceneVideo, linkSceneProject, focusEditorPanel,
  }
  return <EditorContext.Provider value={shared}>
    <div className="waveform-editor" onDragOver={e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' } }}
      onDrop={e => { if (!e.dataTransfer.files.length) return; e.preventDefault(); if (s.folder) void s.loadFiles(Array.from(e.dataTransfer.files)); else s.setError(t('editor.chooseFirst')) }}>
      <EditorTopBar dockApi={dockApi} notice={s.error ?? notice} onNotice={setNotice} />
      <EditorDockLayout onApi={setDockApi} onPopoutWindows={setPopoutWindows} onNotice={setNotice} />
      <DecideDialog />
      {recipeDialog && <RecipeDialog container={recipeDialog.container} initial={recipeDialog.initial} onCreate={createRecipeClip} onClose={() => setRecipeDialog(null)} />}
      {s.isProcessing && <div className="processing-overlay"><div className="processing-spinner" /><span>{t('wave.processing')}</span></div>}
    </div>
  </EditorContext.Provider>
}
