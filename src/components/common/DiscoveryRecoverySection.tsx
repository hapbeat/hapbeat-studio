import { useEffect, useState } from 'react'
import { useHelperConnection } from '@/hooks/useHelperConnection'
import { useI18n } from '@/i18n/I18nProvider'

/**
 * デバイスを見失ったときの軽量リカバリ。ターミナルでの stop/start に頼らず、
 * Helper の検出層 (UDP + mDNS) だけをその場で作り直す。Helper 管理画面と
 * デスクトップ版のアプリ画面で共用する。
 */
export function DiscoveryRecoverySection() {
  const { t } = useI18n()
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
    const timer = setTimeout(() => setResetState('idle'), ok ? 2500 : 6000)
    return () => clearTimeout(timer)
  }, [lastMessage])
  // Safety: if no result ever comes back (helper wedged / WS dropped mid-call),
  // don't leave the button stuck on "再初期化中…".
  useEffect(() => {
    if (resetState !== 'pending') return
    const timer = setTimeout(() => setResetState('idle'), 8000)
    return () => clearTimeout(timer)
  }, [resetState])

  return (
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
  )
}
