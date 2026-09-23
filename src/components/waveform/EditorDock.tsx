import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useEditorSettings } from '@/stores/editorSettings'
import { useI18n } from '@/i18n/I18nProvider'
import { handlePlaybackShortcut } from '@/utils/playbackShortcut'
export function EditorDock({children, active}: {children: ReactNode; active: boolean}) {
  const {t} = useI18n()
  const settings = useEditorSettings()
  const [popup, setPopup] = useState<Window | null>(null)
  const [blocked, setBlocked] = useState(false)
  const popupRef = useRef<Window | null>(null)
  const activeRef = useRef(active); activeRef.current = active
  const close = () => {popupRef.current?.close(); popupRef.current = null; setPopup(null)}
  useEffect(() => () => {popupRef.current?.close()}, [])
  useEffect(() => {
    if (!popup) return
    const syncStyles = () => {
      popup.document.head.replaceChildren(...Array.from(document.head.querySelectorAll('style, link[rel="stylesheet"]')).map(node => node.cloneNode(true)))
      popup.document.title = 'Hapbeat Studio — Editor'
      popup.document.documentElement.className = document.documentElement.className
      popup.document.documentElement.style.cssText = document.documentElement.style.cssText
      popup.document.body.className = `${document.body.className} editor-popup-body`
    }
    syncStyles()
    const observer = new MutationObserver(syncStyles)
    observer.observe(document.head, {childList: true, subtree: true, characterData: true})
    observer.observe(document.documentElement, {attributes: true, attributeFilter: ['class', 'style']})
    const saveSize = () => useEditorSettings.getState().update({popupWidth: popup.innerWidth, popupHeight: popup.innerHeight})
    const unloaded = () => {saveSize(); popupRef.current = null; setPopup(null)}
    const key = (event: KeyboardEvent) => {if (activeRef.current) handlePlaybackShortcut(event, 'editor', e => window.dispatchEvent(e))}
    const parentClosed = () => popup.close()
    window.addEventListener('pagehide', parentClosed)
    popup.addEventListener('beforeunload', unloaded); popup.addEventListener('resize', saveSize); popup.addEventListener('keydown', key, true)
    return () => {window.removeEventListener('pagehide', parentClosed); observer.disconnect(); popup.removeEventListener('beforeunload', unloaded); popup.removeEventListener('resize', saveSize); popup.removeEventListener('keydown', key, true)}
  }, [popup])
  const open = () => {
    const next = window.open('', '', `popup,width=${settings.popupWidth},height=${settings.popupHeight}`)
    if (!next) {setBlocked(true); return}
    setBlocked(false); popupRef.current = next; setPopup(next)
  }
  return <div className="editor-dock">
    <div className="editor-dock-controls">
      <button className="toolbar-btn" onClick={() => popup ? close() : open()}>{popup ? t('editor.dockBack') : t('editor.popout')}</button>
      <button className="toolbar-btn" aria-pressed={settings.layout === 'right'} onClick={() => settings.update({layout: settings.layout === 'right' ? 'bottom' : 'right'})}>{t('editor.sideLayout')}</button>
      <span role="status">{blocked ? t('editor.popupBlocked') : popup ? t('editor.popupActive') : ''}</span>
    </div>
    {popup ? createPortal(<div className="waveform-editor editor-popout"><button className="toolbar-btn" onClick={close}>{t('editor.dockBack')}</button>{children}</div>, popup.document.body) : children}
  </div>
}
