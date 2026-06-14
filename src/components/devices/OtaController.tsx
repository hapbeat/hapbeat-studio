import { useEffect, useRef } from 'react'
import { useHelperConnection } from '@/hooks/useHelperConnection'
import { useLogStore } from '@/stores/logStore'
import { useDeviceStore } from '@/stores/deviceStore'
import { useOtaStore } from '@/stores/otaStore'

/**
 * Persistent OTA message drain (#5). Mounted once at the Devices root so it
 * keeps processing ota_progress / ota_result / the post-OTA verify get_info for
 * EVERY device — even ones whose Firmware tab isn't on screen. FirmwareSubTab
 * only reads/writes the per-IP slice in otaStore; this owns the side effects
 * (board-cache invalidation, the 8 s reboot verify, stuck detection) so they
 * survive device/tab switches. Renders nothing.
 *
 * This is what makes OTA per-device independent: start A, switch to B, start B
 * — both stream concurrently (helper background tasks) and each device's
 * progress/result lands in its own slice regardless of what's on screen.
 */
export function OtaController() {
  const { lastMessage, send } = useHelperConnection()
  const pushLog = useLogStore((s) => s.push)
  const invalidateBoard = useDeviceStore((s) => s.invalidateBoard)
  const setLastFlashedBoard = useDeviceStore((s) => s.setLastFlashedBoard)
  const setProgress = useOtaStore((s) => s.setProgress)
  const setResult = useOtaStore((s) => s.setResult)
  const clearProgress = useOtaStore((s) => s.clearProgress)
  const armVerify = useOtaStore((s) => s.armVerify)
  const clearVerify = useOtaStore((s) => s.clearVerify)
  const setStuck = useOtaStore((s) => s.setStuck)

  const sendRef = useRef(send)
  sendRef.current = send

  // Per-IP deferred timers (3 s progress-clear, 8 s reboot verify). Tracked so
  // a new run for the same ip cancels a stale timer — without this, a re-OTA
  // within 3 s of a result would have the old timer wipe the new run's
  // progress — and so they're all cleared on unmount.
  const timersRef = useRef<Record<string, { prog?: number; verify?: number }>>({})
  const clearTimer = (ip: string, kind: 'prog' | 'verify') => {
    const id = timersRef.current[ip]?.[kind]
    if (id != null) {
      window.clearTimeout(id)
      timersRef.current[ip] = { ...timersRef.current[ip], [kind]: undefined }
    }
  }
  const setTimer = (ip: string, kind: 'prog' | 'verify', fn: () => void, ms: number) => {
    clearTimer(ip, kind)
    const id = window.setTimeout(fn, ms)
    timersRef.current[ip] = { ...timersRef.current[ip], [kind]: id }
  }

  // Drain the OTA-related messages into the per-IP store + run side effects.
  useEffect(() => {
    if (!lastMessage) return
    const t = lastMessage.type
    const p = lastMessage.payload as Record<string, unknown>

    if (t === 'ota_progress' && typeof p.device === 'string') {
      // A live run cancels any pending progress-clear from a previous result.
      clearTimer(p.device, 'prog')
      setProgress(p.device, {
        device: p.device,
        phase: String(p.phase ?? ''),
        percent: Number(p.percent ?? 0),
        message: String(p.message ?? ''),
      })
    } else if (t === 'ota_result' && typeof p.device === 'string') {
      const ip = p.device
      const ok = p.success === true
      setResult(ip, { ok, message: String(p.message ?? '') })
      setTimer(ip, 'prog', () => clearProgress(ip), 3000)
      // Read the context captured at submit time (board / expected fw).
      const st = useOtaStore.getState().byIp[ip]
      if (ok) {
        invalidateBoard(ip)
        if (st?.flashedBoard) setLastFlashedBoard(ip, st.flashedBoard)
        if (st?.expectedFw) {
          // Arm the verify ONLY now (post-success) — a get_info that arrives
          // before the reboot still has the old fw and must not be compared.
          armVerify(ip)
          pushLog('ota', `verify scheduled in 8 s (expected fw=${st.expectedFw}, ${ip})`)
          setTimer(ip, 'verify', () => sendRef.current({ type: 'get_info', payload: { ip } }), 8000)
        }
      }
    } else if (t === 'get_info_result' && typeof p.device === 'string') {
      const ip = p.device
      const st = useOtaStore.getState().byIp[ip]
      if (!st?.verifyArmed || !st.expectedFw) return   // not an armed post-reboot verify
      const deviceFw = (p.fw as string | undefined) ?? ''
      if (!deviceFw) {
        pushLog('ota', `verify skipped (${ip}) — get_info had no fw`)
      } else if (deviceFw !== st.expectedFw) {
        setResult(ip, {
          ok: false,
          message:
            `OTA は完了したが、再起動後のファームウェアバージョンが一致しません`
            + ` (期待 ${st.expectedFw}, 実際 ${deviceFw})。`
            + ` otadata の切替に失敗している可能性があります — `
            + `デバイスを電源 OFF/ON してから再度 OTA を試してください。`,
        })
        pushLog('ota', `verify FAILED (${ip}) — expected=${st.expectedFw} got=${deviceFw}`)
      } else {
        pushLog('ota', `verify OK (${ip}) — fw=${deviceFw}`)
      }
      clearVerify(ip)
      clearTimer(ip, 'verify')   // the verify fired (or arrived early) — drop the timer
    }
  }, [lastMessage, setProgress, setResult, clearProgress, armVerify, clearVerify,
      invalidateBoard, setLastFlashedBoard, pushLog])

  // Cancel all pending deferred timers on unmount (page-level, so this is rare
  // — but it keeps StrictMode dev double-mount and teardown clean).
  useEffect(() => {
    const timers = timersRef.current
    return () => {
      for (const t of Object.values(timers)) {
        if (t.prog != null) window.clearTimeout(t.prog)
        if (t.verify != null) window.clearTimeout(t.verify)
      }
    }
  }, [])

  // Stuck detection across all running devices: no progress for ≥3 s → stuck.
  useEffect(() => {
    const id = window.setInterval(() => {
      const now = Date.now()
      const { byIp } = useOtaStore.getState()
      for (const [ip, st] of Object.entries(byIp)) {
        if (st.running && !st.stuck && st.lastProgressAt > 0 && now - st.lastProgressAt >= 3000) {
          setStuck(ip, true)
        }
      }
    }, 500)
    return () => window.clearInterval(id)
  }, [setStuck])

  return null
}
