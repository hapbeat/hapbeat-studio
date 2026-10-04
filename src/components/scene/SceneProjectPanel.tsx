import { useEffect, useRef } from 'react'
import { useI18n } from '@/i18n/I18nProvider'
import { useSceneStore } from '@/stores/sceneStore'
import { useSceneSettings } from '@/stores/sceneSettings'
import { matchesAddress, tableTargets } from '@/utils/sceneHaptics'
import { useScene } from './sceneContext'
import { NumberField, useAtLabel } from './SceneCuePanels'

/** Applying the saved table to the game (step ③), the cue table on disk, haptic timing, device coverage and the stream log. */
export function SceneProjectPanel() {
  const { t } = useI18n()
  const { devices, helperConnected } = useScene()
  const atLabel = useAtLabel()
  const root = useSceneStore(s => s.root)
  const lib = useSceneStore(s => s.lib)
  const table = useSceneStore(s => s.table)
  const soundFiles = useSceneStore(s => s.soundFiles)
  const dirty = useSceneStore(s => s.dirty)
  const log = useSceneStore(s => s.log)
  const lead = useSceneSettings(s => s.hapticLeadMs)
  const logBox = useRef<HTMLPreElement>(null)
  useEffect(() => { const el = logBox.current; if (el) el.scrollTop = el.scrollHeight }, [log])
  if (!lib || !table || !root) return <div className="scene-panel-empty">{t('scene.noProject')}</div>
  const copy = async () => {
    try { await navigator.clipboard.writeText(lib.import_command); useSceneStore.getState().note({ id: 'scene.import.copied' }) }
    catch (error) { useSceneStore.getState().note({ id: 'scene.import.copyFailed', params: { error: String(error) }, error: true }) }
  }
  const targets = tableTargets(table)
  return <div className="scene-project">
    <div className="scene-sec">
      <h3>{t('scene.import.heading')}</h3>
      <div className="scene-dim">{t('scene.import.hint')}</div>
      <code className="scene-cmd">{lib.import_command}</code>
      <button type="button" className="toolbar-btn" onClick={() => void copy()}>{t('scene.import.copy')}</button>
    </div>
    <div className="scene-sec">
      <h3>{t('scene.data.heading')}</h3>
      <div>{t('scene.data.table', { folder: root.name, file: lib.paths.cues })}</div>
      <div className="scene-dim">{t('scene.data.counts', { cues: Object.keys(table.cues).length, clips: Object.keys(table.clips).length, sounds: soundFiles.length })}
        <span className="scene-dirty-note">{dirty ? t('scene.dirty') : ''}</span></div>
    </div>
    <div className="scene-sec">
      <h3>{t('scene.output.heading')}</h3>
      <label className="scene-row"><span className="scene-dim">{t('scene.output.lead')}</span>
        <NumberField value={lead} step={10} min={-200} max={400} label={t('scene.output.lead')} onCommit={x => useSceneSettings.getState().update({ hapticLeadMs: Math.max(-200, Math.min(400, x)) })} />
        <span className="scene-dim">{t('scene.output.leadHint')}</span></label>
      <div className="scene-coverage">{t('scene.output.coverage')}{' '}
        {!helperConnected ? <span className="scene-dim">{t('scene.output.noHelper')}</span>
          : targets.length ? targets.map(tg => { const n = devices.filter(d => matchesAddress(tg, d.address)).length
            return <span key={tg} className={n ? 'scene-on' : 'scene-dim'}>{atLabel(tg.split('/').pop() ?? tg)} {t('scene.output.devices', { count: n })}</span> }) : '—'}
      </div>
      <div className="scene-dim">{t('scene.output.selectionHint')}</div>
    </div>
    <div className="scene-sec">
      <h3>{t('scene.log')}</h3>
      <pre className="scene-log" ref={logBox}>{log.join('\n')}</pre>
    </div>
  </div>
}
