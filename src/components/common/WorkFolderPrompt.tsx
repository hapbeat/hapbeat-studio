import { useLayoutEffect, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useLibraryStore } from '@/stores/libraryStore'
import { useI18n } from '@/i18n/I18nProvider'
import { useToast } from '@/components/common/Toast'
import './WorkFolderPrompt.css'

/**
 * Work folder modal for the Kit tab. Nothing in the Kit tab works until a
 * folder is chosen, so it covers the tab area (`areaRef`, the element below
 * the header) with a centred prompt. The header is left uncovered so the user
 * can still switch to a tab that needs no folder — hence no "Later" button.
 *
 * Renders nothing once a folder is connected, while the startup lookup is
 * still running, and in demo mode.
 */
export function WorkFolderPrompt({ areaRef }: { areaRef: RefObject<HTMLElement | null> }) {
  const { t } = useI18n()
  const { toast } = useToast()
  const status = useLibraryStore((s) => s.workDirStatus)
  const pendingName = useLibraryStore((s) => s.workDirPendingName)
  const demoMode = useLibraryStore((s) => s.demoMode)
  const pickWorkDir = useLibraryStore((s) => s.pickWorkDir)
  const reconnectWorkDir = useLibraryStore((s) => s.reconnectWorkDir)
  const [busy, setBusy] = useState(false)
  const [top, setTop] = useState<number | null>(null)
  const hidden = demoMode || status === 'checking' || status === 'connected'

  // Follow the tab area's top edge: the header can be folded away or wrap.
  useLayoutEffect(() => {
    const area = areaRef.current
    if (hidden || !area) return
    const update = () => setTop(Math.max(0, area.getBoundingClientRect().top))
    update()
    const observer = new ResizeObserver(update)
    observer.observe(area)
    window.addEventListener('resize', update)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [hidden, areaRef])

  if (hidden || top === null) return null

  const run = async (action: () => Promise<boolean>, failure: () => string | null) => {
    if (busy) return
    setBusy(true)
    try {
      if (!(await action())) {
        const message = failure()
        if (message) toast(message, 'error')
      }
    } catch (err) {
      toast(t('workFolder.pick.failed', { detail: err instanceof Error ? err.message : String(err) }), 'error')
    } finally {
      setBusy(false)
    }
  }
  // Cancelling the folder dialog is not an error.
  const choose = () => run(pickWorkDir, () => null)
  const reconnect = () => run(reconnectWorkDir, () => t('workFolder.reconnect.failed'))

  let title: string
  let body: string
  let actions: ReactNode
  if (status === 'unsupported') {
    title = t('workFolder.unsupported.title')
    body = t('workFolder.unsupported.body')
    actions = null
  } else if (status === 'needs-permission' && pendingName) {
    title = t('workFolder.reconnect.title')
    body = t('workFolder.reconnect.body', { name: pendingName })
    actions = (
      <>
        <button type="button" className="work-folder-btn primary" onClick={reconnect} disabled={busy}>
          {busy ? t('workFolder.busy') : t('workFolder.reconnect.button', { name: pendingName })}
        </button>
        <button type="button" className="work-folder-btn secondary" onClick={choose} disabled={busy}>
          {t('workFolder.chooseOther')}
        </button>
      </>
    )
  } else {
    title = t('workFolder.none.title')
    body = t('workFolder.none.body')
    actions = (
      <button type="button" className="work-folder-btn primary" onClick={choose} disabled={busy}>
        {busy ? t('workFolder.busy') : t('workFolder.choose')}
      </button>
    )
  }

  return createPortal(
    <div className="work-folder-backdrop" style={{ top }}>
      <section
        className={`work-folder-prompt${status === 'unsupported' ? ' work-folder-prompt--unsupported' : ''}`}
        role="dialog"
        aria-label={title}
      >
        <span className="work-folder-icon" aria-hidden="true">{status === 'unsupported' ? '⚠' : '📂'}</span>
        <div className="work-folder-text">
          <strong className="work-folder-title">{title}</strong>
          <span className="work-folder-body">{body}</span>
        </div>
        {actions && <div className="work-folder-actions">{actions}</div>}
      </section>
    </div>,
    document.body,
  )
}
