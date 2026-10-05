import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useI18n } from '@/i18n/I18nProvider'
import { useAgentTrialStore } from '@/stores/agentTrialStore'
import { useEditorSettings } from '@/stores/editorSettings'
import { useWaveformStore } from '@/stores/waveformStore'
import { sceneVideoUrl, useSceneStore } from '@/stores/sceneStore'
import { resolveTrialScene, sceneEventTime, sceneVideoTime, stepSceneFrame, wantedSceneProject, type TrialSceneState } from '@/utils/trialScene'
import { setScenePause, setScenePreRoll, useSceneSegmentShots, useSceneVideoTarget, type SceneVideoTarget } from '@/utils/editorSceneSync'
import { planSegmentShots } from '@/utils/sceneSegments'
import { isLoopCue } from '@/utils/sceneCueTable'
import { eventSoundSec } from './eventAudio'
import { isTypingTarget } from '@/utils/playbackShortcut'
import { VideoOverlay } from '@/components/scene/VideoOverlay'
import { useEditor } from './editorContext'
import { useEventStore } from '@/stores/eventStore'
import { onUserStop } from '@/utils/playerStops'
import { effectiveEvent, eventSceneCues, resolveEventName } from '@/utils/cueEvents'
import './EditorScenePanel.css'

export type SceneSubject = { kind: 'trial'; trialId: string | null } | { kind: 'clip'; clipId: string | null } | { kind: 'event'; key: string | null }

/**
 * The scene moment of an AI trial (its `scene`, else the pick saved per trial id), of an editor
 * clip (pick saved per clip id) or of an event of the open project (its recorded cue; the pick is kept for the session).
 */
export function useSceneChoice(subject: SceneSubject) {
  const lib = useSceneStore(s => s.lib)
  const data = useSceneStore(s => s.data)
  const table = useSceneStore(s => s.table)
  const trials = useAgentTrialStore(s => s.trials)
  const id = subject.kind === 'trial' ? subject.trialId : subject.kind === 'clip' ? subject.clipId : subject.key
  const trial = subject.kind === 'trial' ? trials.find(r => r.trial.id === id)?.trial ?? null : null
  const eventPick = useEventStore(s => subject.kind === 'event' && id ? s.scenePicks[id] : undefined)
  const savedChoice = useEditorSettings(s => !id || subject.kind === 'event' ? undefined : subject.kind === 'trial' ? s.trialScenes[id] : s.clipScenes[id])
  const saved = subject.kind === 'event' ? eventPick : savedChoice
  const eventScene = useMemo(() => subject.kind === 'event' && id && lib && table ? { project: lib.project_name, cues: eventSceneCues(table, id) } : undefined, [subject.kind, id, lib, table])
  const scene = trial?.scene ?? eventScene
  /** The Scene project this subject needs (trial: `scene.project`, saved pick, `project` label; clip: saved pick; event: the open one). */
  const wanted = wantedSceneProject({ scene, saved, fallback: trial?.project })
  const sfx = useSceneStore(s => s.sfx)
  const state: TrialSceneState = useMemo(() => resolveTrialScene({ lib, data, scene, saved, project: wanted, soundSec: eventSoundSec }), [lib, data, scene, saved, wanted, table, sfx])
  const choose = (file: string) => {
    if (!lib || !id) return
    if (subject.kind === 'event') { useEventStore.getState().pickScene(id, file ? { project: lib.project_name, file } : null); return }
    const key = subject.kind === 'trial' ? 'trialScenes' : 'clipScenes'
    const choices = { ...useEditorSettings.getState()[key] }
    if (file) choices[id] = { project: lib.project_name, file }; else delete choices[id]
    useEditorSettings.getState().update({ [key]: choices })
  }
  return { id, trial, scene, wanted, state, chosen: state.kind === 'ready' ? state.chosen : null, choose }
}

const OTHER_SCENES = '\u0000scene-tab'
/**
 * Moment picker (a trial with `scene` always has one, so it offers no "none"). For an event / trial with
 * `scene`: the representative stretch first, then a recorded clip only when picked or named by the trial,
 * and one item that opens the event's firings in the Scene tab (DEC-085: no list of moments here).
 */
