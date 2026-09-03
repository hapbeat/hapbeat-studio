import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ExternalLinkIcon } from './ExternalLinkIcon'
import { useI18n } from '@/i18n/I18nProvider'
import './HelperOnboardingModal.css'

type OsTab = 'mac' | 'win'

interface HelperOnboardingModalProps {
  open: boolean
  onClose: () => void
  onRetry: () => void
}

function detectOs(): OsTab {
  const ua = navigator.userAgent.toLowerCase()
  if (ua.includes('mac')) return 'mac'
  return 'win'
}

function CopyableCommand({ cmd }: { cmd: string }) {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(cmd)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      /* fallback: select text */
    }
  }

  return (
    <div className="helper-modal-cmd-row">
      <code className="helper-modal-code">{cmd}</code>
      <button
        type="button"
        className="helper-modal-copy-btn"
        onClick={handleCopy}
        title={t('helper.setup.copy')}
      >
        {copied ? t('common.copied') : t('common.copy')}
      </button>
    </div>
  )
}

export function HelperOnboardingModal({
  open,
  onClose,
  onRetry,
}: HelperOnboardingModalProps) {
  const { t } = useI18n()
  const [activeTab, setActiveTab] = useState<OsTab>(detectOs)
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <div className="helper-modal-backdrop" onClick={onClose}>
      <div
        className="helper-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t('helper.setup.aria')}
      >
        {/* Header */}
        <div className="helper-modal-header">
          <span className="helper-modal-title">
            <span className="helper-modal-dot disconnected" />
            {t('helper.setup.disconnected')}
          </span>
          <button
            ref={closeRef}
            type="button"
            className="helper-modal-close"
            onClick={onClose}
            aria-label={t('common.close')}
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="helper-modal-body">
          <p className="helper-modal-desc">
            {t('helper.setup.description')}
          </p>

          {/* Recommended: auto-start service */}
          <section className="helper-modal-section">
            <h3 className="helper-modal-section-title">
              {t('helper.setup.recommendedTitle')}
            </h3>
            <p className="helper-modal-section-desc">
              {t('helper.setup.recommendedDescription')}
            </p>

            {/* OS tabs */}
            <div className="helper-modal-tabs">
              {(['mac', 'win'] as OsTab[]).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  className={`helper-modal-tab ${activeTab === tab ? 'active' : ''}`}
                  onClick={() => setActiveTab(tab)}
                >
                  {tab === 'mac' ? 'Mac' : 'Windows'}
                </button>
              ))}
            </div>

            {activeTab === 'mac' && (
              <div className="helper-modal-tab-body">
                <CopyableCommand cmd="hapbeat-helper install-service" />
                <p className="helper-modal-hint">
                  {t('helper.setup.macHint')}<br />
                  <code>tail -f ~/Library/Logs/hapbeat-helper.log</code>
                </p>
              </div>
            )}

            {activeTab === 'win' && (
              <div className="helper-modal-tab-body">
                <CopyableCommand cmd="hapbeat-helper install-service" />
                <p className="helper-modal-hint">
                  {t('helper.setup.windowsHint')}
                </p>
              </div>
            )}
          </section>

          {/* Alternative: foreground */}
          <section className="helper-modal-section helper-modal-section--alt">
            <h3 className="helper-modal-section-title">
              {t('helper.setup.foregroundTitle')}
            </h3>
            <CopyableCommand cmd="hapbeat-helper start" />
            <p className="helper-modal-hint">
              {t('helper.setup.installHint')}{' '}
              <code>pipx install hapbeat-helper</code>
            </p>
          </section>
        </div>

        {/* Footer */}
        <div className="helper-modal-footer">
          <a
            className="helper-modal-link"
            href="https://devtools.hapbeat.com/helper/getting-started/"
            target="_blank"
            rel="noreferrer"
          >
            {t('helper.setup.docs')} <ExternalLinkIcon />
          </a>
          <button
            type="button"
            className="form-button-secondary"
            onClick={onRetry}
          >
            {t('helper.setup.retry')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
