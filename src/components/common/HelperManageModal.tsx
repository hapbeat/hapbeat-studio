import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { MIN_HELPER_VERSION, compareVersion, type HelperCompat } from '@/config/helperCompat'
import { useHelperConnection } from '@/hooks/useHelperConnection'
import { useReleaseProduct } from '@/hooks/useReleaseNotices'
import { VersionSwitcher } from './VersionSwitcher'
import { useI18n } from '@/i18n/I18nProvider'
import './HelperOnboardingModal.css'

interface HelperManageModalProps {
  open: boolean
  onClose: () => void
  helperVersion: string | null
  /** Optional — when omitted the modal hides the upgrade-required section.
   *  Treat absent as 'unknown' so older callers keep working. */
  helperCompat?: HelperCompat
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
      /* ignore */
    }
  }
  return (
    <div className="helper-modal-cmd-row">
      <code className="helper-modal-code">{cmd}</code>
      <button
        type="button"
        className="helper-modal-copy-btn"
        onClick={handleCopy}
        title={t('common.copy')}
      >
        {copied ? t('common.copied') : t('common.copy')}
      </button>
    </div>
  )
}

export function HelperManageModal({ open, onClose, helperVersion, helperCompat }: HelperManageModalProps) {
  const { t } = useI18n()
  const outdated = helperCompat === 'outdated'
  // 「新しい版がある」お知らせ。ここは**ユーザーが能動的に開いた画面**なので
  // dismiss 対象外で常時表示する (DEC-053 §5.2)。必須更新 (outdated) のときは
  // 上のセクションが同じ手順を出しているので重複させない。
  const helperRelease = useReleaseProduct('helper')
  const updateAvailable =
    !outdated &&
    !!helperVersion &&
    !!helperRelease?.latest &&
    compareVersion(helperVersion, helperRelease.latest) < 0
  const closeRef = useRef<HTMLButtonElement>(null)
  const { send, isConnected, lastMessage } = useHelperConnection()
  // Recovery feedback is driven by helper's actual `reset_discovery_result`
  // (NOT optimistic): a re-bind failure must NOT read as success, or the user
  // is told they recovered while still stuck. idle → pending → ok | fail.
  const [resetState, setResetState] =
    useState<'idle' | 'pending' | 'ok' | 'fail'>('idle')
  const handleResetDiscovery = () => {
    setResetState('pending')
    send({ type: 'reset_discovery', payload: {} })
  }
  // Resolve on the helper's result.
  useEffect(() => {
    if (!lastMessage || lastMessage.type !== 'reset_discovery_result') return
    const ok = (lastMessage.payload as { ok?: boolean }).ok !== false
    setResetState(ok ? 'ok' : 'fail')
    const t = setTimeout(() => setResetState('idle'), ok ? 2500 : 6000)
    return () => clearTimeout(t)
  }, [lastMessage])
  // Safety: if no result ever comes back (helper wedged / WS dropped mid-call),
  // don't leave the button stuck on "再初期化中…".
  useEffect(() => {
    if (resetState !== 'pending') return
    const t = setTimeout(() => setResetState('idle'), 8000)
    return () => clearTimeout(t)
  }, [resetState])

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
        aria-label={t('helper.modal.aria')}
      >
        <div className="helper-modal-header">
          <span className="helper-modal-title">
            <span className={`helper-modal-dot ${outdated ? 'outdated' : 'connected'}`} />
            {outdated
              ? t('helper.modal.outdated', { version: helperVersion ? ` (v${helperVersion} → v${MIN_HELPER_VERSION}+)` : '' })
              : t('helper.modal.connected', { version: helperVersion ? ` (v${helperVersion})` : '' })}
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

        <div className="helper-modal-body">
          {outdated && (
            <section className="helper-modal-section helper-modal-section--warning">
              <h3 className="helper-modal-section-title">{t('helper.modal.required.title')}</h3>
              <p className="helper-modal-section-desc">
                {t('helper.modal.required.desc', { current: helperVersion ?? '?', minimum: MIN_HELPER_VERSION })}
              </p>
              <p className="helper-modal-section-desc">
                <strong>{t('helper.modal.stopDaemon')}</strong>
              </p>
              <CopyableCommand cmd="hapbeat-helper stop" />
              <p className="helper-modal-section-desc">
                <strong>{t('helper.modal.upgrade')}</strong>
              </p>
              <CopyableCommand cmd="pipx upgrade hapbeat-helper" />
              <p className="helper-modal-section-desc">
                <strong>{t('helper.modal.restart')}</strong> {t('helper.modal.restart.detail')}
              </p>
              <CopyableCommand cmd="hapbeat-helper start" />
              <p className="helper-modal-section-desc">
                {t('helper.modal.required.finish')}
              </p>
            </section>
          )}

          {updateAvailable && (
            <section className="helper-modal-section">
              <h3 className="helper-modal-section-title">
                {t('helper.modal.available.title', { current: helperVersion, latest: helperRelease?.latest })}
              </h3>
              <p className="helper-modal-section-desc">
                {t('helper.modal.available.desc')}
              </p>
              <CopyableCommand cmd="hapbeat-helper stop" />
              <CopyableCommand cmd={helperRelease?.upgrade ?? 'pipx upgrade hapbeat-helper'} />
              <CopyableCommand cmd="hapbeat-helper start" />
              {helperRelease?.notes && (
                <p className="helper-modal-section-desc">
                  <a href={helperRelease.notes} target="_blank" rel="noreferrer">
                    {t('helper.modal.releaseNotes')}
                  </a>
                </p>
              )}
            </section>
          )}

          {/* デバイスを見失ったときの軽量リカバリ。ターミナルでの stop/start に
              頼らず、Helper の検出層 (UDP + mDNS) だけをその場で作り直す。 */}
          <section className="helper-modal-section helper-modal-section--alt">
            <h3 className="helper-modal-section-title">{t('helper.modal.recovery.title')}</h3>
            <p className="helper-modal-section-desc">
              {t('helper.modal.recovery.desc')}
            </p>
            <button
              type="button"
              className="helper-modal-copy-btn"
              onClick={handleResetDiscovery}
              disabled={!isConnected || resetState === 'pending'}
              title={isConnected ? undefined : t('helper.modal.recovery.unavailable')}
            >
              {resetState === 'pending'
                ? t('helper.modal.recovery.pending')
                : resetState === 'ok'
                  ? t('helper.modal.recovery.ok')
                  : resetState === 'fail'
                    ? t('helper.modal.recovery.fail')
                    : t('helper.modal.recovery.action')}
            </button>
          </section>

          <p className="helper-modal-desc">
            {t('helper.modal.manage.desc')}
          </p>

          <section className="helper-modal-section">
            <h3 className="helper-modal-section-title">{t('helper.modal.temporaryStop.title')}</h3>
            <p className="helper-modal-section-desc">
              {t('helper.modal.temporaryStop.desc')}
            </p>
            <CopyableCommand cmd="hapbeat-helper stop" />
          </section>

          <section className="helper-modal-section">
            <h3 className="helper-modal-section-title">{t('helper.modal.disableAutostart.title')}</h3>
            <p className="helper-modal-section-desc">
              {t('helper.modal.disableAutostart.desc')}
            </p>
            <CopyableCommand cmd="hapbeat-helper uninstall-service" />
          </section>

          <section className="helper-modal-section helper-modal-section--alt">
            <h3 className="helper-modal-section-title">{t('helper.modal.uninstall.title')}</h3>
            <p className="helper-modal-section-desc">
              {t('helper.modal.uninstall.desc')}
            </p>
            <CopyableCommand cmd="hapbeat-helper uninstall-service" />
            <CopyableCommand cmd="pipx uninstall hapbeat-helper" />
          </section>

          {/* Studio バージョン表示 + ロールバック用の版切替 (versions.json) */}
          <section className="helper-modal-section">
            <h3 className="helper-modal-section-title">{t('common.version')}</h3>
            <p className="helper-modal-section-desc">
              {t('helper.modal.version.desc')}
            </p>
            <VersionSwitcher />
          </section>

          {/* Studio build metadata — for debugging / bug reports.
              目立たない位置 (modal フッター) に配置。 */}
          <p className="helper-modal-build-meta">
            Studio build: <code>{import.meta.env.VITE_BUILD_SHA}</code>
            {' · '}
            <code>{(import.meta.env.VITE_BUILD_DATE ?? '').replace(/\.\d+Z$/, 'Z')}</code>
          </p>
        </div>
      </div>
    </div>,
    document.body,
  )
}
