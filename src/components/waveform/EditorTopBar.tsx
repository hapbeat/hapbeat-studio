import { useEffect, useRef, useState } from 'react'
import type { DockviewApi } from 'dockview-react'
import { useWaveformStore } from '@/stores/waveformStore'
import { devicePosition } from '@/utils/playbackDevices'
import { DevicePill } from '@/components/devices/DevicePill'
import type { SampleRate } from '@/types/waveform'
import { editorUiSettings, useEditorSettings } from '@/stores/editorSettings'
import { useI18n, type MessageId } from '@/i18n/I18nProvider'
import { parseUiSettingsFile, serializeUiSettings } from '@/utils/editorUiSettings'
import { EditorMenu, EditorMenuItem, EditorMenuSection } from './EditorMenu'
import { EDITOR_PANELS, PANEL_TITLES, togglePanel } from './EditorDockLayout'
import { useEditor } from './editorContext'

/** Editor header: folder · import · export, plus the View and "…" menus. Everything else lives in panels. */
export function EditorTopBar({ dockApi, notice, onNotice }: { dockApi: DockviewApi | null; notice: string | null; onNotice: (message: string) => void }) {
  const { t } = useI18n()
  const s = useWaveformStore()
  const { openRecipe } = useEditor()
  const muted = useEditorSettings(state => state.muted)
  const hapticOnPc = useEditorSettings(state => state.hapticOnPc)
  const sendHaptics = useEditorSettings(state => state.sendHaptics)
  const audioInput = useRef<HTMLInputElement>(null)
  const settingsInput = useRef<HTMLInputElement>(null)
  const [openPanels, setOpenPanels] = useState<string[]>([])
  useEffect(() => {
    if (!dockApi) return
    const sync = () => setOpenPanels(dockApi.panels.map(panel => panel.id))
    sync()
    const subscription = dockApi.onDidLayoutChange(sync)
    return () => subscription.dispose()
  }, [dockApi])
  const folderName = s.folder?.root.name ?? s.rememberedFolder?.name
  const exportClip = () => {
    onNotice(t('editor.exporting', { folder: 'exports/' }))
    void s.exportWav().then(name => {
      // Success is not announced (logged); failures are.
      console.info('[editor] exported', `exports/${name}`); onNotice('')
    }).catch(s.setError)
  }
  const exportSettings = () => {
    const url = URL.createObjectURL(new Blob([serializeUiSettings(editorUiSettings(useEditorSettings.getState()))], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url; link.download = 'hapbeat-editor-ui-settings.json'
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const importSettings = async (file: File) => {
    const parsed = parseUiSettingsFile(await file.text())
    if (!parsed.ok) { onNotice(t('editor.settings.importFailed', { error: parsed.error })); return }
    useEditorSettings.getState().replace(parsed.settings)
    onNotice(t('editor.settings.imported', { file: file.name }))
  }
  return <div className="editor-folder-bar">
    <span className="editor-beta-label" title={t('editor.betaHint')}>BETA</span>
    <button className="toolbar-btn" onClick={() => void s.openFolder()} disabled={s.isProcessing || !('showDirectoryPicker' in window)}>▱ {t('editor.folder')}</button>
    <div className="editor-folder-name" title={t('editor.pathHint')}><strong>{folderName ? `${folderName}/` : t('editor.chooseFirst')}</strong></div>
    {!s.folder && s.rememberedFolder && <button className="toolbar-btn" disabled={s.isProcessing} onClick={() => void s.reconnectFolder()}>{t('editor.reconnect')}</button>}
    <input ref={audioInput} type="file" multiple accept="audio/*,.wav,.mp3,.ogg,.flac,.aac,.m4a" hidden onChange={e => { void s.loadFiles(Array.from(e.target.files ?? [])); e.target.value = '' }} />
    <input ref={settingsInput} type="file" accept="application/json,.json" hidden onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void importSettings(file) }} />
    <EditorMenu label={`${t('editor.importMenu')} ▾`} disabled={!s.folder || s.isProcessing}>
      <EditorMenuItem onSelect={() => audioInput.current?.click()}>{t('editor.import')}</EditorMenuItem>
      <EditorMenuItem onSelect={doc => openRecipe(doc)}>{t('editor.recipe.create')}</EditorMenuItem>
    </EditorMenu>
    <EditorMenu label={`${t('editor.exportMenu')} ▾`} disabled={!s.clip || !s.folder || s.isProcessing}>
      <EditorMenuSection label={t('editor.exportFormat')}>
        <div className="editor-menu-fields">
          <select aria-label={t('editor.exportFormat')} value={s.clip?.exportSampleRate ?? 48000} onChange={e => s.setExportSampleRate(Number(e.target.value) as SampleRate)}>
            <option value={16000}>16 kHz</option><option value={24000}>24 kHz</option><option value={44100}>44.1 kHz</option><option value={48000}>48 kHz</option>
          </select>
          <label className="editor-checkbox"><input type="checkbox" checked={s.exportAsMono} onChange={e => s.setExportAsMono(e.target.checked)} />Mono</label>
        </div>
      </EditorMenuSection>
      <EditorMenuItem onSelect={exportClip}>{t('editor.export')}</EditorMenuItem>
      <p className="editor-menu-note">{t('editor.exportTarget')}<br />{t('editor.exportHint')}</p>
    </EditorMenu>
    <span className={`editor-save-state ${s.saveStatus}`} role="status">{t(`editor.save.${s.saveStatus}`)}</span>
    <span className={`editor-bar-notice ${s.error ? 'error' : ''}`} role="status" title={notice ?? undefined}>{notice ?? ''}</span>
    <DevicePill selectionScope="kit" showWhenDisconnected modalExtra={<div className="editor-output-options">
      <label><input type="checkbox" checked={sendHaptics} onChange={e => useEditorSettings.getState().update({ sendHaptics: e.target.checked })} />{t('editor.sendHaptics')}</label>
      <label><input type="checkbox" checked={!muted} onChange={e => useEditorSettings.getState().update({ muted: !e.target.checked })} />{t('editor.sound')}</label>
      <label title={t('editor.hapticOnPcHint')}><input type="checkbox" checked={hapticOnPc} onChange={e => useEditorSettings.getState().update({ hapticOnPc: e.target.checked })} />{t('editor.hapticOnPc')}</label>
    </div>} />
    <RoutingLine />
    <EditorMenu label={`${t('editor.viewMenu')} ▾`} disabled={!dockApi}>
      <EditorMenuSection label={t('editor.viewPanels')}>
        {EDITOR_PANELS.map(id => <EditorMenuItem key={id} keepOpen checked={openPanels.includes(id)} onSelect={() => dockApi && togglePanel(dockApi, id, t)}>{t(PANEL_TITLES[id])}</EditorMenuItem>)}
      </EditorMenuSection>
      <EditorMenuItem onSelect={() => useEditorSettings.getState().replace({ ...editorUiSettings(useEditorSettings.getState()), dockLayout: null })}>{t('editor.resetLayout')}</EditorMenuItem>
    </EditorMenu>
    <EditorMenu label="⋯" title={t('editor.moreMenu')}>
      <EditorMenuItem disabled={!s.folder || s.isProcessing || s.saveStatus === 'saving'} onSelect={() => void s.save().catch(() => {})}>{t('editor.saveNow')}</EditorMenuItem>
      <EditorMenuSection label={t('editor.settings.heading')}>
        <EditorMenuItem onSelect={exportSettings}>{t('editor.settings.export')}</EditorMenuItem>
        <EditorMenuItem onSelect={() => settingsInput.current?.click()}>{t('editor.settings.import')}</EditorMenuItem>
      </EditorMenuSection>
    </EditorMenu>
  </div>
}

/** Where auditions go now, in one line next to the output options ("Neck: DuoWL-1 / Both wrists: BandWL ×2"). */
function RoutingLine() {
  const { t } = useI18n()
  const { routing, isConnected } = useEditor()
  const sendHaptics = useEditorSettings(state => state.sendHaptics)
  if (!isConnected || !sendHaptics) return null
  const label = (pos: string) => t(`position.${pos}` as MessageId)
  const byPos = new Map<string, string[]>()
  for (const d of routing.devices) { const p = devicePosition(d.address) ?? ''; byPos.set(p, [...(byPos.get(p) ?? []), d.name || d.ipAddress]) }
  const l = byPos.get('pos_l_wrist'), r = byPos.get('pos_r_wrist')
  const parts: string[] = []
  if (l && r) { parts.push(`${t('position.bothWrists')}: ${[...l, ...r].join(', ')}`); byPos.delete('pos_l_wrist'); byPos.delete('pos_r_wrist') }
  for (const [pos, names] of byPos) parts.push(`${pos ? label(pos) : t('position.unknown')}: ${names.join(', ')}`)
  const text = routing.positions && !routing.devices.length
    ? t('editor.routing.none', { positions: routing.positions.map(label).join(', ') })
    : `${t('editor.routing.to')} ${parts.join(' / ') || '—'}`
  const unknown = routing.positions && routing.unknown.length ? t('editor.routing.unknown', { count: routing.unknown.length, names: routing.unknown.map(d => d.name || d.ipAddress).join(', ') }) : ''
  return <span className={`editor-routing ${routing.positions && !routing.devices.length ? 'empty' : ''}`} role="status" title={[t('editor.routing.hint'), unknown].filter(Boolean).join('\n')}>
    {text}{unknown ? ` · ${t('editor.routing.unknownShort', { count: routing.unknown.length })}` : ''}</span>
}
