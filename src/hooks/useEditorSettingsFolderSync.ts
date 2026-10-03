import { useEffect, useRef } from 'react'
import type { EditorFolder } from '@/utils/editorFolder'
import { editorUiSettings, useEditorSettings } from '@/stores/editorSettings'
import { resolveUiSettings, serializeUiSettings, UI_SETTINGS_STORAGE_KEY } from '@/utils/editorUiSettings'

export type SettingsSyncNotice =
  | { kind: 'unreadable'; error: string; keptAs: string }
  | { kind: 'failed'; error: string }

const message = (error: unknown) => error instanceof Error ? error.message : String(error)

/**
 * Mirrors the editor UI settings into `.hapbeat-editor/ui-settings.json` of the
 * open folder. On open the folder copy wins when valid; otherwise the current
 * (localStorage / default) settings are written there. Later changes are
 * written debounced. An unreadable folder copy is kept under a new name first.
 */
export function useEditorSettingsFolderSync(folder: EditorFolder | null, onNotice: (notice: SettingsSyncNotice) => void) {
  const noticeRef = useRef(onNotice); noticeRef.current = onNotice
  useEffect(() => {
    if (!folder) return
    let cancelled = false, ready = false, lastWritten = ''
    let timer: ReturnType<typeof setTimeout> | undefined
    const current = () => serializeUiSettings(editorUiSettings(useEditorSettings.getState()))
    const write = () => {
      timer = undefined
      const text = current()
      if (text === lastWritten) return
      lastWritten = text
      void folder.writeUiSettings(text).catch(error => { lastWritten = ''; noticeRef.current({ kind: 'failed', error: message(error) }) })
    }
    void (async () => {
      try {
        const folderText = await folder.readUiSettings()
        if (cancelled) return
        let localText: string | null = null
        try { localText = localStorage.getItem(UI_SETTINGS_STORAGE_KEY) } catch { /* storage may be unavailable */ }
        const resolved = resolveUiSettings(folderText, localText)
        if (resolved.source === 'folder') { useEditorSettings.getState().replace(resolved.settings); lastWritten = current() }
        else if (resolved.folderMalformed !== undefined && folderText !== null) {
          const keptAs = await folder.keepUiSettingsCopy(folderText)
          noticeRef.current({ kind: 'unreadable', error: resolved.folderMalformed, keptAs })
        }
        if (cancelled) return
        ready = true
        write()
      } catch (error) { if (!cancelled) noticeRef.current({ kind: 'failed', error: message(error) }) }
    })()
    const unsubscribe = useEditorSettings.subscribe(() => {
      if (!ready) return
      clearTimeout(timer)
      timer = setTimeout(write, 700)
    })
    return () => {
      cancelled = true
      unsubscribe()
      if (timer !== undefined) { clearTimeout(timer); write() }
    }
  }, [folder])
}
