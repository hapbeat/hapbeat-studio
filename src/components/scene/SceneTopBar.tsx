import { useEffect, useRef, useState } from 'react'
import type { DockviewApi } from 'dockview-react'
import { useI18n } from '@/i18n/I18nProvider'
import { DevicePill } from '@/components/devices/DevicePill'
import { EditorMenu, EditorMenuItem, EditorMenuSection } from '@/components/waveform/EditorMenu'
import { useSceneStore } from '@/stores/sceneStore'
import { sceneUiSettings, useSceneSettings } from '@/stores/sceneSettings'
import { parseSceneUiFile, serializeSceneUi } from '@/utils/sceneUiSettings'
import { SCENE_PANELS, SCENE_PANEL_TITLES, toggleScenePanel } from './SceneDockLayout'
import { useScene } from './sceneContext'
import { useSceneProjectActions } from './useSceneProjectActions'

/** Scene header: project ▾ · save, the shared device pill, View and "…" menus. Everything else lives in panels. */
export function SceneTopBar({ dockApi, notice }: { dockApi: DockviewApi | null; notice: { text: string; error: boolean } | null }) {
  const { t } = useI18n()
  const { confirmDiscard } = useScene()
  const { open, reopen, rememberedName, busy } = useSceneProjectActions()
  const root = useSceneStore(s => s.root)
  const lib = useSceneStore(s => s.lib)
  const dirty = useSceneStore(s => s.dirty)
  const sendHaptics = useSceneSettings(s => s.sendHaptics)
  const pcSound = useSceneSettings(s => s.pcSound)
  const settingsInput = useRef<HTMLInputElement>(null)
  const [openPanels, setOpenPanels] = useState<string[]>([])
  useEffect(() => {
    if (!dockApi) return
    const sync = () => setOpenPanels(dockApi.panels.map(panel => panel.id))
    sync()
    const subscription = dockApi.onDidLayoutChange(sync)
    return () => subscription.dispose()
  }, [dockApi])
  const exportSettings = () => {
    const url = URL.createObjectURL(new Blob([serializeSceneUi(sceneUiSettings(useSceneSettings.getState()))], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url; link.download = 'hapbeat-scene-ui-settings.json'
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const importSettings = async (file: File) => {
    const parsed = parseSceneUiFile(await file.text())
    if (!parsed.ok) { useSceneStore.getState().note({ id: 'editor.settings.importFailed', params: { error: parsed.error }, error: true }); return }
    useSceneSettings.getState().replace(parsed.settings)
    useSceneStore.getState().note({ id: 'editor.settings.imported', params: { file: file.name } })
  }
  const revert = async () => { if (dirty && !await confirmDiscard()) return; await useSceneStore.getState().revert() }
  return <div className="editor-folder-bar scene-bar">
    <span className="editor-beta-label" title={t('scene.betaHint')}>BETA</span>
    <EditorMenu label={`${t('scene.projectMenu')} ▾`} disabled={busy}>
      <EditorMenuItem disabled={!('showDirectoryPicker' in window)} onSelect={() => void open()}>{t('scene.open')}</EditorMenuItem>
      <EditorMenuItem disabled={!rememberedName} onSelect={() => void reopen()}>{rememberedName ? t('scene.reopenNamed', { name: rememberedName }) : t('scene.reopen')}</EditorMenuItem>
    </EditorMenu>
    <div className="editor-folder-name" title={root ? t('scene.projectTitle', { title: lib?.title ?? '', folder: root.name }) : undefined}>
      <strong>{root ? `${lib?.title ?? root.name} · ${root.name}/` : t('scene.noProject')}</strong>
    </div>
    <button type="button" className="toolbar-btn primary scene-save" disabled={!root || busy} title={t('scene.saveTitle')} onClick={e => { e.currentTarget.blur(); void useSceneStore.getState().save() }}>{t('scene.save')}</button>
    <span className="scene-stack scene-dirty" role="status"><span aria-hidden="true" className="scene-sizer">{t('scene.dirty')}</span><span>{dirty ? t('scene.dirty') : ''}</span></span>
    <span className={`editor-bar-notice ${notice?.error ? 'error' : ''}`} role="status" title={notice?.text}>{notice?.text ?? ''}</span>
    <DevicePill selectionScope="kit" showWhenDisconnected modalExtra={<div className="editor-output-options">
      <label><input type="checkbox" checked={sendHaptics} onChange={e => useSceneSettings.getState().update({ sendHaptics: e.target.checked })} />{t('scene.sendHaptics')}</label>
      <label><input type="checkbox" checked={pcSound} onChange={e => useSceneSettings.getState().update({ pcSound: e.target.checked })} />{t('scene.pcSound')}</label>
    </div>} />
    <EditorMenu label={`${t('editor.viewMenu')} ▾`} disabled={!dockApi}>
      <EditorMenuSection label={t('editor.viewPanels')}>
        {SCENE_PANELS.map(id => <EditorMenuItem key={id} keepOpen checked={openPanels.includes(id)} onSelect={() => dockApi && toggleScenePanel(dockApi, id, t)}>{t(SCENE_PANEL_TITLES[id])}</EditorMenuItem>)}
      </EditorMenuSection>
      <EditorMenuItem onSelect={() => useSceneSettings.getState().replace({ ...sceneUiSettings(useSceneSettings.getState()), dockLayout: null })}>{t('editor.resetLayout')}</EditorMenuItem>
    </EditorMenu>
    <input ref={settingsInput} type="file" accept="application/json,.json" hidden onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void importSettings(file) }} />
    <EditorMenu label="⋯" title={t('editor.moreMenu')}>
      <EditorMenuItem disabled={!root || !dirty || busy} onSelect={() => void revert()}>{t('scene.revert')}</EditorMenuItem>
      <EditorMenuSection label={t('scene.settings.heading')}>
        <EditorMenuItem onSelect={exportSettings}>{t('editor.settings.export')}</EditorMenuItem>
        <EditorMenuItem onSelect={() => settingsInput.current?.click()}>{t('editor.settings.import')}</EditorMenuItem>
      </EditorMenuSection>
    </EditorMenu>
  </div>
}
