import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { DeviceList } from './DeviceList'
import './DevicesModal.css'

interface Props {
  open: boolean
  onClose: () => void
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
export function DevicesModal({ open, onClose }: Props) {
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
            aria-label="閉じる"
            title="閉じる (Esc)"
          >
            ✕
          </button>
        </div>
        <div className="devices-modal-body">
          <DeviceList />
        </div>
      </div>
    </div>
  ), document.body)
}
