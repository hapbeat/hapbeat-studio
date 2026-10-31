import { useEffect, useRef } from 'react'
import { useI18n } from '@/i18n/I18nProvider'
import { useSceneStore } from '@/stores/sceneStore'
import { matchesAddress, tableTargets } from '@/utils/sceneHaptics'
import { useScene } from './sceneContext'
import { useAtLabel } from './SceneCuePanels'
import { FireOffsetField, PcOffsetField } from '@/components/common/PcTiming'
import { useScenePlayback } from '@/stores/scenePlayback'
import { SceneKitStatus } from './SceneKitStatus'
import { SceneOutputSettings } from './SceneOutputToggles'

/**
 * Applying the saved table to the game (step ③; only when the lib names a command), the cue table on disk, haptic
 * timing, device coverage and the stream log. A project without a cue table offers "Create the cue table" instead.
 */
export function SceneProjectPanel() {
  const { t } = useI18n()
  const { devices, helperConnected } = useScene()
  const atLabel = useAtLabel()
  const root = useSceneStore(s => s.root)
  const lib = useSceneStore(s => s.lib)
  const table = useSceneStore(s => s.table)
  const soundFiles = useSceneStore(s => s.soundFiles)
  const dirty = useSceneStore(s => s.dirty)
  const noTable = useSceneStore(s => s.noTable)
  const busy = useSceneStore(s => s.busy)
  const log = useSceneStore(s => s.log)
  const fire = useScenePlayback(s => s.output) === 'fire'
  const allDevices = useScenePlayback(s => s.allDevices)
  const logBox = useRef<HTMLPreElement>(null)
  useEffect(() => { const el = logBox.current; if (el) el.scrollTop = el.scrollHeight }, [log])
  if (lib && root && noTable) return <div className="scene-project">
    <div className="scene-sec">
      <h3>{t('scene.data.heading')}</h3>
      <div className="scene-dim">{t('scene.table.missing', { file: lib.paths.cues })}</div>
      <button type="button" className="toolbar-btn" disabled={busy} title={t('scene.table.createHint', { file: lib.paths.cues })}
        onClick={() => void useSceneStore.getState().createTable()}>{t('scene.table.create')}</button>
    </div>
  </div>
  if (!lib || !table || !root) return <div className="scene-panel-empty">{t('scene.noProject')}</div>
  const copy = async () => {
    try { await navigator.clipboard.writeText(lib.import_command); useSceneStore.getState().note({ id: 'scene.import.copied' }) }
    catch (error) { useSceneStore.getState().note({ id: 'scene.import.copyFailed', params: { error: String(error) }, error: true }) }
  }
  const targets = tableTargets(table)
  return <div className="scene-project">
    {lib.import_command && <div className="scene-sec">
      <h3>{t('scene.import.heading')}</h3>
      <div className="scene-dim">{t('scene.import.hint')}</div>
      <code className="scene-cmd">{lib.import_command}</code>
      <button type="button" className="toolbar-btn" onClick={() => void copy()}>{t('scene.import.copy')}</button>
    </div>}
    <div className="scene-sec">
      <h3>{t('scene.data.heading')}</h3>
      <div>{t('scene.data.table', { folder: root.name, file: lib.paths.cues })}</div>
      <div className="scene-dim">{t('scene.data.counts', { cues: Object.keys(table.cues).length, clips: Object.keys(table.clips).length, sounds: soundFiles.length })}
        <span className="scene-dirty-note">{dirty ? t('scene.saving') : ''}</span></div>
    </div>
    <div className="scene-sec">
      <h3>{t('scene.output.heading')}</h3>
      <SceneOutputSettings />
      <div className="scene-row"><PcOffsetField /><FireOffsetField /></div>
      {/* With all Hapbeats on, every selected device plays every route: one count instead of the per-position ones. */}
      <div className="scene-coverage">{t(allDevices ? 'scene.output.allCoverage' : 'scene.output.coverage')}{' '}
        {!helperConnected ? <span className="scene-dim">{t('scene.output.noHelper')}</span>
          : allDevices ? <span className={devices.length ? 'scene-on' : 'scene-dim'}>{t('scene.output.devices', { count: devices.length })}</span>
            : targets.length ? targets.map(tg => { const n = devices.filter(d => matchesAddress(tg, d.address)).length
              return <span key={tg} className={n ? 'scene-on' : 'scene-dim'}>{atLabel(tg.split('/').pop() ?? tg)} {t('scene.output.devices', { count: n })}</span> }) : '—'}
      </div>
      <div className="scene-dim">{t(allDevices ? 'scene.output.selectionHintAll' : 'scene.output.selectionHint')}</div>
    </div>
    {fire && <SceneKitStatus />}
    <div className="scene-sec">
      <h3>{t('scene.log')}</h3>
      <pre className="scene-log" ref={logBox}>{log.join('\n')}</pre>
    </div>
  </div>
}
