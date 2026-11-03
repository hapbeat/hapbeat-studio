/**
 * "A new Studio is deployed" for a page that stays open (the Windows app above all:
 * it loads the latest Studio at launch, but a window left open for days would not
 * see a deploy until it is reloaded).
 *
 * The build writes `build.json` ({ sha, date, version }, vite.config.ts) next to
 * index.html. A page on the latest deploy (base "/") fetches it now and then and
 * offers a reload when the sha differs from the one it runs. It never reloads by
 * itself: unsaved edits and running device operations are the user's to finish.
 * Frozen /vX.Y/ pages and the dev server never ask.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

const CHECK_EVERY_MS = 15 * 60_000
/** On window focus / tab shown, check again only if the last check is older than this. */
const RECHECK_ON_FOCUS_MS = 5 * 60_000

/** True when `latestSha` (deployed) is a real build id different from the running one. */
export function isNewerBuild(runningSha: string | undefined, latestSha: unknown): boolean {
  if (typeof latestSha !== 'string' || latestSha === '' || latestSha === 'unknown') return false
  if (!runningSha || runningSha === 'unknown') return false
  return latestSha !== runningSha
}

export function useStudioUpdate(): { available: boolean; reload: () => void; dismiss: () => void } {
  const [latestSha, setLatestSha] = useState<string | null>(null)
  const [dismissedSha, setDismissedSha] = useState<string | null>(null)
  const lastCheck = useRef(0)
  const running = import.meta.env.VITE_BUILD_SHA as string | undefined
  const enabled = !import.meta.env.DEV && import.meta.env.BASE_URL === '/'

  const check = useCallback(async () => {
    lastCheck.current = Date.now()
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}build.json`, { cache: 'no-store' })
      if (!res.ok) return
      const info = (await res.json()) as { sha?: unknown }
      if (isNewerBuild(running, info.sha)) setLatestSha(info.sha as string)
    } catch {
      /* offline or not deployed: nothing to say */
    }
  }, [running])

  useEffect(() => {
    if (!enabled) return
    lastCheck.current = Date.now() // the page itself was just loaded from the latest deploy
    const timer = window.setInterval(() => void check(), CHECK_EVERY_MS)
    const onFocus = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastCheck.current > RECHECK_ON_FOCUS_MS) void check()
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
    }
  }, [enabled, check])

  return {
    available: latestSha !== null && latestSha !== dismissedSha,
    reload: () => window.location.reload(),
    dismiss: () => setDismissedSha(latestSha),
  }
}
