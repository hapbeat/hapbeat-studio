import { useEffect, useMemo, useRef, useState } from 'react'
import { useI18n } from '@/i18n/I18nProvider'
import { useAgentTrialStore } from '@/stores/agentTrialStore'
import { useEditorSettings } from '@/stores/editorSettings'
import { useWaveformStore } from '@/stores/waveformStore'
import { sceneVideoUrl, useSceneStore } from '@/stores/sceneStore'
import { resolveTrialScene, sceneVideoTime, wantedSceneProject, type TrialSceneState } from '@/utils/trialScene'
import { setScenePreRoll, useSceneVideoTarget, type SceneVideoTarget } from '@/utils/editorSceneSync'
import { useEditor } from './editorContext'
import { useEventStore } from '@/stores/eventStore'
import { eventSceneCues } from '@/utils/cueEvents'
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
  const state: TrialSceneState = useMemo(() => resolveTrialScene({ lib, data, scene, saved, project: wanted }), [lib, data, scene, saved, wanted])
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

/** Moment picker (a trial with `scene` always has one, so it offers no "none"). */
export function SceneChoiceSelect({ choice, label }: { choice: ReturnType<typeof useSceneChoice>; label: string }) {
  const { t } = useI18n()
  const { state, chosen, scene, choose } = choice
  if (state.kind !== 'ready') return <select aria-label={label} disabled><option>{t(state.kind === 'noProject' ? 'editor.scene.noProjectShort' : 'editor.scene.unavailable')}</option></select>
  return <select aria-label={label} value={chosen?.file ?? ''} onChange={e => choose(e.target.value)}>
    {!scene && <option value="">{t('editor.scene.pick')}</option>}
    {state.options.map(o => <option key={o.file} value={o.file}>{o.label}</option>)}
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
 * of 0 starts both at once.
 */
export function EditorScenePanel() {
  const { t } = useI18n()
  const { player, linkSceneProject, togglePlay } = useEditor()
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
  const video = useRef<HTMLVideoElement>(null)
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
  const cue = () => { const v = video.current; if (v && chosen) { v.pause(); v.currentTime = sceneVideoTime(chosen.mark, -lead) } }
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
    const unsubs = [
      // After the lead-in the video is already running; only correct a visible drift.
      player.on('play', time => { const v = video.current; if (!v) return; if (v.paused || Math.abs(v.currentTime - at(time)) > 0.1) v.currentTime = at(time); void v.play().catch(() => {}) }),
      player.on('seeking', time => { const v = video.current; if (v) v.currentTime = at(time) }),
      player.on('pause', () => video.current?.pause()),
      player.on('finish', () => video.current?.pause()),
    ]
    return () => { setScenePreRoll(null); unsubs.forEach(unsub => unsub()); video.current?.pause() }
  }, [player, synced, chosen?.mark, lead])

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
  const title = subject.kind === 'trial' ? t('editor.scene.forTrial', { id: choice.id }) : subject.kind === 'event' ? t('editor.scene.forEvent', { name: choice.id ?? '' }) : t('editor.scene.forClip', { name: clipName })
  return <div className="editor-scene-panel" ref={rootRef} tabIndex={-1}>
    <div className="editor-scene-title" title={title}>{title}
      {synced && <span className={`editor-scene-mode ${focused ? 'video' : ''}`}>{focused ? t('editor.scene.modeVideo', { seconds: lead }) : t('editor.scene.modeWave')}</span>}</div>
    {message ? <p className="agent-muted">{message}</p> : <>
      <div className="editor-scene-bar">
        <SceneChoiceSelect choice={choice} label={t('editor.scene.clip')} />
        <label className="editor-scene-lead">{t('editor.scene.lead')}
          <input type="number" min={0} max={10} step={0.5} value={lead} onChange={e => { const x = parseFloat(e.target.value); if (Number.isFinite(x)) useEditorSettings.getState().update({ sceneLeadSec: Math.max(0, Math.min(10, x)) }) }} />
          {t('editor.scene.leadUnit')}</label>
      </div>
      <div className="editor-scene-stage" onClick={e => { e.currentTarget.closest<HTMLElement>('.editor-scene-panel')?.focus(); focusedRef.current = true; setFocused(true); if (synced) togglePlay() }}>
        {chosen && src && !videoError ? <video ref={video} src={src} muted playsInline preload="auto" onLoadedMetadata={cue} onError={e => setVideoError(e.currentTarget.error?.message || `MediaError ${e.currentTarget.error?.code ?? ''}`)} />
          : <p className="agent-muted">{chosen && videoError ? t('editor.scene.unreadable', { file: chosen.file, error: videoError }) : chosen ? t('editor.scene.loading') : t('editor.scene.pickHint')}</p>}
      </div>
      <p className="agent-muted editor-scene-hint">{synced ? t('editor.scene.synced') : subject.kind === 'trial' && !trial ? '' : subject.kind === 'trial' ? t('editor.scene.auditionHint') : t('editor.scene.clipHint')}</p>
    </>}
  </div>
}
