import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useI18n } from '@/i18n/I18nProvider'
import { STREAM_V2_MIN_VERSIONS, STREAM_V2_UNSUPPORTED_SDKS } from '@/utils/streamV2Compat'
import '@/components/common/ConfirmDialog.css'

const FIRMWARE_CHANGELOG_URL = {
  ja: 'https://devtools.hapbeat.com/docs/hardware/device-firmware/changelog/',
  en: 'https://devtools.hapbeat.com/en/docs/hardware/device-firmware/changelog/',
} as const

/**
 * Information shown while a stream-v2 firmware is being written onto devices
 * that ran pre-v2 or unknown firmware. It never gates the write: the latest
 * firmware is the recommended choice, so this only tells the user which SDK
 * versions keep streamed haptics working (user 2026-10-16).
 */
export function StreamV2SdkTip({ version, onClose }: { version: string; onClose: () => void }) {
  const { t, locale } = useI18n()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Enter') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div className="confirm-dialog-backdrop" onClick={onClose}>
      <div className="confirm-dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="confirm-dialog-title">{t('firmware.sdkTipTitle')}</div>
        <div className="confirm-dialog-body">
          <p>{t('firmware.sdkTipIntro', { version })}</p>
          <ul style={{ margin: '0 0 8px', paddingLeft: 20 }}>
            {STREAM_V2_MIN_VERSIONS.map((m) => (
              <li key={m.name}>{m.name} ≥ {m.version}</li>
            ))}
          </ul>
          <p>{t('firmware.sdkTipUnsupported', { unsupported: STREAM_V2_UNSUPPORTED_SDKS.join(', ') })}</p>
          <p>{t('firmware.sdkTipFire')}</p>
          <p style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            {t('firmware.sdkTipImproved')}{' '}
            <a href={FIRMWARE_CHANGELOG_URL[locale]} target="_blank" rel="noreferrer">
              {t('firmware.sdkTipChangelog')}
            </a>
          </p>
        </div>
        <div className="confirm-dialog-actions">
          <button type="button" className="form-button" onClick={onClose}>
            {t('firmware.sdkTipClose')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
