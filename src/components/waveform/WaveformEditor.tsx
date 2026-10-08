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
import { onlinePlaybackDevices, resolvePlaybackTargets, routePlaybackTargets } from '@/utils/playbackDevices'
import { cueRoutePositions, materialRoutePositions } from '@/utils/cueEvents'
import { materialIntensity } from '@/utils/sceneCueTable'
import { handlePlaybackShortcut, isTypingTarget } from '@/utils/playbackShortcut'
import { useEditorSettingsFolderSync, type SettingsSyncNotice } from '@/hooks/useEditorSettingsFolderSync'
import { EditorContext, type EditorShared } from './editorContext'
import { EditorDockLayout, focusPanel, POPOUT_URL } from './EditorDockLayout'
import { EditorTopBar } from './EditorTopBar'
import { playStart, useStartMarker } from '@/utils/editorStartMarker'
import { scenePause, scenePreRoll, useSceneVideoTarget, type SceneVideoTarget } from '@/utils/editorSceneSync'
import { useSceneStore } from '@/stores/sceneStore'
import { lastSceneProject } from '@/utils/sceneRegistry'
import { levelKey, useEventStore } from '@/stores/eventStore'
import { showDockPanel } from '@/utils/dockPanels'
import { trialTarget } from '@/utils/agentProtocol'
import { waveformOnPc } from '@/utils/agentTrialUi'
import { DecideDialog } from './DecideDialog'
import { useAdjustPersistence, useMaterialWriteBack } from './eventEditing'
import { openEventDefault, repeatBuffer, useDecidedSoundSync, useSceneSounds } from './eventAudio'
import { groupFirings, groupHapticsEnd, inSpans, mixGroupHaptics, shownSpans, type HapticPart } from '@/utils/groupPlayback'
import { RATE as HAPTIC_RATE } from '@/utils/sceneHaptics'
import { useAuditionPlan } from './EditorScenePanel'
import type { ShownLayout } from '@/utils/shownLayout'
import { sceneStopSec } from '@/utils/sceneStop'
import { contextHapticParts, renderContextLoops } from '@/utils/trialContext'
import { useSceneSettings } from '@/stores/sceneSettings'
import { LANE_RATE, mixLane, soundLaneParts, type SoundLane } from '@/utils/soundLane'

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
  // An AI candidate has no "original" (the toggle is off for it): it always shows as rendered.
  useEffect(() => { if (audition) { useEventStore.getState().clearPreview(); setOriginal(false) } }, [audition])
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
    // A trial's scene.context is checked against the cue table of the Scene project open in the Events panel.
    useAgentTrialStore.getState().startPolling(project => { const scene = useSceneStore.getState(); return scene.lib?.project_name === project ? scene.table : null })
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
  // Where an audition goes: the selected connected devices (all by default) whose address position fits the cue's
  // routes (the trial's first scene cue / the event); without a cue, every selected device.
  const routedCue = useAgentTrialStore(state => {
    const shown = state.audition
    const trial = shown ? state.trials.find(r => r.trial.id === shown.trialId)?.trial : undefined
    return trial?.scene ? `${trial.scene.project}\n${trial.scene.cues[0]}` : null
  })
  const sceneTable = useSceneStore(state => state.table)
  const sceneLib = useSceneStore(state => state.lib)
  /** The event material being adjusted (its editor document is selected), if any. */
  const adjusting = useEditorSettings(state => !audition && !eventPreview && s.clip ? state.materialLinks[s.clip.id] : undefined)
  const routeAts = useMemo(() => {
    if (!sceneTable || !sceneLib) return null
    if (audition) {
      if (!routedCue) return null
      const [project, cue] = routedCue.split('\n')
      return project === sceneLib.project_name ? cueRoutePositions(sceneTable, sceneLib, cue) : null
    }
    if (eventPreview) return cueRoutePositions(sceneTable, sceneLib, eventPreview.event)
    // An adjusted material goes where its events' routes go (every event using it).
    return adjusting && adjusting.project === sceneLib.project_name ? materialRoutePositions(sceneTable, sceneLib, adjusting.target, adjusting.wav, adjusting.event) : null
  }, [sceneTable, sceneLib, audition, routedCue, eventPreview, adjusting])
  const routing = useMemo(() => routePlaybackTargets(isConnected ? resolvePlaybackTargets(devices, kitSelectedIps) : [], routeAts), [isConnected, devices, kitSelectedIps, routeAts])
  const shownBuffer = audition ? audition.buffer : eventPreview ? eventPreview.buffer : original ? s.clip?.originalBuffer : previewActive ? (preview.buffer ?? s.clip?.buffer) : s.clip?.buffer
  // Auditions (AI candidate / event material) play at the scene's timing: on every target firing, without jitter
  // (DEC-085); one buffer, so Stop ends them all and seeks follow the video.
  const plan = useAuditionPlan()
  const stretched = !!shownBuffer && !!plan && (!!audition || !!eventPreview || !!adjusting) && !(plan.targets.length === 1 && plan.targets[0] === 0)
  // The group of the shown event material (its cue and the cue's variants: bite and bite:tear) plays together at the stretch
  // (editor setting, default on): each member's firing with its representative sound and haptic at their intensities.
  const groupOn = useEditorSettings(state => state.groupPlayback)
  const groupShown = !audition && sceneLib ? eventPreview ? { event: eventPreview.event, target: eventPreview.target, material: eventPreview.material }
    : adjusting && adjusting.project === sceneLib.project_name ? { event: adjusting.event, target: adjusting.target, material: adjusting.wav } : null : null
  // With them, the context's one-shot cues (an audition's scene.context / 「同時」 group: their decided haptics at their firings).
  const groupKey = sceneTable && (groupShown || plan?.context) ? JSON.stringify([...groupShown ? groupFirings(sceneTable, plan ?? { targets: [0], others: [], contextCues: [], context: null }, groupShown, groupOn).haptics : [],
    ...plan?.context ? contextHapticParts(sceneTable, plan.context) : []]) : '[]'
  const scenePcm = useSceneStore(state => state.pcm)
  // The playback runs to the end of the group's last haptic too (a bite after the last tear was cut off with the shown buffer).
  const groupEndSec = useMemo(() => groupHapticsEnd(JSON.parse(groupKey) as HapticPart[], scenePcm), [groupKey, scenePcm])
  // A scene audition runs (haptic stream and Scene video, which pauses at its end) to the last firing + the post-roll, or
  // to the end of the longest sound / haptic played if later (sceneStopSec); the sounds ring out on their own after it.
  const sceneSounds = useSceneSounds()
  const postRollSec = useEditorSettings(state => state.scenePostRollSec)
  const stopSec = useMemo(() => !shownBuffer || !plan || (!audition && !eventPreview && !adjusting) ? 0 : sceneStopSec({
    firings: [...plan.targets, ...plan.others.map(o => o.atSec), ...(plan.context?.firings ?? []).map(f => f.atSec)],
    postRollSec,
    untilSec: plan.context?.endSec,
    sounds: (sceneSounds.firings ?? []).map(f => ({ atSec: f.atSec, durSec: f.buffer.duration })),
    haptics: [...(stretched ? plan.targets : [0]).map(atSec => ({ atSec, durSec: shownBuffer.duration })), { atSec: 0, durSec: groupEndSec }],
  }), [shownBuffer, plan, audition, eventPreview, adjusting, postRollSec, sceneSounds.firings, stretched, groupEndSec])
  const minSec = Math.max(groupEndSec, stopSec)
  const audioBuffer = useMemo(() => shownBuffer && ((stretched && plan) || minSec > shownBuffer.duration)
    ? repeatBuffer(shownBuffer, (stretched && plan ? plan.targets : [0]).map(atSec => ({ atSec, gain: 1, rate: 1 })), minSec) : shownBuffer, [stretched, shownBuffer, plan, minSec])
  /** What the waveform panel shows: the file once, or the material placed at its event's firings (header line + per-firing marks). */
  const shownLayout = useMemo((): ShownLayout | null => shownBuffer ? { materialSec: shownBuffer.duration, starts: stretched && plan ? plan.targets : null } : null, [shownBuffer, stretched, plan])
  // By value (groupKey): saving a strength rewrites the table but not these parts, so nothing is mixed again for it.
  // The context's loop cues: their haptics at the recorded layer levels over the playback (mono, to the same devices).
  const sceneData = useSceneStore(state => state.data)
  const contextLoops = useMemo(() => plan?.context?.layers.length && sceneTable && sceneLib && sceneData && audioBuffer
    ? renderContextLoops(sceneTable, sceneLib, sceneData, plan.context, scenePcm, audioBuffer.duration) : null, [plan, sceneTable, sceneLib, sceneData, scenePcm, audioBuffer?.duration])
  /** Sound or haptic shown (an AI candidate's target, else the event material's); null = a plain clip. */
  const shownTarget = audition ? (auditionIsSound ? 'sound' : 'haptic') : groupShown?.target ?? null
  const groupStream = useMemo(() => {
    const parts = JSON.parse(groupKey) as HapticPart[]
    if ((!parts.length && !contextLoops) || !audioBuffer || !shownTarget) return null
    const base = shownTarget === 'haptic' ? { data: audioBuffer.getChannelData(0), rate: audioBuffer.sampleRate } : null
    const mixed = mixGroupHaptics(base, parts, scenePcm, audioBuffer.duration, contextLoops)
    const buffer = new AudioBuffer({ numberOfChannels: 1, length: mixed.length, sampleRate: HAPTIC_RATE })
    buffer.getChannelData(0).set(mixed)
    return buffer
  }, [groupKey, audioBuffer, scenePcm, shownTarget, contextLoops])
  const streamRef = useRef<AudioBuffer | null>(null); streamRef.current = groupStream
  // A sound (AI sound candidate, event sound, adjusted sound material) plays on the PC only — except its group's haptics.
  const soundShown = auditionIsSound || eventPreview?.target === 'sound' || adjusting?.target === 'sound'
  const targets = useMemo(() => isConnected && sendHaptics && (!soundShown || !!groupStream) ? routing.devices.map(device => device.ipAddress) : [], [isConnected, sendHaptics, soundShown, !!groupStream, routing])
  /** Where the live strength applies in the stream: the shown haptic's firings (the group's parts keep their own); nowhere for a shown sound. */
  const levelSpans = groupStream ? shownTarget === 'haptic' && shownBuffer ? shownSpans(stretched && plan ? plan.targets : null, shownBuffer.duration) : [] : null
  const spansRef = useRef(levelSpans); spansRef.current = levelSpans
  const targetKey = targets.join(',')
  // The shown material's strength (DEC-086: WAV × intensity): a gain on the PC output and the device stream and a scale
  // of the "edited" drawing, changed live by the strength slider; the buffer is never rendered again for it.
  // An AI candidate's comes from its rating form (published by the AI trials panel).
  const levelKeyShown = audition ? levelKey.candidate(audition.trialId, audition.candidateId)
    : eventPreview ? levelKey.material(eventPreview.target, eventPreview.material) : adjusting ? levelKey.material(adjusting.target, adjusting.wav) : null
  const levelMaterial = audition ? null : eventPreview ? { target: eventPreview.target, wav: eventPreview.material } : adjusting ?? null
  const materialLevel = useSceneStore(state => levelMaterial && state.table ? materialIntensity(state.table, levelMaterial.target, levelMaterial.wav) : 1)
  const candidateLevel = useEventStore(state => audition ? state.levels[levelKey.candidate(audition.trialId, audition.candidateId)] ?? 1 : 1)
  const savedLevel = audition ? candidateLevel : materialLevel
  const liveLevel = useEventStore(state => levelKeyShown && state.liveLevel?.key === levelKeyShown ? state.liveLevel.value : null)
  // "Original" is the file as it is: drawn and played without it.
  const level = levelKeyShown && !original ? liveLevel ?? savedLevel : 1
  const levelRef = useRef(level); levelRef.current = level
  const player = useMemo(() => new EditorBufferPlayer(null, undefined, s.setError), [s.clip?.id, original, auditionKey])
  useEffect(() => {player.activate(); return () => player.dispose()}, [player])
  useEffect(() => { player.setLevel(level) }, [player, level])
  // A haptic audition going to devices: the PC sounds play the scene's haptic lead later (hapticLeadMs, > 0 = the haptic
  // is sent earlier than the sound; the Scene tab's calibration), and the waveform panel draws them that much later.
  const hapticAudition = (!!audition && !auditionIsSound) || (!audition && eventPreview?.target === 'haptic') || adjusting?.target === 'haptic'
  const hapticLeadMs = useSceneSettings(state => state.hapticLeadMs)
  const leadSec = hapticAudition && targets.length ? hapticLeadMs / 1000 : 0
  useDecidedSoundSync(player, sceneSounds, leadSec)
  const soundLane = useMemo((): SoundLane | null => {
    if (!hapticAudition || !audioBuffer) return null
    const parts = soundLaneParts(sceneSounds, leadSec)
    return parts.length ? { data: mixLane(parts, audioBuffer.duration), rate: LANE_RATE, leadMs: leadSec * 1000 } : null
  }, [hapticAudition, audioBuffer, sceneSounds, leadSec])
  useAdjustPersistence()
  // An adjusted event material: what its chain renders (live preview, or the clip without pending changes) goes back to the WAV.
  useMaterialWriteBack(previewActive ? (preview.status === 'ready' ? preview.buffer ?? null : null) : pendingChain ? null : s.clip?.buffer ?? null,
    previewActive && preview.status === 'error' ? preview.error : null)
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
      // The devices get the group's haptic mix when there is one (same length as the player's buffer), else what is played.
      const buffer = streamRef.current ?? player.getBuffer()
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
  playback.level = time => spansRef.current === null || inSpans(spansRef.current, time) ? levelRef.current : 1
  // ▶ on a material plays it once from the start (again on the material already shown).
  const autoplayed = useRef<{ buffer: AudioBuffer; request: number } | null>(null)
  useEffect(() => {
    if (!eventPreview?.autoplay || (autoplayed.current?.buffer === eventPreview.buffer && autoplayed.current.request === (eventPreview.playRequest ?? 0))) return
    autoplayed.current = { buffer: eventPreview.buffer, request: eventPreview.playRequest ?? 0 }
    // One shot: the ▶ is consumed here, so a later remount or tab switch never plays it again by itself.
    useEventStore.setState({ preview: { ...eventPreview, autoplay: false } })
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
  useEffect(() => { player.setOutput(waveformOnPc({ hapticAudition, hapticOnPc })) }, [player, hapticAudition, hapticOnPc])
  useEffect(() => { setOriginal(false); useAgentTrialStore.getState().clearAudition(); useEventStore.getState().clearPreview() }, [s.clip?.id])
  // ▶ on an AI candidate (requestAudition with play): the usual playback path. Consumed at once, so a request made while the tab is hidden never plays later.
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
      // An adjusted material shown at its event's firings: a region on that stretch is not a region of the material.
      if (event.key === 'Delete' && state.selectedRegion && !stretched) { event.preventDefault(); state.deleteRegion() }
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
  }, [active, original, audition, eventPreview, popoutWindows, stretched])
  const linkSceneProject = useCallback(async (name: string | null) => {
    const result = await useSceneStore.getState().linkProject(name, true)
    if (result.ok) return true
    if (result.notice) setNotice(t(result.notice.id, result.notice.params))
    return false
  }, [t])
  /**
   * "▶ Video" (AI trial / Properties / Events): picks what the Scene video panel shows, then shows the
   * panel in its own window. An open Scene project is never replaced (the Events panel chooses it); with
   * none open, the project last chosen in the Events panel is linked first (registered folder: permission
   * if needed; else the folder picker once — both need this click). A blocked pop-up leaves it docked in
   * the editor with a notice.
   */
  const openSceneVideo = useCallback((target: SceneVideoTarget) => {
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
    if (scene.root && scene.lib) { show(); return }
    void linkSceneProject(lastSceneProject()).then(show, s.setError)
  }, [dockApi, t, s.setError, linkSceneProject])
  const focusEditorPanel = useCallback((id: Parameters<EditorShared['focusEditorPanel']>[0]) => { if (dockApi) focusPanel(dockApi, id, t) }, [dockApi, t])
  const shared: EditorShared = {
    active, original, setOriginal, pendingChain, preview, auditionKey, audioBuffer, shownLayout, soundLane, level, player, playback, pending, togglePlay, playAt, stopPlayback, isPlaybackActive, playFromStart, toggleCandidate,
    openRecipe, provenanceText, isConnected, playbackDevices, targets, routing, setVisibleClipIds, openSceneVideo, linkSceneProject, focusEditorPanel,
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
