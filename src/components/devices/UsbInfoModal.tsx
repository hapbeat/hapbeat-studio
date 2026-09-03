import { useEffect } from 'react'
import { useI18n } from '@/i18n/I18nProvider'

export interface UsbInfoModalProps {
  onClose: () => void
}

/**
 * "USB カードの見方" modal — the legend that used to sit inline under the
 * cards (poor visibility) / then as a popover (pushed cards down). Now a
 * proper modal opened by the ⓘ button, styled like the other info modals
 * (same chrome as ClipModeInfoModal). Content only — no state.
 *
 * Keep the chip labels/symbols in sync with UsbPortCard (☑ checkbox = flash
 * target, ⚙ 設定 = config-connect, ↻ 識別 = probe, ✕ = close card).
 */
export function UsbInfoModal({ onClose }: UsbInfoModalProps) {
  const { t } = useI18n()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="usb-info-backdrop" onClick={onClose}>
      <div className="usb-info-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={t('usb.info.aria')}>
        <div className="usb-info-header">
          <h3>{t('usb.info.title')}</h3>
          <button className="usb-info-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="usb-info-body">
          <p className="usb-info-intro">
            {t('usb.info.intro')}
          </p>

          <div className="usb-info-row">
            <span className="usb-info-chip select">{t('usb.info.selectChip')}</span>
            <div>
              <b>{t('usb.info.flashLabel')}</b>{t('usb.info.flashBody')}
              <span className="usb-info-note">{t('usb.info.flashNote')}</span>
            </div>
          </div>

          <div className="usb-info-row">
            <span className="usb-info-chip conn">{t('usb.info.configChip')}</span>
            <div>
              <b>{t('usb.info.configLabel')}</b>{t('usb.info.configBody')}
            </div>
          </div>

          <div className="usb-info-row">
            <span className="usb-info-chip probe">{t('usb.info.probeChip')}</span>
            <div>
              {t('usb.info.probeBody')}
            </div>
          </div>

          <div className="usb-info-row">
            <span className="usb-info-chip close">✕</span>
            <div>
              {t('usb.info.closeBody')}
            </div>
          </div>
        </div>

        <div className="usb-info-footer">
          <button className="form-button" onClick={onClose}>{t('common.close')}</button>
        </div>
      </div>
    </div>
  )
}
