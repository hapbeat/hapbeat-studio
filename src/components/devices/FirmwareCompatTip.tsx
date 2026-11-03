import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useI18n } from '@/i18n/I18nProvider'
import type { FirmwareCompatNotice } from '@/utils/firmwareCompat'
import '@/components/common/ConfirmDialog.css'

/** Where the 0.x / 1.x combinations are explained. The table itself lives in
 *  contracts `versioning.md` §9 and is linked, never copied (§5.5). */
const FIRMWARE_CHANGELOG_URL = {
  ja: 'https://devtools.hapbeat.com/docs/hardware/device-firmware/changelog/',
  en: 'https://devtools.hapbeat.com/en/docs/hardware/device-firmware/changelog/',
} as const

/**
 * Information shown while a firmware of a different major is being written
 * (`versioning.md` §5.4). It never gates the write: the latest firmware is the
 * recommended choice (user 2026-10-16).
 */
export function FirmwareCompatTip({ notice, onClose }: { notice: FirmwareCompatNotice; onClose: () => void }) {
  const { t, locale } = useI18n()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Enter') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const gens = notice.currentStreamGens
  return createPortal(
    <div className="confirm-dialog-backdrop" onClick={onClose}>
      <div className="confirm-dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="confirm-dialog-title">{t('firmware.compatTipTitle')}</div>
        <div className="confirm-dialog-body">
          <p>
            {notice.fromMajor === null
              ? t('firmware.compatTipMajorUnknown', { to: notice.toMajor })
              : t('firmware.compatTipMajor', { to: notice.toMajor, from: notice.fromMajor })}
          </p>
          {gens && gens.length > 0 && (
            <p>{t('firmware.compatTipStreamGens', { gens: gens.map((g) => `Gen ${g}`).join(' / ') })}</p>
          )}
          <p>{t('firmware.compatTipRule')}</p>
          <p>{t('firmware.compatTipFire')}</p>
          <p style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            {t('firmware.compatTipDetails')}{' '}
            <a href={FIRMWARE_CHANGELOG_URL[locale]} target="_blank" rel="noopener noreferrer">
              {t('firmware.compatTipChangelog')}
            </a>
          </p>
        </div>
        <div className="confirm-dialog-actions">
          <button type="button" className="form-button" onClick={onClose}>
            {t('firmware.compatTipClose')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
