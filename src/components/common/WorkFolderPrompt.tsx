import { useState, type ReactNode } from 'react'
import { useLibraryStore } from '@/stores/libraryStore'
import { useI18n } from '@/i18n/I18nProvider'
import { useToast } from '@/components/common/Toast'
import './WorkFolderPrompt.css'

/**
 * First-run guide for the Kit work folder, shown where the clips will appear
 * (the Clips list of the Kit tab). Only the Kit tab needs this folder: the
 * editor and the scene have folders of their own, and the UI / Manage tabs
 * need none, so it is not shown app-wide. It uses the yellow "attention"
 * colours (App.css) so it is not missed on a dark page.
 *
 * Renders nothing once a folder is connected, while the startup lookup is
 * still running, and in demo mode.
 */
export function WorkFolderPrompt() {
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
        <button type="button" className="work-folder-btn attention-btn" onClick={reconnect} disabled={busy}>
          {t('workFolder.reconnect.button', { name: pendingName })}
        </button>
        <button type="button" className="work-folder-btn secondary" onClick={choose} disabled={busy}>
          {t('workFolder.chooseOther')}
        </button>
      </>
    )
  } else {
    title = t('workFolder.none.title')
    body = t('workFolder.panelHint')
    actions = (
      <button type="button" className="work-folder-btn attention-btn" onClick={choose} disabled={busy}>
        {t('workFolder.choose')}
      </button>
    )
  }

  return (
    <section className={`work-folder-prompt ${status === 'unsupported' ? 'work-folder-prompt--unsupported' : 'attention-box'}`}>
      <span className="work-folder-icon" aria-hidden="true">{status === 'unsupported' ? '⚠' : '📂'}</span>
      <div className="work-folder-text">
        <strong className="work-folder-title">{title}</strong>
        <span className="work-folder-body">{body}</span>
      </div>
      {actions && <div className="work-folder-actions">{actions}</div>}
    </section>
  )
}
