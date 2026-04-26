import { DeviceList } from './DeviceList'
import { DeviceDetail } from './DeviceDetail'
import './Devices.css'

/**
 * Top-level container for the Devices tab.
 *
 * Replaces the device-management half of the deprecated PySide6
 * `hapbeat-manager` (DEC-026). All commands go through the Helper
 * daemon over `ws://localhost:7703`.
 */
export function Devices() {
  return (
    <div className="devices-page">
      <DeviceList />
      <DeviceDetail />
    </div>
  )
}
