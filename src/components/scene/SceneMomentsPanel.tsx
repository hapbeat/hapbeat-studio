import { useEffect, useRef } from 'react'
import { useI18n } from '@/i18n/I18nProvider'
import { useSceneStore } from '@/stores/sceneStore'
import { familyColor } from '@/utils/sceneData'
import { HapticIcon } from './HapticIcon'

/** The moments list: the full replay, then one clip per cue moment, with which outputs its cues use. */
export function SceneMomentsPanel() {
  const { t } = useI18n()
  const lib = useSceneStore(s => s.lib)
  const items = useSceneStore(s => s.items)
  const table = useSceneStore(s => s.table)
  const cur = useSceneStore(s => s.cur)
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => { list.current?.querySelector('.scene-item.sel')?.scrollIntoView({ block: 'nearest' }) }, [cur])
  if (!lib) return <div className="scene-panel-empty">{t('scene.noProject')}</div>
  return <div className="scene-moments">
    <div className="scene-legend">
      {lib.families.map(f => <span key={f.label}><i style={{ background: f.color }} />{f.label}</span>)}
      <span><b className="scene-kinds"><span className="h"><HapticIcon /></span></b> {t('scene.legend.haptics')}</span>
      <span><b className="scene-kinds"><span className="s">♪</span></b> {t('scene.legend.sound')}</span>
    </div>
    <div ref={list}>
      {items.map((it, k) => {
        const cues = it.kind === 'clip' && table ? it.names.map(n => table.cues[n]).filter(Boolean) : []
        return <div key={k} className={`scene-item ${k === cur ? 'sel' : ''}`} onClick={() => useSceneStore.getState().select(k)}>
          <span className="scene-num">{k === 0 ? '▶' : String(k).padStart(2, '0')}</span>
          <span className="scene-dot" style={{ background: familyColor(lib, it.name) }} />
          <span className="scene-name">{it.kind === 'full' ? t('scene.full') : <>{it.names.join(' + ')}<small>{it.hand}</small></>}</span>
          <span className="scene-kinds">{cues.length > 0 && <><span className="h">{cues.some(c => c.haptics.length) ? <HapticIcon /> : null}</span><span className="s">{cues.some(c => c.sfx) ? '♪' : ''}</span></>}</span>
          <span className="scene-num">{it.kind === 'full' ? '' : `${it.at.toFixed(1)}s`}</span>
        </div>
      })}
    </div>
  </div>
}
