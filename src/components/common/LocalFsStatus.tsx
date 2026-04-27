import { useEffect, useState } from 'react'
import { useLibraryStore } from '@/stores/libraryStore'
import './LocalFsStatus.css'

/**
 * Footer pill showing the global "is Studio writing to your local
 * file system right now" state. Driven by `libraryStore.localFsStatus`
 * which every write path updates.
 *
 * When the status has been `saved` for more than ~6 s with no further
 * activity, the pill fades out so it doesn't clutter the chrome.
 * Errors stay visible until the next successful write supersedes them.
 */
export function LocalFsStatus() {
  const status = useLibraryStore((s) => s.localFsStatus)
  const msg = useLibraryStore((s) => s.localFsLastMsg)
  const ts = useLibraryStore((s) => s.localFsLastTs)

  // Auto-fade saved-state after a few seconds of inactivity.
  const [faded, setFaded] = useState(false)
  useEffect(() => {
    setFaded(false)
    if (status !== 'saved') return
    const t = window.setTimeout(() => setFaded(true), 6000)
    return () => window.clearTimeout(t)
  }, [status, ts])

  if (status === 'idle') return null
  // Once saved + faded, we keep the element mounted but visually
  // muted so the user can still hover to see what happened.
  return (
    <div className={`localfs-status ${status} ${faded ? 'faded' : ''}`}
      title={msg || status}>
      <span className="localfs-status-dot" aria-hidden="true" />
      <span className="localfs-status-label">
        {status === 'saving' && '保存中…'}
        {status === 'saved' && '✓ 保存済み'}
        {status === 'retrying' && '⟳ リトライ中'}
        {status === 'error' && '✗ 保存失敗'}
      </span>
      {msg && <span className="localfs-status-msg">{msg}</span>}
    </div>
  )
}
