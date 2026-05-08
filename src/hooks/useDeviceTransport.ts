import { useCallback } from 'react'
import { useHelperConnection } from '@/hooks/useHelperConnection'
import { useSerialMaster } from '@/stores/serialMaster'
import type { ManagerMessage } from '@/types/manager'

/**
 * Maps a firmware GET-style cmd name onto the helper-relayed `*_result`
 * event type that Studio's deviceStore drains. When the Serial transport
 * receives a firmware response, we wrap it in this event shape and
 * inject it into the helper-connection `lastMessage` channel so the
 * existing `setDebugDump` / `setInfo` / etc. handlers fire without a
 * second wiring path.
 *
 * Set-style cmds (`set_*`) are intentionally absent — those are
 * eventually-consistent through `serialMaster.refreshAll()` and don't
 * have a `*_result` shape on the LAN side either (they go through the
 * generic `write_result` envelope, which only helper produces).
 */
const SERIAL_GET_CMD_TO_RESULT: Record<string, string> = {
  get_info: 'get_info_result',
  get_debug_dump: 'debug_dump_result',
  get_oled_brightness: 'oled_brightness_result',
  get_wifi_status: 'wifi_status_result',
  list_wifi_profiles: 'wifi_profiles_result',
  get_ap_status: 'ap_status_result',
  kit_list: 'kit_list_result',
}

/**
 * Transport-agnostic `sendTo` for a per-device pane.
 *
 * The Devices tab has two completely different wire formats:
 *
 *   - **LAN devices** (`ipAddress` is an IPv4 string) — go through
 *     Helper's WebSocket. The form components ship a
 *     `ManagerMessage` and Helper relays it as a TCP 7701 JSON
 *     command to the device's IP.
 *
 *   - **Serial pseudo-devices** (`ipAddress` starts with `serial:`)
 *     — go through `serialMaster.sendConfigCmd()`. The same wire
 *     command names (`set_name`, `set_wifi`, `set_group`, …) work
 *     because the firmware's serial-config and TCP-config handlers
 *     parse the same JSON shape.
 *
 * This hook gives any form a single `sendTo(msg)` callable that
 * picks the right transport based on the IP prefix. The form
 * doesn't need to know whether it's talking over WS or USB Serial.
 *
 * Forms that depend on the asynchronous `lastMessage` push from
 * Helper (e.g. `write_result` toast) still see a synthetic message
 * on the Serial path: the master's response is wrapped into a
 * `write_result` event so existing handlers Just Work.
 */
export function useDeviceTransport(selectedIp: string | null) {
  const { send: helperSend, lastMessage, injectMessage } = useHelperConnection()
  const masterSendConfigCmd = useSerialMaster((s) => s.sendConfigCmd)

  const isSerial = !!selectedIp && selectedIp.startsWith('serial:')

  const sendTo = useCallback(async (msg: ManagerMessage) => {
    if (!isSerial) {
      // LAN path — original behavior.
      helperSend({
        type: msg.type,
        payload: { ...msg.payload, ip: selectedIp },
      })
      return
    }
    // Serial path — translate {type, payload} into firmware's
    // serial-config JSON: {cmd: <type>, ...payload}.
    const cmd: Record<string, unknown> = {
      cmd: msg.type,
      ...(msg.payload as Record<string, unknown>),
    }
    // Strip `ip` (helper-side routing field, not a firmware field).
    delete cmd.ip
    delete cmd.targets
    const r = await masterSendConfigCmd(cmd)

    // For GET-style cmds, repackage the firmware response into the
    // helper-relayed `*_result` event shape and inject it into the
    // `lastMessage` channel. DeviceDetail's existing message-router
    // (`setDebugDump`, `setInfo`, …) keys on `payload.device` so we
    // stamp the serial pseudo-IP there. Without this, the Serial
    // transport silently dropped responses (e.g. get_debug_dump
    // never populated `debugDumpCache`, leaving the UI blank).
    if (r && selectedIp) {
      const resultType = SERIAL_GET_CMD_TO_RESULT[msg.type]
      if (resultType) {
        injectMessage({
          type: resultType,
          payload: {
            device: selectedIp,
            ...(r as Record<string, unknown>),
          },
        })
      }
    }
  }, [isSerial, selectedIp, helperSend, masterSendConfigCmd, injectMessage])

  return { sendTo, isSerial, lastMessage }
}
