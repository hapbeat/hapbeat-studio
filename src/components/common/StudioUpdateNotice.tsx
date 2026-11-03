import { useStudioUpdate } from '@/hooks/useStudioUpdate'
import { useI18n } from '@/i18n/I18nProvider'
import './StudioUpdateNotice.css'

/**
 * Bottom-right notice when a newer Studio has been deployed while this page is open.
 * It floats over the page (nothing moves when it appears) and stays until the user
 * reloads or closes it; a reload asks first when there are unsaved edits.
 */
export function StudioUpdateNotice() {
  const { t } = useI18n()
  const { available, reload, dismiss } = useStudioUpdate()
  if (!available) return null
  return (
    <div className="studio-update-notice" role="status">
      <span className="studio-update-notice-text">{t('update.studio.available')}</span>
      <button type="button" className="studio-update-notice-reload" onClick={reload}>
        {t('update.studio.reload')}
      </button>
      <button
        type="button"
        className="studio-update-notice-close"
        onClick={dismiss}
        aria-label={t('common.close')}
        title={t('common.close')}
      >
        ×
      </button>
    </div>
  )
}