export function SceneChoiceSelect({ choice, label }: { choice: ReturnType<typeof useSceneChoice>; label: string }) {
  const { t } = useI18n()
  const { state, chosen, scene, choose } = choice
  if (state.kind !== 'ready') return <select aria-label={label} disabled><option>{t(state.kind === 'noProject' ? 'editor.scene.noProjectShort' : 'editor.scene.unavailable')}</option></select>
  const segment = state.options[0]?.segment
  return <select aria-label={label} value={chosen?.file ?? ''} title={segment ? t('editor.scene.segmentHint') : undefined}
    onChange={e => { if (e.target.value === OTHER_SCENES) { if (segment) useEventStore.getState().openInScene(segment.name) } else choose(e.target.value) }}>
    {!scene && <option value="">{t('editor.scene.pick')}</option>}
    {state.options.map(o => <option key={o.file} value={o.file}>{o.segment
      ? t(o.segment.run ? 'editor.scene.segmentRun' : 'editor.scene.segmentOne', { name: o.segment.name, at: o.segment.marks[0].toFixed(1), count: o.segment.marks.length })
      : o.label}</option>)}
    {segment && <option value={OTHER_SCENES}>{t('editor.scene.otherScenes', { name: segment.name, count: segment.total })}</option>}
  </select>
}

/** Which subject the panel shows: an auditioned candidate's trial, else the last "▶ Video" target. */
function useShownSubject(): SceneSubject {
  const audition = useAgentTrialStore(s => s.audition)
  const selectedTrialId = useAgentTrialStore(s => s.selectedTrialId)
  const target: SceneVideoTarget = useSceneVideoTarget(s => s.target)
  const clipId = useWaveformStore(s => s.clip?.id ?? null)
  if (audition) return { kind: 'trial', trialId: audition.trialId }
  if (target.kind === 'trial') return { kind: 'trial', trialId: target.trialId ?? selectedTrialId }
  if (target.kind === 'event') return { kind: 'event', key: target.key }
  return { kind: 'clip', clipId }
}

/**
 * "Scene video": the recorded game moment of the AI trial being rated or of
 * the selected clip, from the project open in the Scene tab (same store).
 * The (muted) video follows the editor playback — auditions of that trial, or
 * any playback of that clip: it starts `sceneLeadSec` before the cue mark and
 * the editor holds the sound + haptics back by the same lead, so they play
 * exactly on the mark; seeking and stopping follow the editor player. A lead
 * of 0 starts both at once. ⏸ (or Space / a click on the video while it runs) pauses the video and the
 * waveform playback at the same moment (the playhead stays there); while paused, ←/→ step the video by
 * 1/30 s and a waveform click seeks, both kept together; ▶ continues video, waveform and sound from there.
 */
