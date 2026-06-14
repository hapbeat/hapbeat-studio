import { create } from 'zustand'

/**
 * Per-device Wi-Fi OTA state (#5). Keyed by device IP so each device's OTA
 * runs independently — you can start an OTA on device A, switch to device B,
 * and start B's OTA without waiting (the helper runs them as concurrent
 * background tasks; same-IP is still serialized there). The state lives in a
 * store (not FirmwareSubTab's local state) so it survives device/tab switches:
 * `OtaController` (mounted once at the Devices root) drains the OTA messages
 * into here regardless of which device is on screen.
 */

export interface OtaProgress {
  device: string
  phase: string
  percent: number
  message: string
}
export interface OtaResult {
  ok: boolean
  message: string
}
export interface OtaDeviceState {
  progress: OtaProgress | null
  running: boolean
  result: OtaResult | null
  stuck: boolean
  /** Expected fw version to verify after the device reboots (library source). */
  expectedFw: string | null
  /** True only after a successful ota_result — gates the post-reboot fw verify
   *  so a get_info_result that arrives BEFORE reboot (still the old fw) can't be
   *  mistaken for a verify failure. */
  verifyArmed: boolean
  /** Board flashed, applied to the board-cache on success. */
  flashedBoard: string | null
  /** Date.now() of the last progress event — drives stuck detection. */
  lastProgressAt: number
}

// Stable default reference so `byIp[ip] ?? OTA_DEFAULT` keeps referential
// equality for un-started devices (no spurious re-renders).
export const OTA_DEFAULT: OtaDeviceState = {
  progress: null,
  running: false,
  result: null,
  stuck: false,
  expectedFw: null,
  verifyArmed: false,
  flashedBoard: null,
  lastProgressAt: 0,
}

interface OtaStore {
  byIp: Record<string, OtaDeviceState>
  /** Begin an OTA for `ip`: marks running, clears prior result, seeds the
   *  begin progress + the verify/board context captured at submit time. */
  start: (ip: string, opts: { expectedFw: string | null; flashedBoard: string | null; message: string }) => void
  setProgress: (ip: string, p: OtaProgress) => void
  setResult: (ip: string, r: OtaResult) => void
  clearResult: (ip: string) => void
  clearProgress: (ip: string) => void
  setStuck: (ip: string, stuck: boolean) => void
  /** Arm the post-reboot fw verify (called on a successful ota_result). */
  armVerify: (ip: string) => void
  /** Clear the verify state after comparing (or when no longer relevant). */
  clearVerify: (ip: string) => void
  /** User-cancel a stuck OTA: release the UI (the helper session may still drain). */
  cancel: (ip: string) => void
}

function patch(
  byIp: Record<string, OtaDeviceState>,
  ip: string,
  next: Partial<OtaDeviceState>,
): Record<string, OtaDeviceState> {
  return { ...byIp, [ip]: { ...(byIp[ip] ?? OTA_DEFAULT), ...next } }
}

export const useOtaStore = create<OtaStore>((set) => ({
  byIp: {},
  start: (ip, { expectedFw, flashedBoard, message }) =>
    set((s) => ({
      byIp: patch(s.byIp, ip, {
        running: true,
        result: null,
        stuck: false,
        progress: { device: ip, phase: 'begin', percent: 0, message },
        expectedFw,
        verifyArmed: false,
        flashedBoard,
        lastProgressAt: Date.now(),
      }),
    })),
  setProgress: (ip, p) =>
    set((s) => ({ byIp: patch(s.byIp, ip, { progress: p, running: true, stuck: false, lastProgressAt: Date.now() }) })),
  setResult: (ip, r) =>
    set((s) => ({ byIp: patch(s.byIp, ip, { result: r, running: false, stuck: false }) })),
  clearResult: (ip) => set((s) => ({ byIp: patch(s.byIp, ip, { result: null }) })),
  clearProgress: (ip) => set((s) => ({ byIp: patch(s.byIp, ip, { progress: null }) })),
  setStuck: (ip, stuck) => set((s) => ({ byIp: patch(s.byIp, ip, { stuck }) })),
  armVerify: (ip) => set((s) => ({ byIp: patch(s.byIp, ip, { verifyArmed: true }) })),
  clearVerify: (ip) => set((s) => ({ byIp: patch(s.byIp, ip, { expectedFw: null, verifyArmed: false }) })),
  cancel: (ip) =>
    set((s) => ({
      byIp: patch(s.byIp, ip, {
        running: false,
        stuck: false,
        progress: null,
        expectedFw: null,
        verifyArmed: false,
        result: {
          ok: false,
          message:
            'ユーザーによりキャンセルされました。デバイス側で書込が完了している可能性は'
            + '残るため、再起動後に fw バージョンを確認してください。',
        },
      }),
    })),
}))
