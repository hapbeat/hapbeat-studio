import { useEffect, useRef } from 'react'
import { sceneUiSettings, useSceneSettings } from '@/stores/sceneSettings'
import { resolveSceneUi, SCENE_UI_STORAGE_KEY, serializeSceneUi } from '@/utils/sceneUiSettings'
import { keepSceneUiSettingsCopy, readSceneUiSettings, writeSceneUiSettings } from '@/utils/sceneProject'
import type { SettingsSyncNotice } from './useEditorSettingsFolderSync'

const message = (error: unknown) => error instanceof Error ? error.message : String(error)

/**
 * Mirrors the Scene tab UI settings into `Saved/HapticViewer/studio-scene-ui.json`
 * of the open project (same rules as the editor's folder copy: the project copy
 * wins when valid, otherwise the current settings are written there; later
 * changes are written debounced; an unreadable copy is kept under a new name).
 */
export function useSceneSettingsFolderSync(root: FileSystemDirectoryHandle | null, onNotice: (notice: SettingsSyncNotice) => void) {
  const noticeRef = useRef(onNotice); noticeRef.current = onNotice
  useEffect(() => {
    if (!root) return
    let cancelled = false, ready = false, lastWritten = ''
    let timer: ReturnType<typeof setTimeout> | undefined
    const current = () => serializeSceneUi(sceneUiSettings(useSceneSettings.getState()))
    const write = () => {
      timer = undefined
      const text = current()
      if (text === lastWritten) return
      lastWritten = text
      void writeSceneUiSettings(root, text).catch(error => { lastWritten = ''; noticeRef.current({ kind: 'failed', error: message(error) }) })
    }
    void (async () => {
      try {
        const folderText = await readSceneUiSettings(root)
        if (cancelled) return
        let localText: string | null = null
        try { localText = localStorage.getItem(SCENE_UI_STORAGE_KEY) } catch { /* storage may be unavailable */ }
        const resolved = resolveSceneUi(folderText, localText)
        if (resolved.source === 'folder') { useSceneSettings.getState().replace(resolved.settings); lastWritten = current() }
        else if (resolved.folderMalformed !== undefined && folderText !== null) {
          const keptAs = await keepSceneUiSettingsCopy(root, folderText)
          noticeRef.current({ kind: 'unreadable', error: resolved.folderMalformed, keptAs })
        }
        if (cancelled) return
        ready = true
        write()
      } catch (error) { if (!cancelled) noticeRef.current({ kind: 'failed', error: message(error) }) }
    })()
    const unsubscribe = useSceneSettings.subscribe(() => {
      if (!ready) return
      clearTimeout(timer)
      timer = setTimeout(write, 700)
    })
    return () => {
      cancelled = true
      unsubscribe()
      if (timer !== undefined) { clearTimeout(timer); write() }
    }
  }, [root])
}