export function EditorScenePanel() {
  const { t } = useI18n()
  const { player, playback, linkSceneProject, playFromStart, isPlaybackActive } = useEditor()
  /** Focus in this panel (its own window when popped out) = play "from the video": lead-in first, sound + haptics on the mark. */
  const rootRef = useRef<HTMLDivElement>(null)
  const [focused, setFocused] = useState(false)
  const focusedRef = useRef(false); focusedRef.current = focused
  useEffect(() => {
    const root = rootRef.current, doc = root?.ownerDocument, view = doc?.defaultView
    if (!root || !doc || !view) return
    const sync = () => setFocused(doc.hasFocus() && root.contains(doc.activeElement))
    const events: [EventTarget, string][] = [[root, 'focusin'], [root, 'focusout'], [view, 'focus'], [view, 'blur']]
    const later = () => { setTimeout(sync) }
    for (const [target, name] of events) target.addEventListener(name, later)
    sync()
    return () => { for (const [target, name] of events) target.removeEventListener(name, later) }
  })
  const video = useRef<HTMLVideoElement | null>(null)
  /** The same element as state, so the overlay gets it once it is mounted. */
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null)
  const videoRef = useCallback((el: HTMLVideoElement | null) => { video.current = el; setVideoEl(el) }, [])
  const root = useSceneStore(s => s.root)
  useEffect(() => { void useSceneStore.getState().restore() }, [])
  const audition = useAgentTrialStore(s => s.audition)
  const subject = useShownSubject()
  const choice = useSceneChoice(subject)
  const { state, chosen, trial, wanted } = choice
  // Open the wanted project by name without asking when its folder is registered and still permitted;
  // otherwise remember why, for the one-click link button.
  const [linkNeed, setLinkNeed] = useState<'needsClick' | 'unregistered' | 'dirty' | null>(null)
  const needsLink = state.kind === 'noProject' || state.kind === 'otherProject'
  useEffect(() => {
    setLinkNeed(null)
    if (!needsLink) return
    let cancelled = false
    void useSceneStore.getState().linkProject(wanted ?? null, false).then(result => {
      if (cancelled || result.ok) return
      setLinkNeed(result.reason === 'needsClick' || result.reason === 'dirty' ? result.reason : 'unregistered')
    })
    return () => { cancelled = true }
  }, [needsLink, wanted])
  const clipName = useWaveformStore(s => s.clip?.name ?? '')
  const lead = useEditorSettings(s => s.sceneLeadSec)
  const [src, setSrc] = useState<string | null>(null)
  /** A clip video that cannot be read (missing file, or a name the folder cannot hold such as `:`) is reported instead of "loading" forever. */
  const [videoError, setVideoError] = useState<string | null>(null)
  useEffect(() => {
    setVideoError(null)
    if (!root || !chosen) { setSrc(null); return }
    let cancelled = false
    sceneVideoUrl(root, chosen.file).then(url => { if (!cancelled) setSrc(url) }, error => { if (!cancelled) { setSrc(null); setVideoError(error instanceof Error ? error.message : String(error)) } })
    return () => { cancelled = true }
  }, [root, chosen?.file])
  // Show the start frame (lead before the mark) whenever the clip or lead changes.
  const cue = () => { setPausedAt(null); const v = video.current; if (v && chosen) { v.pause(); v.currentTime = sceneVideoTime(chosen.mark, -lead) } }
  /** Paused at this time: seconds from the event start (the mark = 0; negative in the lead-in). null = not paused. */
  const [pausedAt, setPausedAt] = useState<number | null>(null)
  const pausedRef = useRef<number | null>(null); pausedRef.current = pausedAt
  /** The video is running (lead-in, with the playback, or ringing on after it); drives the ⏸/▶ icon. */
  const [videoRunning, setVideoRunning] = useState(false)
  /** Set while this panel moves the waveform playhead itself, so its 'seeking' does not move the video back to the mark. */
  const ownSeek = useRef(false)
  const seekWaveform = (time: number) => {
    ownSeek.current = true
    try { player.setTime(Math.max(0, Math.min(player.getDuration(), time))) } finally { ownSeek.current = false }
  }
  /** Stops video, waveform playback (haptics stream) and the decided sound where the video is; the playhead stays there. */
  const pauseHere = () => {
    const v = video.current
    if (!v || !chosen) return
    const time = sceneEventTime(chosen.mark, v.currentTime)
    v.pause()
    playback.stop()
    seekWaveform(time)
    setPausedAt(time)
  }
  /** Continues from the paused moment: in the lead-in the video runs first and the audio starts on the mark. */
  const resume = () => {
    const v = video.current, time = pausedRef.current
    if (!v || time === null) return
    setPausedAt(null)
    const duration = player.getDuration()
    // Past the audio (the video rings on to the moment's end): only the video continues.
    if (time >= duration) { void v.play().catch(() => {}); return }
    void playback.play(Math.max(0, time), duration, true, { seconds: Math.max(0, -time), begin: () => { void v.play().catch(() => {}) }, cancel: () => v.pause() })
      .catch(useWaveformStore.getState().setError)
  }
  /** ⏸/▶, Space and a click on the video: resume when paused, pause while running, else play from the lead-in. */
  const togglePause = () => {
    if (pausedRef.current !== null) resume()
    else if (isPlaybackActive() || (video.current && !video.current.paused)) pauseHere()
    else playFromStart(true)
  }
  const togglePauseRef = useRef(togglePause); togglePauseRef.current = togglePause
  /** Seek bar: while playing, the waveform moves (the video follows); otherwise video and waveform pause together there. */
  const seekVideo = (videoTime: number) => {
    const v = video.current
    if (!v || !chosen) return
    const time = sceneEventTime(chosen.mark, videoTime)
    if (pausedRef.current === null && isPlaybackActive() && time >= 0 && time < player.getDuration()) { player.setTime(time); return }
    v.pause()
    playback.stop()
    v.currentTime = videoTime
    seekWaveform(time)
    setPausedAt(time)
  }
  const stepFrame = (direction: 1 | -1) => {
    const v = video.current, time = pausedRef.current
    if (!v || !chosen || time === null) return
    const next = stepSceneFrame(time, direction, chosen.mark, v.duration)
    v.currentTime = chosen.mark + next
    seekWaveform(next)
    setPausedAt(next)
  }
  // A new subject, clip, lead or auditioned candidate re-cues the video (it waits; nothing plays by itself).
  const previewId = useEventStore(s => s.preview?.id)
  useEffect(cue, [src, chosen?.mark, lead, audition?.candidateId, audition?.trialId, previewId])
  // A trial follows its auditions; a clip follows the editor playback while no candidate is auditioned.
  const synced = !!chosen && (subject.kind === 'trial' ? audition?.trialId === subject.trialId : !audition)
  useEffect(() => {
    if (!synced || !chosen) return
    const at = (time: number) => sceneVideoTime(chosen.mark, time)
    setScenePreRoll({
      active: () => focusedRef.current,
      seconds: lead,
      begin: start => { const v = video.current; if (!v) return; v.currentTime = at(start - lead); void v.play().catch(() => {}) },
      cancel: () => video.current?.pause(),
    })
    setScenePause({ paused: () => pausedRef.current !== null, toggle: () => togglePauseRef.current() })
    // A repeated event: one firing per mark (the editor repeats the shown sound / haptic and the event's sound).
    const scene = useSceneStore.getState(), name = chosen.segment?.name
    const resolved = name && scene.table ? resolveEventName(scene.table, name) : null
    const e = resolved && scene.table ? effectiveEvent(scene.table, resolved.ref) : null
    useSceneSegmentShots.getState().set(name ?? null, e && scene.lib && chosen.marks.length > 1 ? planSegmentShots(e, chosen.marks, isLoopCue(scene.lib, e.ref.cue)) : null)
    const unsubs = [
      // After the lead-in the video is already running; only correct a visible drift. Any play ends a pause.
      player.on('play', time => { setPausedAt(null); const v = video.current; if (!v) return; if (v.paused || Math.abs(v.currentTime - at(time)) > 0.1) v.currentTime = at(time); void v.play().catch(() => {}) }),
      // A waveform seek moves the video (and, while paused, the paused moment); the panel's own seeks are skipped.
      player.on('seeking', time => { if (ownSeek.current) return; const v = video.current; if (v) v.currentTime = at(time); if (pausedRef.current !== null) setPausedAt(time) }),
      // The video runs on after the audio ends naturally (to the moment's end); a stop pauses it.
      onUserStop(player, () => video.current?.pause()),
    ]
    return () => { setScenePreRoll(null); setScenePause(null); setPausedAt(null); useSceneSegmentShots.getState().set(null, null); unsubs.forEach(unsub => unsub()); video.current?.pause() }
  }, [player, synced, chosen?.mark, chosen?.marks.length, lead])
  // A stretch of the full replay ends at its end (the replay itself runs on).
  useEffect(() => {
    const v = videoEl, end = chosen?.end
    if (!v || end == null) return
    const stop = () => { if (!v.paused && v.currentTime >= end) v.pause() }
    v.addEventListener('timeupdate', stop)
    return () => v.removeEventListener('timeupdate', stop)
  }, [videoEl, chosen?.end])

  if (!choice.id) return <div className="editor-scene-panel"><p className="agent-muted">{t('editor.scene.noSubject')}</p></div>
  if (needsLink) {
    const text = linkNeed === 'dirty' ? t('scene.link.dirty') : linkNeed === 'needsClick' ? t('editor.scene.allowNamed', { name: wanted ?? '' })
      : wanted ? t('editor.scene.linkNamed', { name: wanted }) : t('editor.scene.linkAny')
    return <div className="editor-scene-panel editor-scene-link">
      <p className="agent-muted">{text}</p>
      {linkNeed && linkNeed !== 'dirty' && <button className="toolbar-btn" onClick={() => void linkSceneProject(wanted ?? null)}>{t(linkNeed === 'needsClick' ? 'editor.scene.allowButton' : 'editor.scene.linkButton')}</button>}
    </div>
  }
  const message = state.kind === 'noClips' ? t('editor.scene.noClips', { cues: state.cues.join(', ') }) : null
  /** Usage notes: the video's title and the overlay's ⓘ (no paragraph under the video). */
  const hint = synced ? `${t('editor.scene.synced')}\n${t('editor.scene.stepHint')}` : subject.kind === 'trial' && !trial ? '' : subject.kind === 'trial' ? t('editor.scene.auditionHint') : t('editor.scene.clipHint')
  const title = subject.kind === 'trial' ? t('editor.scene.forTrial', { id: choice.id }) : subject.kind === 'event' ? t('editor.scene.forEvent', { name: choice.id ?? '' }) : t('editor.scene.forClip', { name: clipName })
  return <div className="editor-scene-panel" ref={rootRef} tabIndex={-1}
    onKeyDown={e => { if (pausedRef.current === null || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') || isTypingTarget(e.target)) return; e.preventDefault(); stepFrame(e.key === 'ArrowRight' ? 1 : -1) }}>
    {/* One wrapping row: title, play mode, moment, lead-in (the details are in the titles). */}
    <div className="editor-scene-head">
      <span className="editor-scene-title" title={title}>{title}</span>
      {synced && <span className={`editor-scene-mode ${focused ? 'video' : ''}`} title={focused ? t('editor.scene.modeVideoHint', { seconds: lead }) : t('editor.scene.modeWaveHint')}>
        {focused ? t('editor.scene.modeVideo', { seconds: lead }) : t('editor.scene.modeWave')}</span>}
      {!message && <SceneChoiceSelect choice={choice} label={t('editor.scene.clip')} />}
      {!message && <label className="editor-scene-lead">{t('editor.scene.lead')}
        <input type="number" min={0} max={10} step={0.5} value={lead} onChange={e => { const x = parseFloat(e.target.value); if (Number.isFinite(x)) useEditorSettings.getState().update({ sceneLeadSec: Math.max(0, Math.min(10, x)) }) }} />
        {t('editor.scene.leadUnit')}</label>}
    </div>
    {message ? <p className="agent-muted">{message}</p> : <>
      <div className="editor-scene-stage" title={hint} onClick={e => { e.currentTarget.closest<HTMLElement>('.editor-scene-panel')?.focus(); focusedRef.current = true; setFocused(true); if (synced) togglePause() }}>
        {chosen && src && !videoError ? <video ref={videoRef} src={src} muted playsInline preload="auto" onLoadedMetadata={cue} onPlay={() => setVideoRunning(true)} onPause={() => setVideoRunning(false)} onError={e => setVideoError(e.currentTarget.error?.message || `MediaError ${e.currentTarget.error?.code ?? ''}`)} />
          : <p className="agent-muted">{chosen && videoError ? t('editor.scene.unreadable', { file: chosen.file, error: videoError }) : chosen ? t('editor.scene.loading') : t('editor.scene.pickHint')}</p>}
        {synced && chosen && src && !videoError && <VideoOverlay video={videoEl} mark={chosen.mark} marks={chosen.marks} range={chosen.segment ? [chosen.segment.start, chosen.segment.end] : null} playing={videoRunning}
          onToggle={() => { focusedRef.current = true; setFocused(true); togglePause() }} onSeek={seekVideo} info={hint} />}
      </div>
    </>}
  </div>
}
