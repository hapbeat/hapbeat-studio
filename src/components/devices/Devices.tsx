import { DeviceList } from './DeviceList'
import { DeviceDetail } from './DeviceDetail'
import { MqttFlowController } from './MqttFlow'
import { OtaController } from './OtaController'
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
      {/* Page-level singleton: polls the broker + owns the flow-chart
          pop-out so it survives switching the selected device. Renders
          nothing inline. */}
      <MqttFlowController />
      {/* Page-level OTA drain: keeps each device's OTA progress/result + the
          post-reboot verify alive while you switch devices (per-device OTA). */}
      <OtaController />
    </div>
  )
}
