import { useEffect } from 'react'
import { useHelperConnection } from '@/hooks/useHelperConnection'
import { useToast } from '@/components/common/Toast'

/**
 * Surface helper-side failures as toasts so the user never has to
 * dig through the log drawer to discover that a write didn't land.
 *
 * Scope (intentionally narrow):
 *  - `write_result` with `success: false` → error toast with the
 *    helper's own message (which already contains the per-target
 *    "TCP 7701 connect failed → power-cycle the device" hint).
 *  - `error` push from the helper itself → error toast.
 *  - `ota_result` with `success: false` → error toast.
 *
 * Successes are intentionally NOT toasted from here — individual
 * panels (DisplayEditor / KitExportSection / FirmwareSubTab) own
 * the wording for *what* succeeded ("書き込みました" / "deploy 完了"
 * / etc). This bridge exists purely to make sure failures are never
 * silent regardless of which panel triggered them.
 *
 * Mounted once at the App root.
 */
export function HelperToastBridge() {
  const { lastMessage } = useHelperConnection()
  const { toast } = useToast()

  useEffect(() => {
    if (!lastMessage) return
    const t = lastMessage.type
    const p = (lastMessage.payload ?? {}) as Record<string, unknown>

    if (t === 'write_result') {
      // ok_count > 0 means at least one device accepted the write.
      // Helper sets success=false only when *all* targets failed.
      // Those are the ones the user definitely needs to know about.
      if (p.success === false) {
        const cmd = String(p.cmd ?? p.summary ?? 'write')
        const msg = String(p.message ?? p.error ?? 'failed')
        // Helper composes a multi-line summary + per-target detail.
        // Toast the first line (summary) + the first detail line so
        // the most useful info is visible without a giant tooltip.
        const lines = msg.split('\n').map((s) => s.trim()).filter(Boolean)
        const headline = lines[0] ?? msg
        const firstDetail = lines.find((l) => l.startsWith('✗') || l.includes(':'))
        const body = firstDetail && firstDetail !== headline
          ? `${headline} — ${firstDetail.replace(/^✗\s*/, '')}`
          : headline
        toast(`${cmd}: ${body}`, 'error')
      }
      return
    }

    if (t === 'ota_result' && p.success === false) {
      const dev = String(p.device ?? '?')
      const msg = String(p.message ?? p.error ?? 'OTA failed')
      toast(`${dev} OTA 失敗: ${msg}`, 'error')
      return
    }

    if (t === 'error') {
      const msg = String(p.message ?? 'helper error')
      toast(`Helper: ${msg}`, 'error')
      return
    }
  }, [lastMessage, toast])

  return null
}
