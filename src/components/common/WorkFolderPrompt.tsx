import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useLibraryStore } from '@/stores/libraryStore'
import { useI18n } from '@/i18n/I18nProvider'
import { useToast } from '@/components/common/Toast'
import './WorkFolderPrompt.css'

/**
 * Work folder guide. Nothing in the Kit tab shows clips until a folder is
 * chosen, so the Kit tab opens this as a centred modal (`modal`, dismissible
 * with "Later" because the other tabs work without a folder) and the Clips
 * list shows the same prompt in place (`panel`) once the modal is dismissed.
 *
 * Renders nothing once a folder is connected, while the startup lookup is
 * still running, and in demo mode.
 */
export function WorkFolderPrompt({ variant, onDismiss }: {
  variant: 'modal' | 'panel'
  /** `modal` only: hide the modal for now ("Later" / Escape / backdrop). */
  onDismiss?: () => void
}) {
  const { t } = useI18n()
  const { toast } = useToast()
  const status = useLibraryStore((s) => s.workDirStatus)
  const pendingName = useLibraryStore((s) => s.workDirPendingName)
  const demoMode = useLibraryStore((s) => s.demoMode)
  const pickWorkDir = useLibraryStore((s) => s.pickWorkDir)
  const reconnectWorkDir = useLibraryStore((s) => s.reconnectWorkDir)
  const [busy, setBusy] = useState(false)
  const hidden = demoMode || status === 'checking' || status === 'connected'

  useEffect(() => {
    if (variant !== 'modal' || hidden || busy || !onDismiss) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onDismiss() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [variant, hidden, busy, onDismiss])

  if (hidden) return null

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
    body = t(variant === 'panel' ? 'workFolder.panelHint' : 'workFolder.none.body')
    actions = (
      <button type="button" className="work-folder-btn primary" onClick={choose} disabled={busy}>
        {busy ? t('workFolder.busy') : t('workFolder.choose')}
      </button>
    )
  }

  const content = (
    <>
      <span className="work-folder-icon" aria-hidden="true">{status === 'unsupported' ? '⚠' : '📂'}</span>
      <div className="work-folder-text">
        <strong className="work-folder-title">{title}</strong>
        <span className="work-folder-body">{body}</span>
      </div>
      {actions && <div className="work-folder-actions">{actions}</div>}
    </>
  )

  if (variant === 'panel') {
    return <section className="work-folder-prompt work-folder-prompt--panel">{content}</section>
  }

  return createPortal(
    <div className="work-folder-backdrop" onClick={busy ? undefined : onDismiss}>
      <section
        className={`work-folder-prompt work-folder-prompt--modal${status === 'unsupported' ? ' work-folder-prompt--unsupported' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        {content}
        {onDismiss && (
          <button type="button" className="work-folder-later" onClick={onDismiss} disabled={busy}>
            {status === 'unsupported' ? t('common.close') : t('workFolder.later')}
          </button>
        )}
      </section>
    </div>,
    document.body,
  )
}
