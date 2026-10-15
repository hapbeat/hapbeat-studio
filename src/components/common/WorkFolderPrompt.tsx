import { useState, type ReactNode } from 'react'
import { useLibraryStore } from '@/stores/libraryStore'
import { useI18n } from '@/i18n/I18nProvider'
import { useToast } from '@/components/common/Toast'
import './WorkFolderPrompt.css'

/**
 * First-run guide for the work folder. Nothing in Studio shows clips until a
 * folder is chosen, and a small English hint inside the Kit tab was easy to
 * miss, so the app shows this on every tab (`banner`, under the header) and
 * again where the clips will appear (`panel`, in the Clips list).
 *
 * Renders nothing once a folder is connected, while the startup lookup is
 * still running, and in demo mode.
 */
export function WorkFolderPrompt({ variant, onConnected }: {
  variant: 'banner' | 'panel'
  /** Called after a folder is connected from this prompt (e.g. open the Kit tab). */
  onConnected?: () => void
}) {
  const { t } = useI18n()
  const { toast } = useToast()
  const status = useLibraryStore((s) => s.workDirStatus)
  const pendingName = useLibraryStore((s) => s.workDirPendingName)
  const demoMode = useLibraryStore((s) => s.demoMode)
  const pickWorkDir = useLibraryStore((s) => s.pickWorkDir)
  const reconnectWorkDir = useLibraryStore((s) => s.reconnectWorkDir)
  const [busy, setBusy] = useState(false)

  if (demoMode || status === 'checking' || status === 'connected') return null

  const run = async (action: () => Promise<boolean>, failure: () => string | null) => {
    if (busy) return
    setBusy(true)
    try {
      if (await action()) onConnected?.()
      else {
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
          {t('workFolder.reconnect.button', { name: pendingName })}
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
        {t('workFolder.choose')}
      </button>
    )
  }

  return (
    <section
      className={`work-folder-prompt work-folder-prompt--${variant}${status === 'unsupported' ? ' work-folder-prompt--unsupported' : ''}`}
      role={variant === 'banner' ? 'region' : undefined}
      aria-label={variant === 'banner' ? title : undefined}
    >
      <span className="work-folder-icon" aria-hidden="true">{status === 'unsupported' ? '⚠' : '📂'}</span>
      <div className="work-folder-text">
        <strong className="work-folder-title">{title}</strong>
        <span className="work-folder-body">{body}</span>
      </div>
      {actions && <div className="work-folder-actions">{actions}</div>}
    </section>
  )
}
