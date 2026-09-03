/**
 * USB-serial driver download links for non-S3 nodes.
 *
 * A missing driver can't be detected from the browser: the OS never
 * creates a COM port, so the device simply doesn't appear in the Web
 * Serial picker (indistinguishable from "not plugged in"). The best we
 * can do is point the user at the right installers when their device
 * doesn't show up. Hapbeat wearables (ESP32-S3) use native USB and
 * need no driver; only the classic-ESP32 peripherals do.
 */
import { useI18n } from '@/i18n/I18nProvider'

export function DriverHelpLinks() {
  const { t } = useI18n()
  return (
    <details className="driver-help">
      <summary>{t('driver.summary')}</summary>
      <div className="driver-help-body">
        <p>
          {t('driver.intro')}
        </p>
        <ul>
          <li>
            <a href="https://ftdichip.com/drivers/vcp-drivers/" target="_blank" rel="noreferrer">
              {t('driver.ftdi')}
            </a>
            {' '}— M5 ATOM Lite
          </li>
          <li>
            <a href="https://www.silabs.com/developer-tools/usb-to-uart-bridge-vcp-drivers" target="_blank" rel="noreferrer">
              {t('driver.cp210')}
            </a>
            {' '}— {t('driver.m5Stack')}
          </li>
          <li>
            <a href="https://docs.m5stack.com/en/download" target="_blank" rel="noreferrer">
              {t('driver.m5')}
            </a>
            {' '}— {t('driver.otherChip')}
          </li>
        </ul>
        <p className="driver-help-note">
          {t('driver.note')}
        </p>
      </div>
    </details>
  )
}
