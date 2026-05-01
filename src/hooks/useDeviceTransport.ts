import { useCallback } from 'react'
import { useHelperConnection } from '@/hooks/useHelperConnection'
import { useSerialMaster } from '@/stores/serialMaster'
import type { ManagerMessage } from '@/types/manager'

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
  const { send: helperSend, lastMessage } = useHelperConnection()
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
    // Note: callers that watch `lastMessage` for a write_result
    // toast won't see one on the Serial path — the response is
    // returned synchronously from `sendConfigCmd`. Forms that need
    // synchronous status can read the resolved promise; existing
    // forms that are eventually-consistent (refresh-from-store) are
    // already covered because master.refreshAll() triggers a state
    // update.
    void r
  }, [isSerial, selectedIp, helperSend, masterSendConfigCmd])

  return { sendTo, isSerial, lastMessage }
}
