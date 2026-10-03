import { useEffect, useRef, useState } from 'react'
import type { DockviewApi } from 'dockview-react'
import { useWaveformStore } from '@/stores/waveformStore'
import { editorUiSettings, useEditorSettings } from '@/stores/editorSettings'
import { useI18n } from '@/i18n/I18nProvider'
import { parseUiSettingsFile, serializeUiSettings } from '@/utils/editorUiSettings'
import { EditorMenu, EditorMenuItem, EditorMenuSection } from './EditorMenu'
import { EDITOR_PANELS, PANEL_TITLES, togglePanel } from './EditorDockLayout'
import { useEditor } from './editorContext'

/** Editor header: folder · import · export, plus the View and "…" menus. Everything else lives in panels. */
export function EditorTopBar({ dockApi, onNotice }: { dockApi: DockviewApi | null; onNotice: (message: string) => void }) {
  const { t } = useI18n()
  const s = useWaveformStore()
  const { openRecipe } = useEditor()
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
  const exportClip = () => { void s.exportWav().then(name => onNotice(t('editor.exported', { file: `exports/${name}` }))).catch(s.setError) }
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
    <button className="toolbar-btn" title={`${t('editor.exportTarget')} · ${t('editor.exportHint')}`} disabled={!s.clip || !s.folder || s.isProcessing} onClick={exportClip}>{t('editor.export')}</button>
    <span className={`editor-save-state ${s.saveStatus}`} role="status">{t(`editor.save.${s.saveStatus}`)}</span>
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
