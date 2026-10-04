import { useEffect, useMemo, useRef, useState } from 'react'
import { useI18n } from '@/i18n/I18nProvider'
import { useAgentTrialStore } from '@/stores/agentTrialStore'
import { useEditorSettings } from '@/stores/editorSettings'
import { sceneVideoUrl, useSceneStore } from '@/stores/sceneStore'
import { resolveTrialScene, sceneVideoTime } from '@/utils/trialScene'
import { setScenePreRoll } from '@/utils/editorSceneSync'
import { useEditor } from './editorContext'
import './EditorScenePanel.css'

/**
 * "Scene video": the recorded game moment of the AI trial being rated, from
 * the project open in the Scene tab (same store). While a candidate of that
 * trial is auditioned, the (muted) video starts `sceneLeadSec` before the cue
 * mark and the audition (sound + haptics) is held back by the same lead, so it
 * sounds exactly on the mark; seeking and stopping follow the editor player.
 * A lead of 0 starts both at once.
 */
export function EditorScenePanel() {
  const { t } = useI18n()
  const { player } = useEditor()
  const video = useRef<HTMLVideoElement>(null)
  const root = useSceneStore(s => s.root)
  const lib = useSceneStore(s => s.lib)
  const data = useSceneStore(s => s.data)
  useEffect(() => { void useSceneStore.getState().restore() }, [])
  const audition = useAgentTrialStore(s => s.audition)
  const selectedTrialId = useAgentTrialStore(s => s.selectedTrialId)
  const trials = useAgentTrialStore(s => s.trials)
  const trialId = audition?.trialId ?? selectedTrialId
  const trial = trials.find(r => r.trial.id === trialId)?.trial ?? null
  const saved = useEditorSettings(s => trialId ? s.trialScenes[trialId] : undefined)
  const lead = useEditorSettings(s => s.sceneLeadSec)
  const state = useMemo(() => resolveTrialScene({ lib, data, scene: trial?.scene, saved }), [lib, data, trial, saved])
  const chosen = state.kind === 'ready' ? state.chosen : null
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    if (!root || !chosen) { setSrc(null); return }
    let cancelled = false
    sceneVideoUrl(root, chosen.file).then(url => { if (!cancelled) setSrc(url) }, () => { if (!cancelled) setSrc(null) })
    return () => { cancelled = true }
  }, [root, chosen?.file])
  // Show the start frame (lead before the mark) whenever the clip or lead changes.
  const cue = () => { const v = video.current; if (v && chosen) { v.pause(); v.currentTime = sceneVideoTime(chosen.mark, -lead) } }
  useEffect(cue, [src, chosen?.mark, lead])
  const synced = !!chosen && !!audition && audition.trialId === trialId
  useEffect(() => {
    if (!synced || !chosen) return
    const at = (time: number) => sceneVideoTime(chosen.mark, time)
    setScenePreRoll({
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

  if (!trialId || !trial) return <div className="editor-scene-panel"><p className="agent-muted">{t('editor.scene.noTrial')}</p></div>
  const message = state.kind === 'noProject' ? t('editor.scene.openInScene')
    : state.kind === 'otherProject' ? t('editor.scene.otherProject', { project: state.project })
      : state.kind === 'noClips' ? t('editor.scene.noClips', { cues: state.cues.join(', ') }) : null
  if (message) return <div className="editor-scene-panel"><p className="agent-muted">{message}</p></div>
  const options = state.kind === 'ready' ? state.options : []
  const choose = (file: string) => {
    if (!lib || !trialId) return
    const trialScenes = { ...useEditorSettings.getState().trialScenes }
    if (file) trialScenes[trialId] = { project: lib.project_name, file }; else delete trialScenes[trialId]
    useEditorSettings.getState().update({ trialScenes })
  }
  return <div className="editor-scene-panel">
    <div className="editor-scene-bar">
      <select aria-label={t('editor.scene.clip')} value={chosen?.file ?? ''} onChange={e => choose(e.target.value)}>
        {!trial.scene && <option value="">{t('editor.scene.pick')}</option>}
        {options.map(o => <option key={o.file} value={o.file}>{o.label}</option>)}
      </select>
      <label className="editor-scene-lead">{t('editor.scene.lead')}
        <input type="number" min={0} max={10} step={0.5} value={lead} onChange={e => { const x = parseFloat(e.target.value); if (Number.isFinite(x)) useEditorSettings.getState().update({ sceneLeadSec: Math.max(0, Math.min(10, x)) }) }} />
        {t('editor.scene.leadUnit')}</label>
    </div>
    <div className="editor-scene-stage">
      {chosen && src ? <video ref={video} src={src} muted playsInline preload="auto" onLoadedMetadata={cue} />
        : <p className="agent-muted">{trial.scene ? t('editor.scene.loading') : t('editor.scene.pickHint')}</p>}
    </div>
    <p className="agent-muted editor-scene-hint">{synced ? t('editor.scene.synced') : t('editor.scene.auditionHint')}</p>
  </div>
}
