import { useEditorSettings } from '@/stores/editorSettings'
import { useI18n } from '@/i18n/I18nProvider'
import { roleBadge } from '@/utils/roleLabels'
import { useEditor } from './editorContext'

/**
 * Playback output: haptic send targets (connected playback devices only —
 * the same rule Kit deploy uses) and PC audio.
 */
export function OutputPanel() {
  const { t } = useI18n()
  const { isConnected, playbackDevices, targets } = useEditor()
  const selected = useEditorSettings(s => s.targets)
  const muted = useEditorSettings(s => s.muted)
  const update = useEditorSettings(s => s.update)
  const choose = (ip: string, on: boolean) => {
    const current = selected ?? playbackDevices.map(device => device.ipAddress)
    update({ targets: on ? [...new Set([...current, ip])] : current.filter(item => item !== ip) })
  }
  return <div className="editor-panel editor-output">
    <section className="editor-output-section">
      <div className="editor-output-heading">
        <strong>{t('editor.hapticTargets')}</strong>
        <span className="editor-target-status" role="status">{isConnected ? t('editor.targetCountLabel', { count: targets.length }) : t('editor.helperDisconnected')}</span>
        <button className="toolbar-btn" disabled={!isConnected} onClick={() => update({ targets: null })}>{t('editor.allTargets')}</button>
        <button className="toolbar-btn" disabled={!isConnected} onClick={() => update({ targets: [] })}>{t('editor.noTargets')}</button>
      </div>
      {isConnected && !playbackDevices.length && <p className="editor-muted">{t('editor.noConnectedDevices')}</p>}
      <ul className="editor-target-list">
        {playbackDevices.map(device => <li key={device.ipAddress}>
          <label className="editor-target-row" title={device.ipAddress}>
            <input type="checkbox" checked={selected === null || selected.includes(device.ipAddress)} onChange={e => choose(device.ipAddress, e.target.checked)} />
            <span className="device-conn-dot online" aria-hidden="true" />
            <span className="editor-target-name">{device.name || '(unnamed)'}</span>
            <span className={`device-row-roletag ${device.role ?? 'receiver'}`}>{roleBadge(device.role ?? 'receiver')}</span>
            <span className="editor-target-ip">{device.ipAddress}</span>
          </label>
        </li>)}
      </ul>
    </section>
    <section className="editor-output-section">
      <label className="editor-checkbox"><input type="checkbox" checked={!muted} onChange={e => update({ muted: !e.target.checked })} />{t('editor.sound')}</label>
    </section>
  </div>
}
