import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { DeviceList } from './DeviceList'
import type { DeviceSelectionScope } from '@/stores/deviceStore'
import './DevicesModal.css'
import { useI18n } from '@/i18n/I18nProvider'

interface Props {
  open: boolean
  onClose: () => void
  /** Restrict the picker to Hapbeat wearables (grey + disable non-Hapbeat).
   *  Set from the UI/Display tab, where the config only applies to Hapbeat. */
  hapbeatOnly?: boolean
  selectionScope?: DeviceSelectionScope
}

/**
 * Compact device-picker modal — renders just the DeviceList sidebar
 * (no DeviceDetail) so the user can switch / dismiss / select target
 * devices from the Kit and Display tabs without losing their
 * authoring context. Full per-device config (Wi-Fi, Kit install,
 * Firmware OTA) still lives in the dedicated Devices tab; this modal
 * is intentionally narrow + just the connected cards.
 *
 * Rendered through a body-level portal so it isn't trapped in any
 * parent stacking context. The Display tab in particular has a
 * grid layout + portal-overlay regions whose stacking contexts were
 * pinning the modal underneath palette items even with
 * `position: fixed` — only `createPortal(..., document.body)`
 * reliably escapes that.
 */
export function DevicesModal({ open, onClose, hapbeatOnly, selectionScope = 'manage' }: Props) {
  const { t } = useI18n()
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return createPortal((
    <div
      className="devices-modal-backdrop"
      onClick={(e) => {
        // Close only when the backdrop itself is clicked — clicks
        // inside the panel must not bubble up to the backdrop.
        if (e.target === e.currentTarget) onClose()
      }}
      role="presentation"
    >
      <div
        className="devices-modal-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Devices"
      >
        <div className="devices-modal-header">
          <span className="devices-modal-title">Devices</span>
          <button
            type="button"
            className="devices-modal-close"
            onClick={onClose}
            aria-label={t('common.close')}
            title={`${t('common.close')} (Esc)`}
          >
            ✕
          </button>
        </div>
        <div className="devices-modal-body">
          <DeviceList hapbeatOnly={hapbeatOnly} selectionScope={selectionScope} />
        </div>
      </div>
    </div>
  ), document.body)
}
