import { useState, type ReactNode } from 'react'
import { useHelperConnection } from '@/hooks/useHelperConnection'
import { useDeviceStore, type DeviceSelectionScope } from '@/stores/deviceStore'
import { DevicesModal } from './DevicesModal'
import { useI18n } from '@/i18n/I18nProvider'
import './DevicePill.css'

/**
 * Selected-device indicator + Devices-modal trigger.
 *
 * The pill displays the selection belonging to its own surface, NOT
 * "what's discovered on the LAN" — switching what the pill shows is
 * the user's job (via the Devices modal / tab), not auto-magic.
 *
 *   1 selected           → name only            (e.g. "2-neck")
 *   N>1 selected         → first + "+N-1"       (e.g. "1-neck +1")
 *   0 selected           → "no device" + helper-connected hint
 *
 * Shared between Kit (WorkDirBar) and Display (ControlBar) — both
 * surfaces show the same selection summary and open the same modal.
 */
interface DevicePillProps {
  hapbeatOnly?: boolean
  selectionScope: Exclude<DeviceSelectionScope, 'manage'>
  /** Surface-specific options shown under the device list in the modal (e.g. the editor's PC audio toggle). */
  modalExtra?: ReactNode
  /** Keep the pill visible while Helper is disconnected (needed when `modalExtra` must stay reachable). */
  showWhenDisconnected?: boolean
  /** UI tab: a USB-only device the write goes to while no selected Wi-Fi
   *  device is online (see usbUiTarget). Shown in place of "no device". */
  usbTargetName?: string | null
}

export function DevicePill({ hapbeatOnly, selectionScope, modalExtra, showWhenDisconnected, usbTargetName }: DevicePillProps) {
  const { t } = useI18n()
  const { isConnected: helperConnected, devices } = useHelperConnection()
  const selectedIps = useDeviceStore((s) => selectionScope === 'kit' ? s.kitSelectedIps : s.displaySelectedIps)
  const [open, setOpen] = useState(false)

  // Resolve selectedIps → DeviceInfo (skip ones that have dropped off
  // the LAN since selection). Order preserved from selectedIps so the
  // user sees the same "first" they picked, not whichever came back
  // online first.
  const selectedDevices = selectedIps
    .map((ip) => devices.find((d) => d.ipAddress === ip))
    .filter((d): d is NonNullable<typeof d> => !!d)
  // A USB target only exists while no selected device is online, so it
  // replaces the (offline) Wi-Fi pill: the pill names what a write reaches.
  const head = usbTargetName ? null : selectedDevices[0] ?? null
  const moreCount = Math.max(0, selectedDevices.length - 1)

  return (
    <>
      {head ? (
        <button
          type="button"
          className="device-pill"
          onClick={() => setOpen(true)}
          title={
            selectedDevices
              .map((d) => `${d.name || '(unnamed)'} (${d.ipAddress})${d.online ? '' : ' [offline]'}`)
              .join('\n') + `\n\n${t('device.pill.open')}`
          }
        >
          <span
            className={`device-pill-dot ${head.online ? 'online' : 'offline'}`}
            aria-hidden="true"
          />
          <span className="device-pill-name">
            {head.name || '(unnamed)'}
          </span>
          {moreCount > 0 && (
            <span className="device-pill-more">+{moreCount}</span>
          )}
        </button>
      ) : usbTargetName ? (
        <button
          type="button"
          className="device-pill"
          onClick={() => setOpen(true)}
          title={`${usbTargetName} (USB)\n\n${t('device.pill.open')}`}
        >
          <span className="device-pill-dot online" aria-hidden="true" />
          <span className="device-pill-name">{usbTargetName}</span>
          <span className="device-pill-more">USB</span>
        </button>
      ) : helperConnected || showWhenDisconnected ? (
        <button
          type="button"
          className="device-pill muted"
          onClick={() => setOpen(true)}
          title={t('device.pill.open')}
        >
          <span className="device-pill-dot offline" aria-hidden="true" />
          no device
        </button>
      ) : null}
      {/* "Devices ▸" 個別ボタンは header の Devices タブと冗長なので削除済み。
          pill 自体クリックでモーダルを開く。 */}
      <DevicesModal open={open} onClose={() => setOpen(false)} hapbeatOnly={hapbeatOnly} selectionScope={selectionScope} extra={modalExtra} />
    </>
  )
}
